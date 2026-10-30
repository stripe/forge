import { hasWebSearch } from '../../setup/forgeWebSearch.ts';
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentRuntimeRequirements,
  AgentSession,
  AgentTurn,
} from '../../contracts/agent.ts';
import {
  type CredentialReference,
  credentialReference,
} from '../../contracts/credentials.ts';
import { FORGE_CLAUDE_CODE_VERSION } from '../../runtime/docker/assets.ts';
import { createAgentModelProbe } from '../../validation/agentProbe.ts';
import { FORGE_VERSION } from '../../version.ts';
import {
  createInvocationCapture,
  runCapturedAgentCommand,
} from '../invocationDiagnostics.ts';
import { summarizeNativeStreamLine } from '../streamDiagnostics.ts';
import { loadClaudeEvidence, loadClaudeNativeArtifact } from './evidence.ts';
import {
  assertClaudeRuntimeLayout,
  type ClaudeCodeLayout,
  claudeProjectDirectory,
  resolveClaudeCodeLayout,
  usesDefaultClaudeCodeLayout,
} from './layout.ts';
import { createClaudePluginInstaller } from './plugins.ts';
import { isSafeSessionId, parseClaudeStream } from './stream.ts';

export const CLAUDE_PROJECTS_STATE_ID = 'claude-projects' as const;

export interface ClaudeCodeAdapterOptions {
  readonly id?: string;
  readonly provider?: string;
  readonly executable?: string;
  readonly expectedVersion?: string;
  /** Explicit run-owned paths, matching the selected runtime's pinned layout. */
  readonly layout?: ClaudeCodeLayout;
  /** Optional credential-free HTTP(S) endpoint for Anthropic-compatible APIs. */
  readonly baseUrl?: string;
  readonly credential?: string | CredentialReference;
  readonly credentialEnvironmentName?: string;
  readonly disallowedTools?: readonly string[];
  readonly sessionIdFactory?: () => string;
}

const MAX_BASE_URL_BYTES = 4_096;

/** Claude Code integration for Anthropic and compatible HTTP(S) endpoints. */
export function createClaudeCodeAdapter(
  options: ClaudeCodeAdapterOptions = {},
): AgentAdapter {
  const id = options.id ?? 'claude-code';
  const provider = options.provider ?? 'anthropic';
  const executable = options.executable ?? 'claude';
  const expectedVersion = options.expectedVersion ?? FORGE_CLAUDE_CODE_VERSION;
  const baseUrl =
    options.baseUrl === undefined
      ? undefined
      : validateBaseUrl(options.baseUrl);
  const layout = resolveClaudeCodeLayout(options.layout);
  const credential =
    typeof options.credential === 'string'
      ? credentialReference(options.credential)
      : (options.credential ?? credentialReference('anthropic.api-key'));
  const credentialEnvironmentName =
    options.credentialEnvironmentName ?? 'ANTHROPIC_API_KEY';
  const disallowedTools = [...(options.disallowedTools ?? [])];
  const sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  const pluginInstaller = createClaudePluginInstaller({
    adapterId: id,
    executable,
    layout,
  });
  const variables = {
    ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
    ...(layout.configDirectory === `${layout.home}/.claude`
      ? {}
      : { CLAUDE_CONFIG_DIR: layout.configDirectory }),
  };

  if (!id || !provider || !executable || !expectedVersion) {
    throw new TypeError(
      'Claude adapter identifiers and versions must be non-empty.',
    );
  }
  if (
    baseUrl !== undefined &&
    credentialEnvironmentName === 'ANTHROPIC_BASE_URL'
  ) {
    throw new TypeError(
      'Claude base URL and credential must use different environment variables.',
    );
  }
  if (credentialEnvironmentName === 'CLAUDE_CONFIG_DIR') {
    throw new TypeError(
      'Claude configuration directory cannot be supplied as a credential.',
    );
  }
  const requirements = (selection: {
    adapter: string;
    provider: string;
    hook_trust?: string;
    disable_experimental_betas?: true;
    model_profile?: unknown;
  }): AgentRuntimeRequirements => {
    if (selection.model_profile !== undefined) {
      throw new TypeError('model_profile is not supported by Claude Code.');
    }
    if (selection.hook_trust !== undefined) {
      throw new TypeError('hook_trust is not supported by Claude Code.');
    }
    if (selection.adapter !== id || selection.provider !== provider) {
      throw new TypeError(
        'Claude adapter does not match the selected adapter/provider.',
      );
    }
    return {
      executables: [executable],
      environment: {
        ...(Object.keys(variables).length === 0 &&
        !selection.disable_experimental_betas
          ? {}
          : {
              variables: {
                ...variables,
                ...(selection.disable_experimental_betas
                  ? { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' }
                  : {}),
              },
            }),
        credentials: {
          [credentialEnvironmentName]: {
            reference: credential,
          },
        },
      },
      stateDirectories: [
        {
          id: CLAUDE_PROJECTS_STATE_ID,
          containerPath: claudeProjectDirectory(layout),
        },
      ],
    };
  };

  const adapter: AgentAdapter = {
    id,
    version: FORGE_VERSION,
    metadata: Object.freeze({
      endpoint_mode: baseUrl === undefined ? 'default' : 'custom',
      layout_mode: usesDefaultClaudeCodeLayout(layout) ? 'default' : 'custom',
    }),
    pluginInstaller,
    requirements,
    probeModel(selection) {
      requirements(selection);
      return createAgentModelProbe({
        endpoint: `${(baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`,
        credential,
        model: selection.model,
        protocol: 'messages',
        bearer: credentialEnvironmentName === 'ANTHROPIC_AUTH_TOKEN',
      });
    },
    evidenceIdentity(selection) {
      requirements(selection);
      return { name: 'claude-code', version: expectedVersion };
    },
    async prepare(context) {
      requirements(context.selection);
      assertClaudeRuntimeLayout(layout, context.runtime.paths);
      const result = await context.runtime.commands.uncredentialed.run(
        [executable, '--version'],
        {
          signal: context.signal,
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      );
      if (result.exitCode !== 0 || !result.stdout.includes(expectedVersion)) {
        throw new Error(
          'Claude Code runtime version does not match the adapter pin.',
        );
      }
    },
    async openSession(context): Promise<AgentSession> {
      requirements(context.selection);
      assertClaudeRuntimeLayout(layout, context.runtime.paths);
      const initialSessionId = sessionIdFactory();
      if (!isSafeSessionId(initialSessionId)) {
        throw new TypeError(
          'Claude session ID factory returned an unsafe value.',
        );
      }
      try {
        context.diagnostics?.observeSessionId?.(initialSessionId);
      } catch {
        /* Observation cannot control execution. */
      }
      let currentSessionId: string | undefined;
      let invocationSequence = 0;
      return {
        sessionId: () => currentSessionId,
        async send(message, sendOptions): Promise<AgentTurn> {
          if (!message) throw new TypeError('Claude prompt must be non-empty.');
          const sessionArguments = currentSessionId
            ? ['--resume', currentSessionId]
            : ['--session-id', initialSessionId];
          const capture = createInvocationCapture({
            sequence: ++invocationSequence,
            resume: currentSessionId !== undefined,
            cliVersion: expectedVersion,
            isFailure: (summary) =>
              summary.event_type === 'error' || summary.status === 'failed',
            source: 'claude_stream_json',
            capture: context.diagnostics,
            summarizeLine: (line, sequence, at) =>
              summarizeNativeStreamLine(
                'claude_stream_json',
                line,
                sequence,
                at,
              ),
          });
          const turn = await runCapturedAgentCommand({
            capture,
            run: (callbacks) =>
              context.runtime.commands.agent.run(
                [
                  executable,
                  '-p',
                  message,
                  ...sessionArguments,
                  '--output-format',
                  'stream-json',
                  '--verbose',
                  '--dangerously-skip-permissions',
                  ...(disallowedTools.length === 0 && !hasWebSearch(context.plan)
                    ? []
                    : ['--disallowedTools', [...disallowedTools, ...(hasWebSearch(context.plan) ? ['WebSearch'] : [])].join(',')]),
                  '--model',
                  context.selection.model,
                ],
                {
                  ...callbacks,
                  cwd: '.',
                  signal: sendOptions.signal,
                  timeoutMs: context.plan.limits.run_timeout_ms,
                  maxOutputBytes: 16 * 1024 * 1024,
                },
              ),
            parse(result) {
              if (
                result.exitCode !== 0 &&
                !result.stdout.includes('"type":"result"')
              ) {
                throw new Error(
                  `Claude Code exited with status ${result.exitCode} without a completed result event.`,
                );
              }
              return parseClaudeStream(result.stdout);
            },
          });
          currentSessionId = turn.sessionId;
          return turn;
        },
      };
    },
    collectEvidence(context) {
      assertClaudeRuntimeLayout(layout, context.runtime.paths);
      return loadClaudeEvidence({
        project: context.runtime.stateDirectories.get(CLAUDE_PROJECTS_STATE_ID),
        sessionId: context.sessionId,
        agentVersion: expectedVersion,
        model: context.selection.model,
        signal: context.signal,
      });
    },
    collectNativeArtifact(context) {
      assertClaudeRuntimeLayout(layout, context.runtime.paths);
      return loadClaudeNativeArtifact({
        project: context.runtime.stateDirectories.get(CLAUDE_PROJECTS_STATE_ID),
        sessionId: context.sessionId,
        signal: context.signal,
        onNativeArtifactUnavailable: context.onNativeArtifactUnavailable,
      });
    },
  };
  return Object.freeze(adapter);
}

function validateBaseUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_BASE_URL_BYTES ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new TypeError('Claude baseUrl must be a bounded HTTP(S) URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError('Claude baseUrl must be a valid HTTP(S) URL.', {
      cause: error,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Claude baseUrl must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(
      'Claude baseUrl must not contain credentials, a query, or a fragment.',
    );
  }
  return value;
}

export { loadClaudeEvidence } from './evidence.ts';
export type { ClaudeCodeLayout } from './layout.ts';
export {
  CLAUDE_PLUGIN_STATE_ID,
  CLAUDE_PLUGIN_STATE_PATH,
} from './plugins.ts';
export { ClaudeStreamError, parseClaudeStream } from './stream.ts';
