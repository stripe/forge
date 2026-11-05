import type { CommandResult, CommandRunner } from '../../contracts/command.ts';
import type {
  AgentPluginInstallationReceipt,
  AgentPluginInstallContext,
  AgentPluginInstaller,
  AgentPluginPreflightContext,
} from '../../contracts/plugin.ts';
import type { MutableWorkspace } from '../../contracts/runtime.ts';
import {
  isSafeGitHubRepository,
  isSafeSimpleIdentifier,
  isSafeVersion,
} from '../../model/paths.ts';
import type { PluginSelectionV1 } from '../../model/types.ts';
import { configurePluginMcp } from '../pluginMcp.ts';
import {
  assertClaudeRuntimeLayout,
  type ClaudeCodeLayout,
  resolveClaudeCodeLayout,
} from './layout.ts';
import {
  inspectInstalledPluginTree,
  pluginSourceReceipt,
} from './pluginReceipt.ts';

export const CLAUDE_PLUGIN_STATE_ID = 'claude-plugins' as const;
export const CLAUDE_PLUGIN_STATE_PATH = '/home/forge/.claude/plugins' as const;

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_PLUGINS = 10_000;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_DEPTH = 64;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const FULL_GIT_COMMIT = /^[a-f0-9]{40}$/;

interface ClaudePluginInstallerOptions {
  readonly adapterId: string;
  readonly executable: string;
  readonly layout?: ClaudeCodeLayout;
}

interface QualifiedPluginId {
  readonly name: string;
  readonly marketplace: string;
}

interface MarketplaceEntry extends Record<string, unknown> {
  readonly name: string;
  readonly source: unknown;
  readonly version?: string;
}

interface InstalledPlugin {
  readonly version: string;
  readonly installPath: string;
}

/** Native Claude marketplace realization used by the public plugin action. */
export function createClaudePluginInstaller(
  options: ClaudePluginInstallerOptions,
): AgentPluginInstaller {
  const adapterId = options.adapterId;
  const executable = options.executable;
  const layout = resolveClaudeCodeLayout(options.layout);
  const pluginStatePath = `${layout.configDirectory}/plugins`;

  return Object.freeze({
    supportsMcpBearerAuth: true as const,
    preflight(
      distribution: PluginSelectionV1,
      context: AgentPluginPreflightContext,
    ) {
      if (context.selection.adapter !== adapterId) {
        throw new TypeError(
          'Claude plugin installer does not match the selected adapter.',
        );
      }
      const selected = freezeDistribution(distribution);
      const identity = parseQualifiedPluginId(selected.plugin);
      const nativePluginId = selected.plugin;

      return Object.freeze({
        requirements: Object.freeze({
          executables: Object.freeze([executable, 'env', 'git']),
          stateDirectories: Object.freeze([
            Object.freeze({
              id: CLAUDE_PLUGIN_STATE_ID,
              containerPath: pluginStatePath,
              sealAfterSetup: false,
            }),
          ]),
        }),
        async install(
          installContext: AgentPluginInstallContext,
        ): Promise<AgentPluginInstallationReceipt> {
          assertClaudeRuntimeLayout(layout, installContext.paths);
          const state = installContext.stateDirectories.get(
            CLAUDE_PLUGIN_STATE_ID,
          );
          if (!state || installContext.stateDirectories.size !== 1) {
            throw new TypeError(
              'Claude plugin installation state is unavailable.',
            );
          }
          installContext.signal.throwIfAborted();
          // Capture the pre-install inventory so native dependencies cannot
          // silently become part of the declared treatment.
          const expectedPluginIds = new Set(
            Object.keys(await installedPluginRecords(state)),
          );
          const marketplaceRelativePath = `marketplaces/${identity.marketplace}`;
          const marketplacePath = `${pluginStatePath}/${marketplaceRelativePath}`;

          const marketplaceCommit = await ensureMarketplaceCheckout({
            commands: installContext.commands,
            distribution: selected,
            executable,
            identity,
            marketplacePath,
            marketplaceRelativePath,
            signal: installContext.signal,
            state,
          });
          const entry = await readSelectedMarketplaceEntry({
            commands: installContext.commands,
            identity,
            marketplacePath,
            marketplaceCommit,
            signal: installContext.signal,
          });
          const installResult = await runChecked(
            installContext.commands,
            claudePluginCommand(executable, [
              'plugin',
              'install',
              nativePluginId,
              '--scope',
              'user',
              '--json',
            ]),
            installContext.signal,
            'Claude could not install the selected plugin.',
          );
          assertInstallResult(installResult.stdout, nativePluginId);

          expectedPluginIds.add(nativePluginId);
          const listResult = await runChecked(
            installContext.commands,
            claudePluginCommand(executable, ['plugin', 'list', '--json']),
            installContext.signal,
            'Claude could not verify the selected plugin.',
          );
          const installed = inspectPluginList(
            listResult.stdout,
            expectedPluginIds,
            nativePluginId,
            pluginStatePath,
          );
          const installedLocation = installedPluginLocation(
            pluginStatePath,
            identity.marketplace,
            identity.name,
            installed.version,
          );
          if (installed.installPath !== installedLocation.absolute) {
            throw new Error(
              'Claude plugin list returned an invalid installation path.',
            );
          }
          const sourceCommit = await assertInstalledPluginRecord(
            state,
            expectedPluginIds,
            nativePluginId,
            installed.version,
            installedLocation.absolute,
            entry.source,
          );
          const mcpServers = context.mcpServers;
          if (mcpServers)
            await configurePluginMcp(
              state,
              installedLocation.relative,
              mcpServers,
            );
          const installedTree = await inspectInstalledPluginTree(
            state,
            installedLocation.relative,
            installContext.signal,
          );
          return deepFreeze({
            adapter: adapterId,
            plugin: selected.plugin,
            marketplace: selected.marketplace,
            marketplace_commit: marketplaceCommit,
            native_plugin_id: nativePluginId,
            version: installed.version,
            source: pluginSourceReceipt(entry.source, sourceCommit),
            installed_tree: installedTree,
          });
        },
      });
    },
  });
}

async function ensureMarketplaceCheckout(input: {
  readonly commands: CommandRunner;
  readonly distribution: PluginSelectionV1;
  readonly executable: string;
  readonly identity: QualifiedPluginId;
  readonly marketplacePath: string;
  readonly marketplaceRelativePath: string;
  readonly signal: AbortSignal;
  readonly state: MutableWorkspace;
}): Promise<string> {
  let known = await knownMarketplaces(input.state);
  if (!Object.hasOwn(known, input.identity.marketplace)) {
    await runChecked(
      input.commands,
      claudePluginCommand(input.executable, [
        'plugin',
        'marketplace',
        'add',
        input.distribution.marketplace,
        '--scope',
        'user',
      ]),
      input.signal,
      'Claude could not register the selected plugin marketplace.',
    );
    known = await knownMarketplaces(input.state);
  }
  const registered = known[input.identity.marketplace];
  if (
    !isPlainRecord(registered) ||
    registered.installLocation !== input.marketplacePath ||
    !isPlainRecord(registered.source) ||
    registered.source.source !== 'github' ||
    registered.source.repo !== input.distribution.marketplace
  ) {
    throw new Error(
      'Claude plugin marketplace state does not match its repository or path.',
    );
  }
  const head = await input.state.inspect(
    `${input.marketplaceRelativePath}/.git/HEAD`,
  );
  if (head.kind !== 'file') {
    throw new Error('Plugin marketplace checkout state is malformed.');
  }

  const revision = await runGit(
    input.commands,
    input.marketplacePath,
    ['-C', input.marketplacePath, 'rev-parse', 'HEAD'],
    input.signal,
    'Forge could not identify the plugin marketplace snapshot.',
  );
  const commit = revision.stdout.trim();
  if (!FULL_GIT_COMMIT.test(commit)) {
    throw new Error(
      'Plugin marketplace checkout did not resolve to a Git commit.',
    );
  }

  const remote = await runGit(
    input.commands,
    input.marketplacePath,
    ['-C', input.marketplacePath, 'remote', 'get-url', 'origin'],
    input.signal,
    'Forge could not verify the plugin marketplace source.',
  );
  if (
    remote.stdout.trim().replace(/\.git$/, '') !==
    marketplaceRepositoryUrl(input.distribution.marketplace).replace(
      /\.git$/,
      '',
    )
  ) {
    throw new Error(
      'Plugin marketplace checkout does not match its repository.',
    );
  }
  return commit;
}

async function readSelectedMarketplaceEntry(input: {
  readonly commands: CommandRunner;
  readonly identity: QualifiedPluginId;
  readonly marketplacePath: string;
  readonly marketplaceCommit: string;
  readonly signal: AbortSignal;
}): Promise<MarketplaceEntry> {
  const shown = await runGit(
    input.commands,
    input.marketplacePath,
    [
      '-C',
      input.marketplacePath,
      'show',
      `${input.marketplaceCommit}:.claude-plugin/marketplace.json`,
    ],
    input.signal,
    'Forge could not read the plugin marketplace snapshot.',
  );
  const catalog = parseJson(shown.stdout, 'plugin marketplace catalog');
  assertBoundedJson(catalog, 'plugin marketplace catalog');
  if (!isPlainRecord(catalog) || catalog.name !== input.identity.marketplace) {
    throw new Error(
      'Fetched catalog does not match the plugin marketplace identity.',
    );
  }
  if (
    !Array.isArray(catalog.plugins) ||
    catalog.plugins.length === 0 ||
    catalog.plugins.length > MAX_CATALOG_PLUGINS
  ) {
    throw new Error('Plugin marketplace snapshot has an invalid plugin list.');
  }
  const matches = catalog.plugins.filter(
    (entry) => isPlainRecord(entry) && entry.name === input.identity.name,
  );
  if (matches.length !== 1 || !isPlainRecord(matches[0])) {
    throw new Error(
      'Plugin marketplace snapshot does not contain one selected entry.',
    );
  }
  const entry = matches[0] as MarketplaceEntry;
  if (
    entry.version !== undefined &&
    (typeof entry.version !== 'string' || !isSafeVersion(entry.version))
  ) {
    throw new Error('Plugin marketplace entry has an invalid version.');
  }
  if (
    Object.hasOwn(entry, 'headers') ||
    Object.hasOwn(entry, 'headersHelper')
  ) {
    throw new Error(
      'Authenticated archive plugin sources are not supported by v1.',
    );
  }
  if (
    Object.hasOwn(entry, 'dependencies') &&
    (!Array.isArray(entry.dependencies) || entry.dependencies.length > 0)
  ) {
    throw new Error('Plugin dependencies are not supported by forge/plugin.');
  }
  assertSupportedMarketplaceSource(entry.source);
  return entry;
}

async function knownMarketplaces(
  state: MutableWorkspace,
): Promise<Record<string, unknown>> {
  const path = 'known_marketplaces.json';
  const inspected = await state.inspect(path);
  if (inspected.kind === 'absent') return {};
  if (inspected.kind !== 'file') {
    throw new Error('Claude plugin marketplace state is malformed.');
  }
  const value = parseJson(
    Buffer.from(
      await state.readFile(path, { maxBytes: MAX_COMMAND_OUTPUT_BYTES }),
    ).toString('utf8'),
    'Claude known marketplaces',
  );
  if (!isPlainRecord(value)) {
    throw new Error('Claude known marketplaces state is malformed.');
  }
  assertBoundedJson(value, 'Claude known marketplaces');
  return value;
}

async function installedPluginRecords(
  state: MutableWorkspace,
): Promise<Record<string, unknown>> {
  const path = 'installed_plugins.json';
  const inspected = await state.inspect(path);
  if (inspected.kind === 'absent') return {};
  if (inspected.kind !== 'file') {
    throw new Error('Claude installed plugin state is malformed.');
  }
  const value = parseJson(
    Buffer.from(
      await state.readFile(path, { maxBytes: MAX_COMMAND_OUTPUT_BYTES }),
    ).toString('utf8'),
    'Claude installed plugin state',
  );
  if (
    !isPlainRecord(value) ||
    value.version !== 2 ||
    !isPlainRecord(value.plugins)
  ) {
    throw new Error('Claude installed plugin state is malformed.');
  }
  assertBoundedJson(value, 'Claude installed plugin state');
  for (const id of Object.keys(value.plugins)) parseQualifiedPluginId(id);
  return value.plugins;
}

function assertInstallResult(output: string, pluginId: string): void {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .at(-1);
  const result = parseJson(line ?? '', 'Claude plugin install result');
  if (
    !isPlainRecord(result) ||
    result.command !== 'install' ||
    result.outcome !== 'ok' ||
    result.pluginId !== pluginId ||
    result.scope !== 'user'
  ) {
    throw new Error('Claude plugin install returned an unexpected result.');
  }
}

function inspectPluginList(
  output: string,
  expectedPluginIds: ReadonlySet<string>,
  selectedPluginId: string,
  pluginStatePath: string,
): InstalledPlugin {
  const value = parseJson(output, 'Claude plugin list');
  if (!Array.isArray(value)) {
    throw new Error('Claude plugin list returned malformed JSON.');
  }
  const actualIds = new Set<string>();
  for (const row of value) {
    if (
      !isPlainRecord(row) ||
      typeof row.id !== 'string' ||
      typeof row.version !== 'string' ||
      !isSafeVersion(row.version) ||
      row.scope !== 'user' ||
      row.enabled !== true ||
      typeof row.installPath !== 'string' ||
      !row.installPath.startsWith(`${pluginStatePath}/cache/`)
    ) {
      throw new Error(
        'Claude plugin list returned an invalid installed plugin.',
      );
    }
    if (
      (Object.hasOwn(row, 'errors') &&
        (!Array.isArray(row.errors) || row.errors.length > 0)) ||
      (Object.hasOwn(row, 'errorDetails') &&
        (!Array.isArray(row.errorDetails) || row.errorDetails.length > 0))
    ) {
      throw new Error('Claude reported an installed plugin load error.');
    }
    if (actualIds.has(row.id)) {
      throw new Error('Claude plugin list returned a duplicate plugin.');
    }
    actualIds.add(row.id);
  }
  if (
    !setsEqual(actualIds, expectedPluginIds) ||
    !actualIds.has(selectedPluginId)
  ) {
    throw new Error(
      'Claude installed an unexpected plugin dependency or identity.',
    );
  }
  const selected = value.find(
    (row) => isPlainRecord(row) && row.id === selectedPluginId,
  );
  if (
    !isPlainRecord(selected) ||
    typeof selected.version !== 'string' ||
    typeof selected.installPath !== 'string'
  ) {
    throw new Error('Claude plugin list omitted the selected plugin.');
  }
  return Object.freeze({
    version: selected.version,
    installPath: selected.installPath,
  });
}

async function assertInstalledPluginRecord(
  state: MutableWorkspace,
  expectedPluginIds: ReadonlySet<string>,
  selectedPluginId: string,
  expectedVersion: string,
  expectedInstallPath: string,
  marketplaceSource: unknown,
): Promise<string | undefined> {
  const plugins = await installedPluginRecords(state);
  const actualIds = new Set(Object.keys(plugins));
  if (!setsEqual(actualIds, expectedPluginIds)) {
    throw new Error(
      'Claude installed plugin state contains an unexpected plugin.',
    );
  }
  const records = plugins[selectedPluginId];
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    !isPlainRecord(records[0])
  ) {
    throw new Error(
      'Claude installed plugin state omitted the selected plugin.',
    );
  }
  const record = records[0];
  if (
    record.scope !== 'user' ||
    record.version !== expectedVersion ||
    record.installPath !== expectedInstallPath
  ) {
    throw new Error(
      'Claude installed plugin state does not match the expected plugin.',
    );
  }
  const expectedCommit = marketplaceSourceCommit(marketplaceSource);
  if (expectedCommit !== undefined && record.gitCommitSha !== expectedCommit) {
    throw new Error(
      'Claude installed plugin state does not match the marketplace commit.',
    );
  }
  if (
    !isGitMarketplaceSource(marketplaceSource) ||
    !Object.hasOwn(record, 'gitCommitSha')
  ) {
    return undefined;
  }
  if (
    typeof record.gitCommitSha !== 'string' ||
    !FULL_GIT_COMMIT.test(record.gitCommitSha)
  ) {
    throw new Error(
      'Claude installed plugin state returned an invalid Git commit.',
    );
  }
  return record.gitCommitSha;
}

function installedPluginLocation(
  pluginStatePath: string,
  marketplace: string,
  pluginName: string,
  version: string,
): Readonly<{ relative: string; absolute: string }> {
  const relative = `cache/${marketplace}/${pluginName}/${version}`;
  return Object.freeze({
    relative,
    absolute: `${pluginStatePath}/${relative}`,
  });
}

function assertSupportedMarketplaceSource(source: unknown): void {
  if (typeof source === 'string') {
    if (!source.startsWith('./') || !isSafePluginPath(source.slice(2))) {
      throw new Error('Marketplace plugin path is invalid.');
    }
    return;
  }
  if (!isPlainRecord(source) || typeof source.source !== 'string') {
    throw new Error('Marketplace plugin source is malformed.');
  }
  if (source.source === 'archive') {
    if (
      !hasOnlyKeys(source, ['source', 'url', 'sha256']) ||
      typeof source.url !== 'string' ||
      !isSafeHttpsUrl(source.url) ||
      (Object.hasOwn(source, 'sha256') &&
        (typeof source.sha256 !== 'string' ||
          !/^[a-fA-F0-9]{64}$/.test(source.sha256)))
    ) {
      throw new Error('Marketplace archive source is invalid.');
    }
    return;
  }
  if (source.source === 'github') {
    if (
      !hasOnlyKeys(source, ['source', 'repo', 'ref', 'sha']) ||
      typeof source.repo !== 'string' ||
      !isSafeGitHubRepository(source.repo) ||
      !hasSafeOptionalGitCoordinates(source)
    ) {
      throw new Error('Marketplace GitHub source is invalid.');
    }
    return;
  }
  if (source.source === 'url') {
    if (
      !hasOnlyKeys(source, ['source', 'url', 'path', 'ref', 'sha']) ||
      typeof source.url !== 'string' ||
      !isSafeHttpsUrl(source.url) ||
      (Object.hasOwn(source, 'path') &&
        (typeof source.path !== 'string' || !isSafePluginPath(source.path))) ||
      !hasSafeOptionalGitCoordinates(source)
    ) {
      throw new Error('Marketplace Git URL source is invalid.');
    }
    return;
  }
  if (
    source.source !== 'git-subdir' ||
    !hasOnlyKeys(source, ['source', 'url', 'path', 'ref', 'sha']) ||
    typeof source.url !== 'string' ||
    !isSafeGitRepository(source.url) ||
    typeof source.path !== 'string' ||
    !isSafePluginPath(source.path) ||
    !hasSafeOptionalGitCoordinates(source)
  ) {
    throw new Error('Marketplace plugin source type is not supported by v1.');
  }
}

function claudePluginCommand(
  executable: string,
  argv: readonly string[],
): readonly string[] {
  return [
    'env',
    'CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1',
    'GIT_CONFIG_NOSYSTEM=1',
    'GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_TERMINAL_PROMPT=0',
    executable,
    ...argv,
  ];
}

function runGit(
  commands: CommandRunner,
  repositoryPath: string,
  argv: readonly string[],
  signal: AbortSignal,
  message: string,
): Promise<CommandResult> {
  return runChecked(
    commands,
    [
      'env',
      'GIT_CONFIG_NOSYSTEM=1',
      'GIT_CONFIG_GLOBAL=/dev/null',
      'GIT_TERMINAL_PROMPT=0',
      'git',
      // Trust only this run-owned checkout for provenance reads, without
      // changing global Git configuration or the native installer's behavior.
      '-c',
      `safe.directory=${repositoryPath}`,
      ...argv,
    ],
    signal,
    message,
  );
}

async function runChecked(
  commands: CommandRunner,
  argv: readonly string[],
  signal: AbortSignal,
  message: string,
): Promise<CommandResult> {
  const result = await commands.run(argv, {
    signal,
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0) throw new Error(message);
  return result;
}

function freezeDistribution(input: PluginSelectionV1): PluginSelectionV1 {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['plugin', 'marketplace']) ||
    typeof input.plugin !== 'string' ||
    typeof input.marketplace !== 'string' ||
    !isSafeGitHubRepository(input.marketplace)
  ) {
    throw new TypeError('Claude plugin distribution is invalid.');
  }
  parseQualifiedPluginId(input.plugin);
  return deepFreeze(structuredClone(input));
}

function parseQualifiedPluginId(value: string): QualifiedPluginId {
  const separator = value.indexOf('@');
  const name = value.slice(0, separator);
  const marketplace = value.slice(separator + 1);
  if (
    separator <= 0 ||
    separator !== value.lastIndexOf('@') ||
    !isSafeSimpleIdentifier(name) ||
    !isSafeSimpleIdentifier(marketplace)
  ) {
    throw new TypeError('Claude plugin ID must be plugin@marketplace.');
  }
  return Object.freeze({ name, marketplace });
}

function isGitMarketplaceSource(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    (value.source === 'github' ||
      value.source === 'url' ||
      value.source === 'git-subdir')
  );
}

function marketplaceSourceCommit(value: unknown): string | undefined {
  return isGitMarketplaceSource(value) && typeof value.sha === 'string'
    ? value.sha
    : undefined;
}

function hasSafeOptionalGitCoordinates(
  value: Record<string, unknown>,
): boolean {
  return (
    (!Object.hasOwn(value, 'ref') ||
      (typeof value.ref === 'string' && isSafeGitReference(value.ref))) &&
    (!Object.hasOwn(value, 'sha') ||
      (typeof value.sha === 'string' && FULL_GIT_COMMIT.test(value.sha)))
  );
}

function isSafeGitReference(value: string): boolean {
  return (
    value.length > 0 && value.length <= 4_096 && !/[\0-\x1f\x7f]/.test(value)
  );
}

function isSafeGitRepository(value: string): boolean {
  return isSafeGitHubRepository(value) || isSafeHttpsUrl(value);
}

function marketplaceRepositoryUrl(repository: string): string {
  if (!isSafeGitHubRepository(repository)) {
    throw new TypeError(
      'Plugin marketplace must be a GitHub owner/repository.',
    );
  }
  return `https://github.com/${repository}.git`;
}

function isSafeHttpsUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    /\s|[\0-\x1f\x7f]/.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.pathname.length > 1
    );
  } catch {
    return false;
  }
}

function isSafePluginPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\\\0-\x1f\x7f*?![\]]/.test(value) &&
    !value.startsWith('/') &&
    !value.startsWith('.') &&
    !value.endsWith('/') &&
    value
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function assertBoundedJson(value: unknown, label: string): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new Error(`${label} exceeds Forge's structural limits.`);
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isPlainRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (
      current.value !== null &&
      typeof current.value !== 'string' &&
      typeof current.value !== 'boolean' &&
      (typeof current.value !== 'number' || !Number.isFinite(current.value))
    ) {
      throw new Error(`${label} contains a non-JSON value.`);
    }
  }
}

function setsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && hasOnlyKeys(value, keys)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowed.has(key),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
