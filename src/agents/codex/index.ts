import type {
  AgentAdapter,
  AgentRuntimeRequirements,
  AgentSession,
} from '../../contracts/agent.ts';
import {
  assertEnvironmentName,
  type CredentialReference,
  credentialReference,
} from '../../contracts/credentials.ts';
import { FORGE_CODEX_VERSION } from '../../runtime/docker/assets.ts';
import { FORGE_VERSION } from '../../version.ts';
import { loadCodexEvidence, loadCodexNativeArtifact } from './evidence.ts';
import {
  assertCodexRuntimeLayout,
  CODEX_HOME_STATE_ID,
  type CodexLayout,
  resolveCodexLayout,
  usesDefaultCodexLayout,
} from './layout.ts';
import { prepareCodexPluginConfiguration } from './pluginConfig.ts';
import { createCodexPluginInstaller } from './plugins.ts';
import { parseCodexStream } from './stream.ts';

export { CODEX_HOME_STATE_ID } from './layout.ts';

export interface CodexAdapterOptions {
  readonly id?: string;
  readonly provider?: string;
  readonly executable?: string;
  readonly expectedVersion?: string;
  readonly layout?: CodexLayout;
  readonly credential?: string | CredentialReference;
  readonly credentialEnvironmentName?: string;
  /** API root including /v1 when required; must support the Responses API. */
  readonly baseUrl?: string;
}

/** Codex exec hosted inside an independently isolated Forge runtime. */
export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): AgentAdapter {
  const id = options.id ?? 'codex';
  const provider = options.provider ?? 'openai';
  const executable = options.executable ?? 'codex';
  const expectedVersion = options.expectedVersion ?? FORGE_CODEX_VERSION;
  for (const value of [id, provider, executable, expectedVersion]) {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new TypeError(
        'Codex identifiers and executable must be bounded non-empty strings.',
      );
    }
  }
  const layout = resolveCodexLayout(options.layout);
  const baseUrl = validateBaseUrl(
    options.baseUrl ?? 'https://api.openai.com/v1',
  );
  const credential = credentialReference(
    options.credential ?? 'openai.api-key',
  );
  const credentialEnvironmentName =
    options.credentialEnvironmentName ?? 'CODEX_API_KEY';
  assertEnvironmentName(credentialEnvironmentName);
  if (
    [
      'CODEX_HOME',
      'HOME',
      'PATH',
      'PWD',
      'TMPDIR',
      'TMP',
      'TEMP',
      'OPENAI_BASE_URL',
    ].includes(credentialEnvironmentName)
  ) {
    throw new TypeError(
      'Codex credentials must not override runtime paths or API routing.',
    );
  }
  // Explicit, non-secret command overrides select the endpoint and auth source
  // on every turn. The run-owned home must never inherit a developer login.
  const configuration = [
    'model_provider="forge"',
    'model_providers.forge.name="Forge"',
    `model_providers.forge.base_url=${JSON.stringify(baseUrl)}`,
    `model_providers.forge.env_key=${JSON.stringify(credentialEnvironmentName)}`,
    'model_providers.forge.wire_api="responses"',
    'model_providers.forge.requires_openai_auth=false',
    'cli_auth_credentials_store="ephemeral"',
    'analytics.enabled=false',
    'check_for_update_on_startup=false',
  ].flatMap((value) => ['-c', value]);
  const requirements = (selection: {
    adapter: string;
    provider: string;
    hook_trust?: string;
  }): AgentRuntimeRequirements => {
    if (selection.adapter !== id || selection.provider !== provider) {
      throw new TypeError(
        'Codex adapter does not match the selected adapter/provider.',
      );
    }
    if (
      selection.hook_trust !== undefined &&
      !['native', 'automation'].includes(selection.hook_trust)
    ) {
      throw new TypeError('Codex hook_trust must be native or automation.');
    }
    return {
      executables: [executable],
      environment: {
        variables: { CODEX_HOME: layout.configDirectory },
        credentials: { [credentialEnvironmentName]: { reference: credential } },
      },
      stateDirectories: [
        { id: CODEX_HOME_STATE_ID, containerPath: layout.configDirectory },
      ],
    };
  };
  return Object.freeze({
    id,
    version: FORGE_VERSION,
    metadata: Object.freeze({
      endpoint_mode: options.baseUrl === undefined ? 'default' : 'custom',
      layout_mode: usesDefaultCodexLayout(layout) ? 'default' : 'custom',
    }),
    pluginInstaller: createCodexPluginInstaller({
      adapterId: id,
      executable,
      layout,
    }),
    requirements,
    evidenceIdentity(selection) {
      requirements(selection);
      return { name: 'codex', version: expectedVersion };
    },
    async prepare(context) {
      requirements(context.selection);
      assertCodexRuntimeLayout(layout, context.runtime.paths);
      if (!context.runtime.stateDirectories.has(CODEX_HOME_STATE_ID)) {
        throw new TypeError('Codex run-owned state is unavailable.');
      }
      const result = await context.runtime.commands.uncredentialed.run(
        [executable, '--version'],
        {
          signal: context.signal,
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      );
      if (
        result.exitCode !== 0 ||
        result.stdout.trim() !== `codex-cli ${expectedVersion}`
      ) {
        throw new Error(
          'Codex runtime version does not match the adapter pin.',
        );
      }
    },
    async openSession(context): Promise<AgentSession> {
      requirements(context.selection);
      assertCodexRuntimeLayout(layout, context.runtime.paths);
      let currentSessionId: string | undefined;
      let sending = false;
      return {
        sessionId: () => currentSessionId,
        async send(message, sendOptions) {
          if (!message || message === '-' || message.includes('\0')) {
            throw new TypeError(
              'Codex prompt must be non-empty, contain no NUL, and not be the stdin sentinel.',
            );
          }
          if (sending)
            throw new Error('Codex session cannot accept concurrent turns.');
          sending = true;
          try {
            const home =
              context.runtime.stateDirectories.get(CODEX_HOME_STATE_ID);
            if (!home)
              throw new TypeError('Codex run-owned state is unavailable.');
            await prepareCodexPluginConfiguration(home);
            const automation = context.selection.hook_trust === 'automation';
            const result = await context.runtime.commands.agent.run(
              [
                executable,
                'exec',
                ...configuration,
                '--json',
                '--skip-git-repo-check',
                '--dangerously-bypass-approvals-and-sandbox',
                ...(automation ? ['--dangerously-bypass-hook-trust'] : []),
                '--model',
                context.selection.model,
                ...(currentSessionId === undefined
                  ? []
                  : ['resume', currentSessionId]),
                '--',
                message,
              ],
              {
                cwd: '.',
                signal: sendOptions.signal,
                timeoutMs: context.plan.limits.run_timeout_ms,
                maxOutputBytes: 16 * 1024 * 1024,
              },
            );
            if (result.exitCode !== 0)
              throw new Error(
                `Codex exited with status ${result.exitCode} without a successful completed turn.`,
              );
            const turn = parseCodexStream(result.stdout, currentSessionId, {
              hookAutomation: automation,
              workspacePath: layout.workspace,
              model: context.selection.model,
            });
            currentSessionId = turn.sessionId;
            return turn;
          } finally {
            sending = false;
          }
        },
      };
    },
    collectEvidence(context) {
      assertCodexRuntimeLayout(layout, context.runtime.paths);
      return loadCodexEvidence({
        home: context.runtime.stateDirectories.get(CODEX_HOME_STATE_ID),
        sessionId: context.sessionId,
        agentVersion: expectedVersion,
        model: context.selection.model,
        signal: context.signal,
      });
    },
    collectNativeArtifact(context) {
      assertCodexRuntimeLayout(layout, context.runtime.paths);
      return loadCodexNativeArtifact({
        home: context.runtime.stateDirectories.get(CODEX_HOME_STATE_ID),
        sessionId: context.sessionId,
        signal: context.signal,
      });
    },
  } satisfies AgentAdapter);
}

function validateBaseUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4_096 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new TypeError('Codex baseUrl must be a bounded HTTP(S) API root.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Codex baseUrl must be a valid HTTP(S) API root.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      'Codex baseUrl must not contain credentials, query parameters, or a fragment.',
    );
  }
  return value;
}

export { loadCodexEvidence } from './evidence.ts';
export type { CodexLayout } from './layout.ts';
export { CodexStreamError, parseCodexStream } from './stream.ts';
