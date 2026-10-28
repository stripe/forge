import type {
  AgentAdapter,
  AgentRuntimeRequirements,
  AgentSession,
} from '../../contracts/agent.ts';
import {
  type CredentialReference,
  credentialReference,
} from '../../contracts/credentials.ts';
import type { AgentSelectionV1 } from '../../model/types.ts';
import { FORGE_OPENCODE_VERSION } from '../../runtime/docker/assets.ts';
import { FORGE_VERSION } from '../../version.ts';
import {
  loadOpenCodeEvidence,
  loadOpenCodeNativeArtifact,
} from './evidence.ts';
import { OPENCODE_LAUNCHER } from './launcher.ts';
import {
  assertOpenCodeRuntimeLayout,
  OPENCODE_STATE_ID,
  type OpenCodeLayout,
  resolveOpenCodeLayout,
  usesDefaultOpenCodeLayout,
} from './layout.ts';
import { EXPORT_PATH, MAX_NATIVE_BYTES } from './native.ts';
import {
  mergeStripeOpenCodeConfiguration,
  PLUGIN_CONFIG_PATH,
} from './pluginConfig.ts';
import { createOpenCodePluginInstaller } from './plugins.ts';
import { parseOpenCodeStream } from './stream.ts';

export interface OpenCodeAdapterOptions {
  readonly id?: string;
  readonly executable?: string;
  readonly expectedVersion?: string;
  readonly layout?: OpenCodeLayout;
  readonly credential?: string | CredentialReference;
  /** Explicit Chat Completions API root, including /v1 when needed. Required when selected. */
  readonly baseUrl?: string;
}

/** API-key OpenCode execution inside a runtime providing Docker-equivalent isolation. */
export function createOpenCodeAdapter(
  options: OpenCodeAdapterOptions = {},
): AgentAdapter {
  const id = options.id ?? 'opencode';
  const executable = options.executable ?? 'opencode';
  const expectedVersion = options.expectedVersion ?? FORGE_OPENCODE_VERSION;
  for (const value of [id, executable, expectedVersion]) {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new TypeError(
        'OpenCode identifiers and executable must be bounded non-empty strings.',
      );
  }
  const layout = resolveOpenCodeLayout(options.layout);
  const baseUrl =
    options.baseUrl === undefined
      ? undefined
      : validateBaseUrl(options.baseUrl);
  const credential = credentialReference(
    options.credential ?? 'opencode.api-key',
  );
  const requirements = (
    selection: AgentSelectionV1,
  ): AgentRuntimeRequirements => {
    if (selection.adapter !== id || selection.provider !== 'openai-compatible')
      throw new TypeError(
        'OpenCode requires the selected adapter and openai-compatible provider.',
      );
    if (baseUrl === undefined)
      throw new TypeError(
        'OpenCode requires an explicit baseUrl (OPENCODE_BASE_URL in the CLI).',
      );
    if (!selection.model || /[\u0000-\u001f\u007f]/.test(selection.model))
      throw new TypeError('OpenCode requires an explicit model.');
    if (selection.model_profile === undefined)
      throw new TypeError('OpenCode requires an explicit model_profile.');
    const model = `forge/${selection.model}`;
    return {
      executables: [executable, 'node'],
      environment: {
        variables: {
          XDG_CONFIG_HOME: `${layout.stateDirectory}/config`,
          XDG_DATA_HOME: `${layout.stateDirectory}/data`,
          XDG_CACHE_HOME: `${layout.stateDirectory}/cache`,
          XDG_STATE_HOME: `${layout.stateDirectory}/state`,
          OPENCODE_CONFIG: `${layout.stateDirectory}/config.json`,
          OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
          OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
          OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true',
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model,
            small_model: model,
            default_agent: 'build',
            agent: { build: { model } },
            share: 'disabled',
            autoupdate: false,
            enabled_providers: ['forge'],
            permission: 'allow',
            provider: {
              forge: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Forge',
                models: {
                  [selection.model]: {
                    ...selection.model_profile,
                    tool_call: true,
                  },
                },
                env: ['OPENCODE_API_KEY'],
                options: { baseURL: baseUrl, apiKey: '{env:OPENCODE_API_KEY}' },
              },
            },
          }),
        },
        credentials: { OPENCODE_API_KEY: { reference: credential } },
      },
      stateDirectories: [
        { id: OPENCODE_STATE_ID, containerPath: layout.stateDirectory },
      ],
    };
  };
  return Object.freeze({
    id,
    version: FORGE_VERSION,
    metadata: Object.freeze({
      endpoint_mode: 'custom',
      layout_mode: usesDefaultOpenCodeLayout(layout) ? 'default' : 'custom',
    }),
    requirements,
    pluginInstaller: createOpenCodePluginInstaller({ adapterId: id, layout }),
    evidenceIdentity(selection) {
      requirements(selection);
      return { name: 'opencode', version: expectedVersion };
    },
    async prepare(context) {
      requirements(context.selection);
      assertOpenCodeRuntimeLayout(layout, context.runtime.paths);
      if (!context.runtime.stateDirectories.has(OPENCODE_STATE_ID))
        throw new TypeError('OpenCode run-owned state is unavailable.');
      const result = await context.runtime.commands.uncredentialed.run(
        [executable, '--version'],
        {
          signal: context.signal,
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      );
      context.signal.throwIfAborted();
      if (result.exitCode !== 0 || result.stdout.trim() !== expectedVersion)
        throw new Error(
          'OpenCode runtime version does not match the adapter pin.',
        );
    },
    async openSession(context): Promise<AgentSession> {
      const required = requirements(context.selection);
      assertOpenCodeRuntimeLayout(layout, context.runtime.paths);
      const state = context.runtime.stateDirectories.get(OPENCODE_STATE_ID);
      if (!state)
        throw new TypeError('OpenCode run-owned state is unavailable.');
      let config = required.environment.variables!.OPENCODE_CONFIG_CONTENT!;
      if (context.plan.setup.some((step) => step.uses === 'forge/plugin')) {
        config = mergeStripeOpenCodeConfiguration(
          config,
          new TextDecoder('utf-8', { fatal: true }).decode(
            await state.readFile(PLUGIN_CONFIG_PATH, { maxBytes: 1024 * 1024 }),
          ),
          layout.stateDirectory,
        );
      }
      context.signal.throwIfAborted();
      let currentSessionId: string | undefined;
      let sending = false;
      return {
        sessionId: () => currentSessionId,
        async send(message, { signal }) {
          signal.throwIfAborted();
          if (
            !message.trim() ||
            message.includes('\0') ||
            Buffer.byteLength(message) > 1024 * 1024
          )
            throw new TypeError(
              'OpenCode requires a bounded nonblank prompt without NUL.',
            );
          if (sending)
            throw new Error('OpenCode session cannot accept concurrent turns.');
          sending = true;
          try {
            // Invalidate before any mutation: failed export must never expose an earlier turn.
            await state.writeFile(EXPORT_PATH, new Uint8Array(), {
              mode: 0o600,
            });
            await state.writeFile('config.json', Buffer.from(config), {
              mode: 0o600,
            });
            await state.writeFile('prompt.txt', Buffer.from(message), {
              mode: 0o600,
            });
            signal.throwIfAborted();
            const result = await context.runtime.commands.agent.run(
              [
                'node',
                '-e',
                OPENCODE_LAUNCHER,
                `${layout.stateDirectory}/prompt.txt`,
                executable,
                'run',
                '--format',
                'json',
                '--agent',
                'build',
                '--model',
                `forge/${context.selection.model}`,
                '--auto',
                ...(currentSessionId === undefined
                  ? []
                  : ['--session', currentSessionId]),
              ],
              {
                cwd: '.',
                signal,
                timeoutMs: context.plan.limits.run_timeout_ms,
                maxOutputBytes: MAX_NATIVE_BYTES,
              },
            );
            signal.throwIfAborted();
            if (result.exitCode !== 0)
              throw new Error(
                'OpenCode exited without a successful completed turn.',
              );
            const turn = parseOpenCodeStream(result.stdout, currentSessionId);
            currentSessionId = turn.sessionId;
            try {
              const exported = await context.runtime.commands.agent.run(
                [executable, 'export', currentSessionId],
                {
                  cwd: '.',
                  signal,
                  timeoutMs: 30_000,
                  maxOutputBytes: MAX_NATIVE_BYTES,
                },
              );
              signal.throwIfAborted();
              if (
                exported.exitCode === 0 &&
                Buffer.byteLength(exported.stdout) <= MAX_NATIVE_BYTES
              )
                await state.writeFile(
                  EXPORT_PATH,
                  Buffer.from(exported.stdout),
                  { mode: 0o600 },
                );
            } catch {
              // Native capture is optional; cancellation is not an evidence failure.
              signal.throwIfAborted();
              await state
                .writeFile(EXPORT_PATH, new Uint8Array(), { mode: 0o600 })
                .catch(() => undefined);
            }
            signal.throwIfAborted();
            return turn;
          } finally {
            sending = false;
          }
        },
      };
    },
    collectEvidence(context) {
      assertOpenCodeRuntimeLayout(layout, context.runtime.paths);
      return loadOpenCodeEvidence({
        state: context.runtime.stateDirectories.get(OPENCODE_STATE_ID),
        sessionId: context.sessionId,
        agentVersion: expectedVersion,
        model: context.selection.model,
        signal: context.signal,
      });
    },
    collectNativeArtifact(context) {
      assertOpenCodeRuntimeLayout(layout, context.runtime.paths);
      return loadOpenCodeNativeArtifact({
        state: context.runtime.stateDirectories.get(OPENCODE_STATE_ID),
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
    value.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    throw new TypeError('OpenCode baseUrl must be a bounded HTTP(S) API root.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('OpenCode baseUrl must be a valid HTTP(S) API root.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError(
      'OpenCode baseUrl must not contain credentials, query parameters, or a fragment.',
    );
  return value;
}

export { loadOpenCodeEvidence } from './evidence.ts';
export { OPENCODE_STATE_ID, type OpenCodeLayout } from './layout.ts';
export { OpenCodeStreamError, parseOpenCodeStream } from './stream.ts';
