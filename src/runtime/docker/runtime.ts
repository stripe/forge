import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandRunner } from '../../contracts/command.ts';
import {
  assertEnvironmentName,
  type CredentialScope,
  type ResolvedEnvironment,
} from '../../contracts/credentials.ts';
import type {
  HostFileImport,
  MutableWorkspace,
  PluginMcpConnections,
  PreparedRuntime,
  ReadonlyWorkspace,
  RuntimeAdapter,
  RuntimePlatform,
  RuntimePreflight,
  RuntimePreparation,
  SealedRuntime,
  WorkspaceWriteOptions,
} from '../../contracts/runtime.ts';
import {
  DockerProxySchema,
  dockerProxyEnvironment,
} from '../../model/dockerNetwork.ts';
import { PLUGIN_MCP_CREDENTIALS } from '../../model/pluginCredentials.ts';
import type {
  ForgeDockerRuntimeV1,
  ForgeRuntimeV1,
  PluginMcpServerId,
} from '../../model/types.ts';
import { serializeCanonicalJson } from '../../serialization.ts';
import { hashStateFile, importHostFileIntoState } from '../hostFileImport.ts';
import {
  type McpCredentialRelay,
  type McpCredentialRelayLimits,
  resolveMcpCredentialRelayLimits,
  startMcpCredentialRelay,
} from '../mcpCredentialRelay.ts';
import { mergeMcpToolCallCounts } from '../mcpToolCallCounts.ts';
import {
  createHostCommandRunner,
  type HostCommandRunner,
} from '../processCommandRunner.ts';
import { createOwnedWorkspace } from '../workspace.ts';
import {
  FORGE_CLAUDE_CODE_VERSION,
  FORGE_CODEX_VERSION,
  FORGE_OPENCODE_VERSION,
  FORGE_RUNTIME_ASSET_DIGEST,
} from './assets.ts';
import { DockerCommandController } from './commandRunner.ts';
import { resolveMcpRelayNetwork } from './mcpRelayNetwork.ts';

const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_FORGE_USER_ID = 10001;
const FORGE_GROUP_ID = 10001;
const FORGE_CONTAINER_USER = 'forge:forge';
const CONTAINER_WORKSPACE = '/workspace';
const CONTAINER_HOME = '/home/forge';
const PACKAGED_ASSET_ROOT = fileURLToPath(new URL('./assets', import.meta.url));
const EXECUTABLE_PROBE_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const requested = process.argv[2];
function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
const candidates = requested.includes('/')
  ? [path.resolve(requested)]
  : (process.env.PATH ?? '').split(':').map((directory) =>
      path.resolve(directory || process.cwd(), requested));
process.exit(candidates.some(isExecutableFile) ? 0 : 1);
`.trim();

export interface DockerRuntimeAdapterOptions {
  readonly dockerExecutable?: string;
  readonly temporaryRoot?: string;
  readonly hostCommands?: HostCommandRunner;
  readonly operationTimeoutMs?: number;
  readonly buildTimeoutMs?: number;
  readonly maximumCommandOutputBytes?: number;
  /** Explicit host HTTP transport for MCP relays; the upstream URL stays fixed. */
  readonly mcpRelayFetch?: typeof globalThis.fetch;
  readonly mcpRelayLimits?: Partial<McpCredentialRelayLimits>;
  /** Host OS used for relay routing; defaults to the current process platform. */
  readonly hostPlatform?: NodeJS.Platform;
}

export interface ValidateDockerRuntimeHostOptions {
  readonly dockerExecutable?: string;
  readonly temporaryRoot?: string;
  readonly hostCommands?: HostCommandRunner;
  readonly buildTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly platform: RuntimePlatform;
  readonly buildNetwork?: 'host';
  readonly proxy?: ForgeDockerRuntimeV1['proxy'];
  readonly signal?: AbortSignal;
}

export interface ValidatedDockerRuntimeHost {
  readonly platform: RuntimePlatform;
  readonly imageId: string;
}

/** Build, inspect, and execute-probe the selected image without allocating a run. */
export async function validateDockerRuntimeHost(
  options: ValidateDockerRuntimeHostOptions,
): Promise<ValidatedDockerRuntimeHost> {
  const dockerExecutable = options.dockerExecutable ?? 'docker';
  if (!dockerExecutable || dockerExecutable.includes('\0')) {
    throw new TypeError('dockerExecutable must be a non-empty command path.');
  }
  if (
    options.platform !== 'linux/amd64' &&
    options.platform !== 'linux/arm64'
  ) {
    throw new TypeError('platform must be linux/amd64 or linux/arm64.');
  }
  const hostCommands = options.hostCommands ?? createHostCommandRunner();
  const signal = options.signal ?? new AbortController().signal;
  const filesystemIdentity = resolveFilesystemIdentity();
  const image = await buildForgeImage({
    buildTimeoutMs: positive(
      options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      'buildTimeoutMs',
    ),
    dockerExecutable,
    hostCommands,
    platform: options.platform,
    ...(options.buildNetwork ? { buildNetwork: options.buildNetwork } : {}),
    ...(options.proxy ? { proxy: DockerProxySchema.parse(options.proxy) } : {}),
    signal,
    temporaryRoot: path.resolve(options.temporaryRoot ?? os.tmpdir()),
    userId: filesystemIdentity.containerUserId,
  });
  const operationTimeoutMs = positive(
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    'operationTimeoutMs',
  );
  const probeName = `stripe-forge-host-probe-${randomUUID()}`;
  let probe: Awaited<ReturnType<typeof hostCommands.run>>;
  try {
    probe = await hostCommands.run(
      [
        dockerExecutable,
        'run',
        '--rm',
        '--name',
        probeName,
        '--platform',
        options.platform,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--entrypoint',
        '/bin/sh',
        image.id,
        '-c',
        'exit 0',
      ],
      {
        maxOutputBytes: 1024 * 1024,
        signal,
        timeoutMs: operationTimeoutMs,
      },
    );
  } finally {
    await bestEffortRemoveContainer(
      dockerExecutable,
      probeName,
      hostCommands,
      operationTimeoutMs,
      1024 * 1024,
    );
  }
  if (probe.exitCode !== 0) {
    throw new Error(
      'Docker could not execute the selected Forge runtime image.',
    );
  }
  return Object.freeze({ platform: options.platform, imageId: image.id });
}

/** Forge-owned, Docker CLI based runtime. It accepts no host Dockerfile. */
export function createDockerRuntimeAdapter(
  options: DockerRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const dockerExecutable = options.dockerExecutable ?? 'docker';
  if (!dockerExecutable || dockerExecutable.includes('\0')) {
    throw new TypeError('dockerExecutable must be a non-empty command path.');
  }
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  const hostCommands = options.hostCommands ?? createHostCommandRunner();
  const mcpRelayLimits = resolveMcpCredentialRelayLimits(
    options.mcpRelayLimits,
  );
  const hostPlatform = options.hostPlatform ?? process.platform;
  const operationTimeoutMs = positive(
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    'operationTimeoutMs',
  );
  const buildTimeoutMs = positive(
    options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    'buildTimeoutMs',
  );
  const maximumCommandOutputBytes = positive(
    options.maximumCommandOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES,
    'maximumCommandOutputBytes',
  );
  const filesystemIdentity = resolveFilesystemIdentity();
  const imageBuilds = new Map<string, SharedImageBuild>();

  async function imageFor(
    platform: RuntimePlatform,
    signal: AbortSignal,
    buildNetwork?: 'host',
    proxy?: ForgeDockerRuntimeV1['proxy'],
  ): Promise<BuiltForgeImage> {
    signal.throwIfAborted();
    const buildKey = JSON.stringify([platform, buildNetwork, proxy]);
    let build = imageBuilds.get(buildKey);
    if (!build) {
      const controller = new AbortController();
      const created: SharedImageBuild = {
        controller,
        waiters: 0,
        settled: false,
        promise: buildForgeImage({
          buildTimeoutMs,
          dockerExecutable,
          hostCommands,
          platform,
          ...(buildNetwork ? { buildNetwork } : {}),
          ...(proxy ? { proxy } : {}),
          signal: controller.signal,
          temporaryRoot,
          userId: filesystemIdentity.containerUserId,
        }).then(
          (image) => {
            created.settled = true;
            return image;
          },
          (error: unknown) => {
            created.settled = true;
            if (imageBuilds.get(buildKey) === created)
              imageBuilds.delete(buildKey);
            throw error;
          },
        ),
      };
      imageBuilds.set(buildKey, created);
      build = created;
    }
    const shared = build;
    shared.waiters += 1;
    let abort!: () => void;
    try {
      return await new Promise<BuiltForgeImage>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        shared.promise.then(resolve, reject);
      });
    } finally {
      signal.removeEventListener('abort', abort);
      shared.waiters -= 1;
      if (shared.waiters === 0 && !shared.settled) {
        // A run may stop waiting independently. Only the last waiter cancels
        // the shared build, and must drain its command and temporary context.
        if (imageBuilds.get(buildKey) === shared) imageBuilds.delete(buildKey);
        shared.controller.abort();
        await shared.promise.catch(() => undefined);
      }
    }
  }

  return Object.freeze({
    id: 'forge/docker',
    supportsMcpCredentialRelay: true as const,
    preflight({ plan, requirements, environment }: RuntimePreflight) {
      const runtime = validateRuntime(plan.runtime);
      assertProxyBindings(runtime.proxy, environment);
      validateExecutableRequirements(requirements.executables);
      validateStateRequirements(requirements.stateDirectories);
      validateMcpRelayRequirements(requirements.mcpRelays ?? []);
      assertRelayProxyBindings(requirements.mcpRelays ?? [], environment);
    },
    async prepare(input: RuntimePreparation): Promise<PreparedRuntime> {
      input.signal.throwIfAborted();
      const runtime = validateRuntime(input.plan.runtime);
      validateEnvironment(input.environment);
      assertProxyBindings(runtime.proxy, input.environment);
      const executableRequirements = validateExecutableRequirements(
        input.requirements.executables,
      );
      const stateRequirements = validateStateRequirements(
        input.requirements.stateDirectories,
      );
      const relayCredentials = input.mcpRelayCredentials ?? [];
      validateMcpRelayRequirements(input.requirements.mcpRelays ?? []);
      assertRelayProxyBindings(
        input.requirements.mcpRelays ?? [],
        input.environment,
      );
      if (
        JSON.stringify(relayCredentials.map(({ server }) => server).sort()) !==
          JSON.stringify([...(input.requirements.mcpRelays ?? [])].sort()) ||
        relayCredentials.some(
          ({ server, value }) =>
            !Object.hasOwn(PLUGIN_MCP_CREDENTIALS, server) ||
            !value ||
            /[\r\n]/.test(value),
        )
      )
        throw new TypeError(
          'MCP relay credentials do not match runtime requirements.',
        );
      const relayNetwork =
        relayCredentials.length === 0
          ? undefined
          : await resolveMcpRelayNetwork({
              hostPlatform,
              ...(runtime.network ? { network: runtime.network } : {}),
              dockerExecutable,
              hostCommands,
              timeoutMs: operationTimeoutMs,
              signal: input.signal,
            });
      const image = await imageFor(
        runtime.platform,
        input.signal,
        runtime.build_network,
        runtime.proxy,
      );
      input.signal.throwIfAborted();

      const runRoot = await fs.mkdtemp(
        path.join(temporaryRoot, 'stripe-forge-run-'),
      );
      const workspaceRoot = path.join(runRoot, 'workspace');
      const homeRoot = path.join(runRoot, 'home');
      const stateRoot = path.join(runRoot, 'state');
      const importRoot = path.join(runRoot, 'imports');
      const environmentFileRoot = path.join(runRoot, 'environment');
      const cidFile = path.join(runRoot, 'container-id');
      await fs.mkdir(workspaceRoot, { mode: 0o777 });
      await fs.mkdir(homeRoot, { mode: 0o777 });
      await fs.mkdir(stateRoot, { mode: 0o700 });
      await fs.mkdir(importRoot, { mode: 0o700 });
      await fs.mkdir(environmentFileRoot, { mode: 0o700 });
      // The unpredictable parent remains 0700; the Docker VM's non-root user
      // needs write access only to these two run-owned mount leaves.
      await fs.chmod(workspaceRoot, 0o777);
      await fs.chmod(homeRoot, 0o777);
      if (filesystemIdentity.hostWriteOwner !== undefined) {
        await Promise.all([
          fs.chown(
            workspaceRoot,
            filesystemIdentity.hostWriteOwner.uid,
            filesystemIdentity.hostWriteOwner.gid,
          ),
          fs.chown(
            homeRoot,
            filesystemIdentity.hostWriteOwner.uid,
            filesystemIdentity.hostWriteOwner.gid,
          ),
        ]);
      }

      let mutationOpen = true;
      const ownedWorkspace = await createOwnedWorkspace(workspaceRoot, {
        ...(filesystemIdentity.hostWriteOwner === undefined
          ? {}
          : { writeOwner: filesystemIdentity.hostWriteOwner }),
      });
      const workspace = guardedWorkspace(ownedWorkspace, () => mutationOpen);
      const sealedWorkspace = readonlyWorkspace(ownedWorkspace);
      const stateDirectories = new Map<string, MutableWorkspace>();
      const sealedStateDirectories = new Map<string, ReadonlyWorkspace>();
      const stateMounts: Array<{
        source: string;
        target: string;
        sealAfterSetup: boolean;
      }> = [];
      for (const requirement of stateRequirements) {
        if (requirement.containerPath.startsWith(`${CONTAINER_HOME}/`)) {
          // Docker otherwise creates missing nested mount targets as root in
          // the home bind mount, preventing the agent from writing settings
          // beside them and the host user from cleaning up the run.
          let target = homeRoot;
          for (const segment of requirement.containerPath
            .slice(CONTAINER_HOME.length + 1)
            .split('/')) {
            target = path.join(target, segment);
            await fs.mkdir(target, { recursive: true, mode: 0o777 });
            await fs.chmod(target, 0o777);
            if (filesystemIdentity.hostWriteOwner !== undefined) {
              await fs.chown(
                target,
                filesystemIdentity.hostWriteOwner.uid,
                filesystemIdentity.hostWriteOwner.gid,
              );
            }
          }
        }
        const source = path.join(stateRoot, requirement.id);
        await fs.mkdir(source, { mode: 0o777 });
        await fs.chmod(source, 0o777);
        if (filesystemIdentity.hostWriteOwner !== undefined) {
          await fs.chown(
            source,
            filesystemIdentity.hostWriteOwner.uid,
            filesystemIdentity.hostWriteOwner.gid,
          );
        }
        const ownedState = await createOwnedWorkspace(source, {
          ...(filesystemIdentity.hostWriteOwner === undefined
            ? {}
            : { writeOwner: filesystemIdentity.hostWriteOwner }),
        });
        stateDirectories.set(
          requirement.id,
          guardedWorkspace(
            ownedState,
            () =>
              mutationOpen && (!requirement.sealAfterSetup || !setupFinalized),
          ),
        );
        sealedStateDirectories.set(
          requirement.id,
          readonlyWorkspace(ownedState),
        );
        stateMounts.push({
          source,
          target: requirement.containerPath,
          sealAfterSetup: requirement.sealAfterSetup ?? false,
        });
      }
      const containerName = containerNameFor(input.runId);
      const relays: McpCredentialRelay[] = [];
      const pluginMcpConnections: Partial<PluginMcpConnections> = {};
      const closeRelays = async () => {
        await Promise.all(relays.map((relay) => relay.close()));
      };
      const startArgv = (sealSetupState: boolean): readonly string[] =>
        dockerRunArgv({
          cidFile,
          containerName,
          dockerExecutable,
          homeRoot,
          image: image.id,
          platform: runtime.platform,
          ...(relayNetwork?.hostMapping
            ? { hostRelayMapping: relayNetwork.hostMapping }
            : {}),
          ...(runtime.network ? { network: runtime.network } : {}),
          resources: runtime.resources,
          sealSetupState,
          stateMounts,
          workspaceRoot,
        });
      let containerExists = false;
      try {
        for (const { server, value } of relayCredentials) {
          const relay = await startMcpCredentialRelay({
            upstreamUrl: PLUGIN_MCP_CREDENTIALS[server].url,
            credential: value,
            listenHost: relayNetwork!.listenHost,
            connectHost: relayNetwork!.connectHost,
            limits: mcpRelayLimits,
            signal: input.signal,
            ...(options.mcpRelayFetch === undefined
              ? {}
              : { fetch: options.mcpRelayFetch }),
          });
          relays.push(relay);
          Object.defineProperty(pluginMcpConnections, server, {
            value: relay.connection,
            enumerable: true,
          });
        }
        Object.freeze(pluginMcpConnections);
        const started = await hostCommands.run(startArgv(false), {
          maxOutputBytes: maximumCommandOutputBytes,
          signal: input.signal,
          timeoutMs: operationTimeoutMs,
        });
        if (started.exitCode !== 0) {
          throw new Error(
            'Docker could not start the Forge runtime container.',
          );
        }
        containerExists = true;
      } catch (error) {
        await closeRelays();
        const partialContainerId = await readContainerId(cidFile);
        await bestEffortRemoveContainer(
          dockerExecutable,
          partialContainerId ?? containerName,
          hostCommands,
          operationTimeoutMs,
          maximumCommandOutputBytes,
        );
        await fs.rm(runRoot, { recursive: true, force: true });
        throw error;
      }

      const commandVariables = {
        ...dockerProxyEnvironment(runtime.proxy),
        ...input.environment.variables,
      };
      // Codex reads its relay capability from the environment; the upstream
      // key is never an environment value.
      for (const [server, connection] of Object.entries(pluginMcpConnections))
        commandVariables[
          PLUGIN_MCP_CREDENTIALS[
            server as PluginMcpServerId
          ].relayTokenEnvironmentVariable
        ] = connection.token;
      if (relays.length > 0) {
        const relayHost =
          runtime.network === 'host' ? '127.0.0.1' : 'host.docker.internal';
        for (const name of ['NO_PROXY', 'no_proxy'])
          commandVariables[name] = [commandVariables[name], relayHost]
            .filter(Boolean)
            .join(',');
      }
      const controller = new DockerCommandController({
        containerName,
        defaultTimeoutMs: Math.min(
          input.plan.limits.run_timeout_ms,
          10 * 60_000,
        ),
        dockerExecutable,
        environment: {
          variables: commandVariables,
          credentials: input.environment.credentials,
        },
        environmentFileRoot,
        hostCommands,
        maximumOutputBytes: maximumCommandOutputBytes,
        maximumTimeoutMs: input.plan.limits.run_timeout_ms,
      });
      let setupFinalized = false;
      let importsOpen = true;
      const activeImports = new Set<Promise<void>>();
      const activeImportTargets = new Set<string>();
      const importedFiles = new Map<string, HostFileImport>();
      const waitForImports = async (): Promise<void> => {
        const settled = await Promise.allSettled([...activeImports]);
        const failures = settled
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          )
          .map((result) => result.reason as unknown);
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Active host file imports failed.',
          );
        }
      };
      let sealedPromise: Promise<SealedRuntime> | undefined;
      let disposePromise: Promise<void> | undefined;

      const dispose = (): Promise<void> => {
        mutationOpen = false;
        importsOpen = false;
        disposePromise ??= (async () => {
          await closeRelays();
          // A started quiesce owns the stop barrier. Cleanup never races it.
          await sealedPromise?.catch(() => undefined);
          await waitForImports().catch(() => undefined);
          await disposeRuntime({
            containerName,
            controller,
            dockerExecutable,
            hostCommands,
            maximumCommandOutputBytes,
            operationTimeoutMs,
            runRoot,
            shouldRemoveContainer: () => containerExists,
          });
          containerExists = false;
        })();
        return disposePromise;
      };
      const uncredentialedCommands = controller.withoutCredentials();
      const sealedRuntime = (): SealedRuntime =>
        Object.freeze({
          runtimeId: input.runId,
          workspace: sealedWorkspace,
          paths: Object.freeze({
            workspace: CONTAINER_WORKSPACE,
            home: CONTAINER_HOME,
          }),
          stateDirectories: sealedStateDirectories,
          metadata: Object.freeze({
            adapter: 'forge/docker',
            claudeCodeVersion: FORGE_CLAUDE_CODE_VERSION,
            codexVersion: FORGE_CODEX_VERSION,
            opencodeVersion: FORGE_OPENCODE_VERSION,
            containerUserId: String(filesystemIdentity.containerUserId),
            imageAssetDigest: `sha256:${FORGE_RUNTIME_ASSET_DIGEST}`,
            imageId: image.id,
            imageTag: image.tag,
            platform: runtime.platform,
            network: runtime.network ?? 'default',
            buildNetwork: runtime.build_network ?? 'default',
            ...(relays.length === 0
              ? {}
              : {
                  pluginMcpLimits: serializeCanonicalJson(mcpRelayLimits),
                  pluginMcpToolCalls: serializeCanonicalJson(
                    mergeMcpToolCallCounts(
                      relays.map((relay) => relay.toolCalls()),
                    ),
                  ),
                  pluginMcpRequests: String(
                    relays.reduce(
                      (count, relay) => count + relay.counts().requests,
                      0,
                    ),
                  ),
                  pluginMcpErrors: String(
                    relays.reduce(
                      (count, relay) => count + relay.counts().errors,
                      0,
                    ),
                  ),
                }),
          }),
        });

      return Object.freeze({
        runtimeId: input.runId,
        workspace,
        paths: Object.freeze({
          workspace: CONTAINER_WORKSPACE,
          home: CONTAINER_HOME,
        }),
        stateDirectories,
        ...(relays.length === 0 ? {} : { pluginMcpConnections }),
        importHostFile(
          request: HostFileImport,
          signal?: AbortSignal,
        ): Promise<void> {
          if (
            !importsOpen ||
            !mutationOpen ||
            disposePromise ||
            sealedPromise
          ) {
            throw new Error(
              'Docker runtime host imports are no longer available.',
            );
          }
          const snapshot = Object.freeze({ ...request });
          const requirement = stateRequirements.find(
            ({ id }) => id === snapshot.stateDirectoryId,
          );
          if (!requirement) {
            throw new Error('Host import requires a declared state directory.');
          }
          if (snapshot.verifyAfterSetup && !requirement.sealAfterSetup) {
            throw new Error(
              'Post-setup host import verification requires a sealed state directory.',
            );
          }
          const key = `${requirement.id}/${snapshot.relativePath}`;
          if (importedFiles.has(key) || activeImportTargets.has(key)) {
            throw new Error('A host import already targets this state file.');
          }
          activeImportTargets.add(key);
          const importSignal =
            signal === undefined
              ? input.signal
              : AbortSignal.any([input.signal, signal]);
          const importing = (async () => {
            await importHostFileIntoState(
              path.join(stateRoot, requirement.id),
              importRoot,
              snapshot,
              importSignal,
              filesystemIdentity.hostWriteOwner,
            );
            importedFiles.set(key, snapshot);
          })();
          activeImports.add(importing);
          void importing.then(
            () => {
              activeImports.delete(importing);
              activeImportTargets.delete(key);
            },
            () => {
              activeImports.delete(importing);
              activeImportTargets.delete(key);
            },
          );
          return importing;
        },
        commands: Object.freeze({
          uncredentialed: uncredentialedCommands,
          setup: (credentialEnvironmentNames: readonly string[]) =>
            controller.forScope('setup', credentialEnvironmentNames),
          agent: controller.forScope(
            'agent',
            credentialEnvironmentNamesForScope(input.environment, 'agent'),
          ),
        }),
        async finalizeSetup(): Promise<void> {
          if (disposePromise || sealedPromise) {
            throw new Error(
              'Docker runtime cannot finalize setup after shutdown.',
            );
          }
          if (setupFinalized) {
            throw new Error('Docker runtime setup has already been finalized.');
          }
          importsOpen = false;
          await waitForImports();
          await controller.finalizeSetupAndWait();
          setupFinalized = true;
          if (stateMounts.some(({ sealAfterSetup }) => sealAfterSetup)) {
            const stopped = await hostCommands.run(
              [dockerExecutable, 'stop', '--time', '10', containerName],
              {
                maxOutputBytes: maximumCommandOutputBytes,
                timeoutMs: operationTimeoutMs,
              },
            );
            if (stopped.exitCode !== 0) {
              throw new Error(
                'Docker could not stop the Forge setup container.',
              );
            }
            const removed = await hostCommands.run(
              [dockerExecutable, 'rm', '--force', '--volumes', containerName],
              {
                maxOutputBytes: maximumCommandOutputBytes,
                timeoutMs: operationTimeoutMs,
              },
            );
            if (removed.exitCode !== 0) {
              throw new Error(
                'Docker could not replace the Forge setup container.',
              );
            }
            containerExists = false;
            for (const imported of importedFiles.values()) {
              if (!imported.verifyAfterSetup) continue;
              const digest = await hashStateFile(
                path.join(stateRoot, imported.stateDirectoryId),
                imported.relativePath,
                imported.maxBytes,
                input.signal,
              );
              if (digest !== imported.sha256) {
                throw new Error(
                  'Sealed host-imported file differs from its expected SHA-256.',
                );
              }
            }
            await fs.rm(cidFile, { force: true });
            try {
              const restarted = await hostCommands.run(startArgv(true), {
                maxOutputBytes: maximumCommandOutputBytes,
                timeoutMs: operationTimeoutMs,
              });
              if (restarted.exitCode !== 0) {
                throw new Error(
                  'Docker could not start the Forge interaction container.',
                );
              }
              containerExists = true;
            } catch (error) {
              await bestEffortRemoveContainer(
                dockerExecutable,
                containerName,
                hostCommands,
                operationTimeoutMs,
                maximumCommandOutputBytes,
              );
              throw error;
            }
          }
          await assertExecutablesAvailable(
            controller.finalizedWithoutCredentials(),
            executableRequirements,
            input.signal,
          );
        },
        quiesce(): Promise<SealedRuntime> {
          if (disposePromise) {
            return Promise.reject(
              new Error('Docker runtime is already disposing.'),
            );
          }
          mutationOpen = false;
          importsOpen = false;
          sealedPromise ??= (async () => {
            await closeRelays();
            await waitForImports();
            await controller.closeAndWait();
            const stopped = await hostCommands.run(
              [dockerExecutable, 'stop', '--time', '10', containerName],
              {
                maxOutputBytes: maximumCommandOutputBytes,
                timeoutMs: operationTimeoutMs,
              },
            );
            if (stopped.exitCode !== 0) {
              throw new Error(
                'Docker could not quiesce the Forge runtime container.',
              );
            }
            return sealedRuntime();
          })();
          return sealedPromise;
        },
        dispose,
      });
    },
  });
}

function validateMcpRelayRequirements(
  servers: readonly PluginMcpServerId[],
): void {
  if (
    !Array.isArray(servers) ||
    new Set(servers).size !== servers.length ||
    servers.some((server) => !Object.hasOwn(PLUGIN_MCP_CREDENTIALS, server))
  )
    throw new TypeError('Unsupported MCP relay requirements.');
}

function assertRelayProxyBindings(
  servers: readonly PluginMcpServerId[],
  environment: { readonly credentials?: Readonly<Record<string, unknown>> },
): void {
  if (
    servers.length > 0 &&
    ['NO_PROXY', 'no_proxy'].some((name) =>
      Object.hasOwn(environment.credentials ?? {}, name),
    )
  )
    throw new TypeError('MCP relay proxy bypass cannot be credential-backed.');
}

function credentialEnvironmentNamesForScope(
  environment: ResolvedEnvironment,
  scope: CredentialScope,
): readonly string[] {
  return Object.freeze(
    Object.entries(environment.credentials)
      .filter(([, binding]) => binding.scopes.includes(scope))
      .map(([name]) => name)
      .sort(compareCodeUnits),
  );
}

function guardedWorkspace(
  workspace: MutableWorkspace,
  canMutate: () => boolean,
): MutableWorkspace {
  return Object.freeze({
    inspect: workspace.inspect,
    readFile: workspace.readFile,
    listFiles: workspace.listFiles,
    async writeFile(
      relativePath: string,
      body: Uint8Array,
      options?: WorkspaceWriteOptions,
    ) {
      if (!canMutate()) {
        throw new Error('Runtime workspace has been quiesced.');
      }
      await workspace.writeFile(relativePath, body, options);
    },
  });
}

function readonlyWorkspace(workspace: MutableWorkspace): ReadonlyWorkspace {
  return Object.freeze({
    inspect: workspace.inspect,
    readFile: workspace.readFile,
    listFiles: workspace.listFiles,
  });
}

interface BuildForgeImageInput {
  readonly buildNetwork?: 'host';
  readonly proxy?: ForgeDockerRuntimeV1['proxy'];
  readonly buildTimeoutMs: number;
  readonly dockerExecutable: string;
  readonly hostCommands: HostCommandRunner;
  readonly platform: RuntimePlatform;
  readonly signal: AbortSignal;
  readonly temporaryRoot: string;
  readonly userId: number;
}

interface BuiltForgeImage {
  readonly tag: string;
  readonly id: string;
}

interface SharedImageBuild {
  readonly controller: AbortController;
  readonly promise: Promise<BuiltForgeImage>;
  waiters: number;
  settled: boolean;
}

async function buildForgeImage(
  input: BuildForgeImageInput,
): Promise<BuiltForgeImage> {
  const buildRoot = await fs.mkdtemp(
    path.join(input.temporaryRoot, 'stripe-forge-build-'),
  );
  const settingsSuffix =
    input.buildNetwork === undefined && input.proxy === undefined
      ? ''
      : `-${createHash('sha256')
          .update(JSON.stringify([input.buildNetwork, input.proxy]))
          .digest('hex')
          .slice(0, 16)}`;
  const image = `${imageTag(input.platform, input.userId)}${settingsSuffix}`;
  try {
    const dockerfile = await fs.readFile(
      path.join(PACKAGED_ASSET_ROOT, 'Dockerfile'),
    );
    const entrypoint = await fs.readFile(
      path.join(PACKAGED_ASSET_ROOT, 'entrypoint.sh'),
    );
    const digest = createHash('sha256')
      .update(dockerfile)
      .update('\0')
      .update(entrypoint)
      .digest('hex');
    if (digest !== FORGE_RUNTIME_ASSET_DIGEST) {
      throw new Error(
        'Packaged Forge Docker assets do not match their digest.',
      );
    }
    await fs.writeFile(path.join(buildRoot, 'Dockerfile'), dockerfile, {
      mode: 0o644,
    });
    await fs.writeFile(path.join(buildRoot, 'entrypoint.sh'), entrypoint, {
      mode: 0o755,
    });
    const built = await input.hostCommands.run(
      [
        input.dockerExecutable,
        'build',
        ...(input.buildNetwork ? ['--network', input.buildNetwork] : []),
        ...Object.entries(dockerProxyEnvironment(input.proxy)).flatMap(
          ([name, value]) => ['--build-arg', `${name}=${value}`],
        ),
        '--platform',
        input.platform,
        '--build-arg',
        `FORGE_UID=${input.userId}`,
        '--tag',
        image,
        '--file',
        path.join(buildRoot, 'Dockerfile'),
        buildRoot,
      ],
      {
        maxOutputBytes: 32 * 1024 * 1024,
        signal: input.signal,
        timeoutMs: input.buildTimeoutMs,
      },
    );
    if (built.exitCode !== 0) {
      throw new Error('Docker could not build the Forge-owned runtime image.');
    }
    const inspected = await input.hostCommands.run(
      [
        input.dockerExecutable,
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        image,
      ],
      {
        maxOutputBytes: 1024 * 1024,
        signal: input.signal,
        timeoutMs: input.buildTimeoutMs,
      },
    );
    const id = inspected.stdout.trim();
    if (inspected.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id)) {
      throw new Error('Docker did not return an immutable Forge image ID.');
    }
    return Object.freeze({ tag: image, id });
  } finally {
    await fs.rm(buildRoot, { recursive: true, force: true });
  }
}

function dockerRunArgv(input: {
  cidFile: string;
  containerName: string;
  dockerExecutable: string;
  homeRoot: string;
  image: string;
  platform: RuntimePlatform;
  network?: 'host';
  hostRelayMapping?: string;
  resources: ForgeDockerRuntimeV1['resources'];
  sealSetupState: boolean;
  stateMounts: readonly {
    source: string;
    target: string;
    sealAfterSetup: boolean;
  }[];
  workspaceRoot: string;
}): readonly string[] {
  return [
    input.dockerExecutable,
    'run',
    ...(input.network ? ['--network', input.network] : []),
    ...(input.hostRelayMapping ? ['--add-host', input.hostRelayMapping] : []),
    '--detach',
    '--name',
    input.containerName,
    '--cidfile',
    input.cidFile,
    '--platform',
    input.platform,
    '--user',
    FORGE_CONTAINER_USER,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--memory',
    String(input.resources.memory_bytes),
    '--cpus',
    String(input.resources.cpu_count),
    '--pids-limit',
    String(input.resources.process_count),
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=268435456',
    '--mount',
    mountArgument(input.workspaceRoot, '/workspace'),
    '--mount',
    mountArgument(input.homeRoot, '/home/forge'),
    ...input.stateMounts.flatMap(({ source, target, sealAfterSetup }) => [
      '--mount',
      mountArgument(source, target, input.sealSetupState && sealAfterSetup),
    ]),
    '--workdir',
    '/workspace',
    input.image,
  ];
}

async function disposeRuntime(input: {
  containerName: string;
  controller: DockerCommandController;
  dockerExecutable: string;
  hostCommands: HostCommandRunner;
  maximumCommandOutputBytes: number;
  operationTimeoutMs: number;
  runRoot: string;
  shouldRemoveContainer: () => boolean;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    await input.controller.closeAndWait();
  } catch (error) {
    failures.push(error);
  }
  if (input.shouldRemoveContainer()) {
    try {
      const removed = await input.hostCommands.run(
        [
          input.dockerExecutable,
          'rm',
          '--force',
          '--volumes',
          input.containerName,
        ],
        {
          maxOutputBytes: input.maximumCommandOutputBytes,
          timeoutMs: input.operationTimeoutMs,
        },
      );
      if (removed.exitCode !== 0) {
        failures.push(
          new Error('Docker could not remove the Forge runtime container.'),
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await fs.rm(input.runRoot, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Forge Docker runtime cleanup failed.');
  }
}

async function bestEffortRemoveContainer(
  dockerExecutable: string,
  containerName: string,
  hostCommands: HostCommandRunner,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<void> {
  await hostCommands
    .run([dockerExecutable, 'rm', '--force', '--volumes', containerName], {
      maxOutputBytes,
      timeoutMs,
    })
    .catch(() => undefined);
}

function validateRuntime(runtime: ForgeRuntimeV1): ForgeDockerRuntimeV1 {
  if (
    !('image' in runtime) ||
    runtime.adapter !== 'docker' ||
    runtime.image.kind !== 'forge' ||
    (runtime.platform !== 'linux/amd64' && runtime.platform !== 'linux/arm64')
  ) {
    throw new TypeError(
      'Forge v1 supports only its owned Docker runtime image.',
    );
  }
  if (runtime.network !== undefined && runtime.network !== 'host')
    throw new TypeError('runtime.network must be host or omitted.');
  if (runtime.build_network !== undefined && runtime.build_network !== 'host')
    throw new TypeError('runtime.build_network must be host or omitted.');
  if (runtime.proxy !== undefined) DockerProxySchema.parse(runtime.proxy);
  positive(runtime.resources.memory_bytes, 'runtime.resources.memory_bytes');
  positive(runtime.resources.cpu_count, 'runtime.resources.cpu_count');
  positive(runtime.resources.process_count, 'runtime.resources.process_count');
  return runtime;
}

function assertProxyBindings(
  proxy: ForgeDockerRuntimeV1['proxy'],
  environment: {
    readonly variables?: Readonly<Record<string, string>>;
    readonly credentials?: Readonly<Record<string, unknown>>;
  },
): void {
  for (const [name, value] of Object.entries(dockerProxyEnvironment(proxy))) {
    if (
      Object.hasOwn(environment.credentials ?? {}, name) ||
      (Object.hasOwn(environment.variables ?? {}, name) &&
        environment.variables?.[name] !== value)
    )
      throw new TypeError(
        `Runtime proxy ${name} conflicts with command environment requirements.`,
      );
  }
}

function validateEnvironment(
  environment: RuntimePreparation['environment'],
): void {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(environment.variables)) {
    assertEnvironmentName(name);
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new TypeError(`Invalid plain environment variable: ${name}`);
    }
    seen.add(name);
  }
  for (const [name, binding] of Object.entries(environment.credentials)) {
    assertEnvironmentName(name);
    if (seen.has(name)) {
      throw new TypeError(
        `Environment variable ${name} has conflicting bindings.`,
      );
    }
    if (!binding.value || binding.value.includes('\0')) {
      throw new TypeError(`Invalid credential environment variable: ${name}`);
    }
  }
}

function validateExecutableRequirements(
  requirements: RuntimePreparation['requirements']['executables'],
): readonly string[] {
  if (!Array.isArray(requirements)) {
    throw new TypeError('Runtime executable requirements must be an array.');
  }
  const seen = new Set<string>();
  const normalized = requirements.map((executable) => {
    if (
      typeof executable !== 'string' ||
      executable.length === 0 ||
      executable.length > 1_024 ||
      executable.includes('\0')
    ) {
      throw new TypeError(
        'Runtime executable requirements must be bounded non-empty strings.',
      );
    }
    if (seen.has(executable)) {
      throw new TypeError(
        `Duplicate runtime executable requirement: ${executable}`,
      );
    }
    seen.add(executable);
    return executable;
  });
  return Object.freeze(normalized);
}

async function assertExecutablesAvailable(
  commands: CommandRunner,
  requirements: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  for (const executable of requirements) {
    signal.throwIfAborted();
    const result = await commands.run(
      [
        '/usr/local/bin/node',
        '-e',
        EXECUTABLE_PROBE_SCRIPT,
        'forge-executable-check',
        executable,
      ],
      { signal, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Required runtime executable is unavailable: ${executable}`,
      );
    }
  }
}

function validateStateRequirements(
  requirements: RuntimePreparation['requirements']['stateDirectories'],
): RuntimePreparation['requirements']['stateDirectories'] {
  const ids = new Set<string>();
  const paths: string[] = [];
  for (const requirement of requirements) {
    if (
      requirement === null ||
      typeof requirement !== 'object' ||
      Array.isArray(requirement) ||
      Reflect.ownKeys(requirement).some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'id' && key !== 'containerPath' && key !== 'sealAfterSetup'),
      ) ||
      (Object.hasOwn(requirement, 'sealAfterSetup') &&
        typeof requirement.sealAfterSetup !== 'boolean')
    ) {
      throw new TypeError('Invalid runtime state directory requirement.');
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(requirement.id)) {
      throw new TypeError(
        `Invalid runtime state directory id: ${requirement.id}`,
      );
    }
    if (ids.has(requirement.id)) {
      throw new TypeError(
        `Duplicate runtime state directory id: ${requirement.id}`,
      );
    }
    if (
      !(
        requirement.containerPath.startsWith(`${CONTAINER_HOME}/`) ||
        (requirement.sealAfterSetup === true &&
          requirement.containerPath.startsWith('/opt/'))
      ) ||
      requirement.containerPath.includes('\0') ||
      requirement.containerPath.includes('\\') ||
      path.posix.normalize(requirement.containerPath) !==
        requirement.containerPath
    ) {
      throw new TypeError(
        `Runtime state directory must be a canonical child of ${CONTAINER_HOME}, or a sealed child of /opt: ${requirement.containerPath}`,
      );
    }
    if (
      paths.some(
        (existing) =>
          existing === requirement.containerPath ||
          existing.startsWith(`${requirement.containerPath}/`) ||
          requirement.containerPath.startsWith(`${existing}/`),
      )
    ) {
      throw new TypeError('Runtime state directory mounts may not overlap.');
    }
    ids.add(requirement.id);
    paths.push(requirement.containerPath);
  }
  return requirements;
}

async function readContainerId(cidFile: string): Promise<string | undefined> {
  try {
    const id = (await fs.readFile(cidFile, 'utf8')).trim();
    return /^[a-f0-9]{64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function containerNameFor(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new TypeError('runId must be a safe non-empty identifier.');
  }
  return `stripe-forge-${runId}-${randomUUID().slice(0, 8)}`.slice(0, 200);
}

function resolveFilesystemIdentity(): Readonly<{
  containerUserId: number;
  hostWriteOwner?: Readonly<{ uid: number; gid: number }>;
}> {
  const hostUserId =
    typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (
    hostUserId !== undefined &&
    (!Number.isSafeInteger(hostUserId) ||
      hostUserId < 0 ||
      hostUserId > 0xffff_fffe)
  ) {
    throw new Error('Forge Docker runtime cannot represent the host user ID.');
  }
  if (hostUserId === 0) {
    return Object.freeze({
      containerUserId: DEFAULT_FORGE_USER_ID,
      hostWriteOwner: Object.freeze({
        uid: DEFAULT_FORGE_USER_ID,
        gid: FORGE_GROUP_ID,
      }),
    });
  }
  return Object.freeze({
    containerUserId: hostUserId ?? DEFAULT_FORGE_USER_ID,
  });
}

function imageTag(platform: RuntimePlatform, userId: number): string {
  return `stripe-forge-runtime:${FORGE_RUNTIME_ASSET_DIGEST.slice(0, 20)}-${
    platform === 'linux/amd64' ? 'amd64' : 'arm64'
  }-uid${userId}`;
}

function mountArgument(
  source: string,
  target: string,
  readonly = false,
): string {
  if (source.includes(',') || source.includes('\0')) {
    throw new TypeError(
      'Docker runtime mount path contains an unsupported character.',
    );
  }
  return `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
