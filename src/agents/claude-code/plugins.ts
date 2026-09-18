import {createHash} from 'node:crypto';

import type {CommandResult, CommandRunner} from '../../contracts/command.js';
import type {
  AgentPluginInstallContext,
  AgentPluginInstaller,
  AgentPluginPreflightContext,
} from '../../contracts/plugin.js';
import type {MutableWorkspace, WorkspaceEntry} from '../../contracts/runtime.js';
import type {PluginSelectionV1} from '../../model/types.js';
import {
  isSafeGitHubRepository,
  isSafeSimpleIdentifier,
  isSafeVersion,
} from '../../model/paths.js';
import {serializeCanonicalJson} from '../../serialization.js';

export const CLAUDE_PLUGIN_STATE_ID = 'claude-plugin-seed' as const;
export const CLAUDE_PLUGIN_STATE_PATH =
  '/home/forge/.forge/claude-plugin-state' as const;

const SEED_RELATIVE_PATH = 'seed';
const INSTALLER_HOME_RELATIVE_PATH = 'installer-home';
const SESSION_SETTINGS_RELATIVE_PATH = 'session-settings.json';
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PLUGIN_FILES = 100_000;
const MAX_CATALOG_PLUGINS = 10_000;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_DEPTH = 64;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const FULL_GIT_COMMIT = /^[a-f0-9]{40}$/;

interface ClaudePluginInstallerOptions {
  readonly adapterId: string;
  readonly executable: string;
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

  return Object.freeze({
    preflight(
      distribution: PluginSelectionV1,
      context: AgentPluginPreflightContext,
    ) {
      if (context.selection.adapter !== adapterId) {
        throw new TypeError('Claude plugin installer does not match the selected adapter.');
      }
      const selected = freezeDistribution(distribution);
      const identity = parseQualifiedPluginId(selected.plugin);
      const alias = marketplaceAlias(selected);
      const nativePluginId = `${identity.name}@${alias}`;

      return Object.freeze({
        requirements: Object.freeze({
          executables: Object.freeze([executable, 'env', 'git', 'mkdir']),
          stateDirectories: Object.freeze([
            Object.freeze({
              id: CLAUDE_PLUGIN_STATE_ID,
              containerPath: CLAUDE_PLUGIN_STATE_PATH,
              sealAfterSetup: true,
            }),
          ]),
        }),
        async install(installContext: AgentPluginInstallContext): Promise<void> {
          const state = installContext.stateDirectories.get(CLAUDE_PLUGIN_STATE_ID);
          if (!state || installContext.stateDirectories.size !== 1) {
            throw new TypeError('Claude plugin installation state is unavailable.');
          }
          installContext.signal.throwIfAborted();
          const seedPath = `${CLAUDE_PLUGIN_STATE_PATH}/${SEED_RELATIVE_PATH}`;
          const installerHome =
            `${CLAUDE_PLUGIN_STATE_PATH}/${INSTALLER_HOME_RELATIVE_PATH}`;
          const marketplaceRelativePath =
            `${SEED_RELATIVE_PATH}/marketplaces/${alias}`;
          const marketplacePath = `${CLAUDE_PLUGIN_STATE_PATH}/${marketplaceRelativePath}`;

          await ensureMarketplaceCheckout({
            commands: installContext.commands,
            distribution: selected,
            marketplacePath,
            marketplaceRelativePath,
            signal: installContext.signal,
            state,
          });
          const entry = await readSelectedMarketplaceEntry({
            commands: installContext.commands,
            distribution: selected,
            identity,
            marketplacePath,
            signal: installContext.signal,
          });
          await materializeSyntheticMarketplace(
            state,
            marketplaceRelativePath,
            alias,
            entry,
          );

          const knownBefore = await knownMarketplaceNames(state);
          if (!knownBefore.has(alias)) {
            await runChecked(
              installContext.commands,
              claudePluginCommand(
                executable,
                installerHome,
                seedPath,
                [
                  'plugin',
                  'marketplace',
                  'add',
                  marketplacePath,
                  '--scope',
                  'user',
                ],
              ),
              installContext.signal,
              'Claude could not register the selected plugin marketplace.',
            );
          }

          const installResult = await runChecked(
            installContext.commands,
            claudePluginCommand(executable, installerHome, seedPath, [
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

          const expectedPluginIds = await enabledPluginIds(state);
          expectedPluginIds.add(nativePluginId);
          const listResult = await runChecked(
            installContext.commands,
            claudePluginCommand(executable, installerHome, seedPath, [
              'plugin',
              'list',
              '--json',
            ]),
            installContext.signal,
            'Claude could not verify the selected plugin.',
          );
          const installed = inspectPluginList(
            listResult.stdout,
            expectedPluginIds,
            nativePluginId,
          );
          const installedLocation = installedPluginLocation(
            entry,
            alias,
            identity.name,
            installed.version,
          );
          if (installed.installPath !== installedLocation.absolute) {
            throw new Error('Claude plugin list returned an invalid installation path.');
          }
          await assertInstalledPluginRecord(
            state,
            expectedPluginIds,
            nativePluginId,
            installed.version,
            installedLocation.absolute,
            entry.source,
          );
          await assertInstalledTreeSafe(
            state,
            installedLocation.relative,
            installContext.signal,
          );
          await writeSessionSettings(state, expectedPluginIds);
        },
      });
    },
  });
}

async function ensureMarketplaceCheckout(input: {
  readonly commands: CommandRunner;
  readonly distribution: PluginSelectionV1;
  readonly marketplacePath: string;
  readonly marketplaceRelativePath: string;
  readonly signal: AbortSignal;
  readonly state: MutableWorkspace;
}): Promise<void> {
  const head = await input.state.inspect(`${input.marketplaceRelativePath}/.git/HEAD`);
  if (head.kind === 'absent') {
    await runChecked(
      input.commands,
      ['mkdir', '-p', `${CLAUDE_PLUGIN_STATE_PATH}/${SEED_RELATIVE_PATH}/marketplaces`],
      input.signal,
      'Forge could not prepare plugin marketplace state.',
    );
    await runGit(
      input.commands,
      ['init', '--quiet', input.marketplacePath],
      input.signal,
      'Forge could not initialize the plugin marketplace snapshot.',
    );
    await runGit(
      input.commands,
      [
        '-C',
        input.marketplacePath,
        'remote',
        'add',
        'origin',
        marketplaceRepositoryUrl(input.distribution.marketplace),
      ],
      input.signal,
      'Forge could not configure the plugin marketplace snapshot.',
    );
    await runGit(
      input.commands,
      [
        '-c',
        'protocol.file.allow=never',
        '-c',
        'protocol.ext.allow=never',
        '-C',
        input.marketplacePath,
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth',
        '1',
        'origin',
        'HEAD',
      ],
      input.signal,
      'Forge could not fetch the latest plugin marketplace entry.',
    );
    await runGit(
      input.commands,
      ['-C', input.marketplacePath, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
      input.signal,
      'Forge could not check out the plugin marketplace snapshot.',
    );
  } else if (head.kind !== 'file') {
    throw new Error('Plugin marketplace snapshot state is malformed.');
  }

  const revision = await runGit(
    input.commands,
    ['-C', input.marketplacePath, 'rev-parse', 'HEAD'],
    input.signal,
    'Forge could not identify the plugin marketplace snapshot.',
  );
  if (!FULL_GIT_COMMIT.test(revision.stdout.trim())) {
    throw new Error('Plugin marketplace checkout did not resolve to a Git commit.');
  }
  const remote = await runGit(
    input.commands,
    ['-C', input.marketplacePath, 'remote', 'get-url', 'origin'],
    input.signal,
    'Forge could not verify the plugin marketplace source.',
  );
  if (remote.stdout.trim() !== marketplaceRepositoryUrl(input.distribution.marketplace)) {
    throw new Error('Plugin marketplace checkout does not match its repository.');
  }
}

async function readSelectedMarketplaceEntry(input: {
  readonly commands: CommandRunner;
  readonly distribution: PluginSelectionV1;
  readonly identity: QualifiedPluginId;
  readonly marketplacePath: string;
  readonly signal: AbortSignal;
}): Promise<MarketplaceEntry> {
  const shown = await runGit(
    input.commands,
    [
      '-C',
      input.marketplacePath,
      'show',
      'HEAD:.claude-plugin/marketplace.json',
    ],
    input.signal,
    'Forge could not read the plugin marketplace snapshot.',
  );
  const catalog = parseJson(shown.stdout, 'plugin marketplace catalog');
  assertBoundedJson(catalog, 'plugin marketplace catalog');
  if (!isPlainRecord(catalog) || catalog.name !== input.identity.marketplace) {
    throw new Error('Pinned catalog does not match the plugin marketplace identity.');
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
    throw new Error('Plugin marketplace snapshot does not contain one selected entry.');
  }
  const entry = matches[0] as MarketplaceEntry;
  if (
    entry.version !== undefined &&
    (typeof entry.version !== 'string' || !isSafeVersion(entry.version))
  ) {
    throw new Error('Plugin marketplace entry has an invalid version.');
  }
  if (Object.hasOwn(entry, 'headers') || Object.hasOwn(entry, 'headersHelper')) {
    throw new Error('Authenticated archive plugin sources are not supported by v1.');
  }
  if (
    Object.hasOwn(entry, 'dependencies') &&
    (!Array.isArray(entry.dependencies) || entry.dependencies.length > 0)
  ) {
    throw new Error('Plugin dependencies are not supported by forge/plugin@1.');
  }
  assertSupportedMarketplaceSource(entry.source);
  return entry;
}

async function materializeSyntheticMarketplace(
  state: MutableWorkspace,
  marketplaceRelativePath: string,
  alias: string,
  entry: MarketplaceEntry,
): Promise<void> {
  const catalogPath = `${marketplaceRelativePath}/.claude-plugin/marketplace.json`;
  const existingBytes = await state.readFile(catalogPath, {
    maxBytes: MAX_COMMAND_OUTPUT_BYTES,
  });
  const existing = parseJson(
    Buffer.from(existingBytes).toString('utf8'),
    'materialized plugin marketplace',
  );
  let entries: unknown[] = [];
  if (isPlainRecord(existing) && existing.name === alias) {
    if (!Array.isArray(existing.plugins)) {
      throw new Error('Materialized plugin marketplace is malformed.');
    }
    entries = [...existing.plugins];
  }
  const previous = entries.find(
    (candidate) => isPlainRecord(candidate) && candidate.name === entry.name,
  );
  if (
    previous !== undefined &&
    serializeCanonicalJson(previous) !== serializeCanonicalJson(entry)
  ) {
    throw new Error('Materialized plugin marketplace contains a conflicting entry.');
  }
  if (previous === undefined) entries.push(entry);
  entries.sort((left, right) =>
    compareCodeUnits(entryName(left), entryName(right)),
  );
  const body = serializeCanonicalJson({
    name: alias,
    owner: {name: 'Stripe Forge'},
    plugins: entries,
  });
  await state.writeFile(catalogPath, Buffer.from(body, 'utf8'), {mode: 0o644});
}

async function knownMarketplaceNames(state: MutableWorkspace): Promise<Set<string>> {
  const path = `${SEED_RELATIVE_PATH}/known_marketplaces.json`;
  const inspected = await state.inspect(path);
  if (inspected.kind === 'absent') return new Set();
  if (inspected.kind !== 'file') {
    throw new Error('Claude plugin marketplace state is malformed.');
  }
  const value = parseJson(
    Buffer.from(
      await state.readFile(path, {maxBytes: MAX_COMMAND_OUTPUT_BYTES}),
    ).toString('utf8'),
    'Claude known marketplaces',
  );
  if (!isPlainRecord(value)) {
    throw new Error('Claude known marketplaces state is malformed.');
  }
  return new Set(Object.keys(value));
}

async function enabledPluginIds(state: MutableWorkspace): Promise<Set<string>> {
  const inspected = await state.inspect(SESSION_SETTINGS_RELATIVE_PATH);
  if (inspected.kind === 'absent') return new Set();
  if (inspected.kind !== 'file') {
    throw new Error('Claude plugin session settings are malformed.');
  }
  const value = parseJson(
    Buffer.from(
      await state.readFile(SESSION_SETTINGS_RELATIVE_PATH, {
        maxBytes: MAX_COMMAND_OUTPUT_BYTES,
      }),
    ).toString('utf8'),
    'Claude plugin session settings',
  );
  if (
    !isPlainRecord(value) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || key !== 'enabledPlugins',
    ) ||
    !isPlainRecord(value.enabledPlugins)
  ) {
    throw new Error('Claude plugin session settings are malformed.');
  }
  const output = new Set<string>();
  for (const [id, enabled] of Object.entries(value.enabledPlugins)) {
    parseQualifiedPluginId(id);
    if (enabled !== true) {
      throw new Error('Claude plugin session settings are malformed.');
    }
    output.add(id);
  }
  return output;
}

async function writeSessionSettings(
  state: MutableWorkspace,
  pluginIds: ReadonlySet<string>,
): Promise<void> {
  const enabledPlugins: Record<string, boolean> = {};
  for (const id of [...pluginIds].sort(compareCodeUnits)) {
    Object.defineProperty(enabledPlugins, id, {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    });
  }
  await state.writeFile(
    SESSION_SETTINGS_RELATIVE_PATH,
    Buffer.from(serializeCanonicalJson({enabledPlugins}), 'utf8'),
    {mode: 0o444},
  );
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
      !row.installPath.startsWith(
        `${CLAUDE_PLUGIN_STATE_PATH}/${SEED_RELATIVE_PATH}/`,
      )
    ) {
      throw new Error('Claude plugin list returned an invalid installed plugin.');
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
  if (!setsEqual(actualIds, expectedPluginIds) || !actualIds.has(selectedPluginId)) {
    throw new Error('Claude installed an unexpected plugin dependency or identity.');
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
): Promise<void> {
  const value = parseJson(
    Buffer.from(
      await state.readFile(`${SEED_RELATIVE_PATH}/installed_plugins.json`, {
        maxBytes: MAX_COMMAND_OUTPUT_BYTES,
      }),
    ).toString('utf8'),
    'Claude installed plugin state',
  );
  if (!isPlainRecord(value) || value.version !== 2 || !isPlainRecord(value.plugins)) {
    throw new Error('Claude installed plugin state is malformed.');
  }
  const actualIds = new Set(Object.keys(value.plugins));
  if (!setsEqual(actualIds, expectedPluginIds)) {
    throw new Error('Claude installed plugin state contains an unexpected plugin.');
  }
  const records = value.plugins[selectedPluginId];
  if (!Array.isArray(records) || records.length !== 1 || !isPlainRecord(records[0])) {
    throw new Error('Claude installed plugin state omitted the selected plugin.');
  }
  const record = records[0];
  if (
    record.scope !== 'user' ||
    record.version !== expectedVersion ||
    record.installPath !== expectedInstallPath
  ) {
    throw new Error('Claude installed plugin state does not match the expected plugin.');
  }
  const expectedCommit = marketplaceSourceCommit(marketplaceSource);
  if (expectedCommit !== undefined && record.gitCommitSha !== expectedCommit) {
    throw new Error('Claude installed plugin state does not match the marketplace commit.');
  }
  if (
    isGitMarketplaceSource(marketplaceSource) &&
    (typeof record.gitCommitSha !== 'string' ||
      !FULL_GIT_COMMIT.test(record.gitCommitSha))
  ) {
    throw new Error('Claude installed plugin state omitted its resolved Git commit.');
  }
}

function installedPluginLocation(
  entry: MarketplaceEntry,
  alias: string,
  pluginName: string,
  version: string,
): Readonly<{relative: string; absolute: string}> {
  const relative =
    typeof entry.source === 'string'
      ? `${SEED_RELATIVE_PATH}/marketplaces/${alias}/${entry.source.slice(2)}`
      : `${SEED_RELATIVE_PATH}/cache/${alias}/${pluginName}/${version}`;
  return Object.freeze({
    relative,
    absolute: `${CLAUDE_PLUGIN_STATE_PATH}/${relative}`,
  });
}

async function assertInstalledTreeSafe(
  state: MutableWorkspace,
  relativePath: string,
  signal: AbortSignal,
): Promise<void> {
  let entries: readonly WorkspaceEntry[];
  try {
    const root = await state.inspect(relativePath);
    if (root.kind !== 'directory') {
      throw new Error('Installed plugin root is not a directory.');
    }
    entries = await state.listFiles({
      under: relativePath,
      maxEntries: MAX_PLUGIN_FILES,
      signal,
    });
  } catch (error) {
    throw new Error('Forge could not inspect the installed plugin tree.', {
      cause: error,
    });
  }
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.kind !== 'file' && entry.kind !== 'directory')
  ) {
    throw new Error('Installed plugin tree contains an unsupported filesystem entry.');
  }
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
  installerHome: string,
  seedPath: string,
  argv: readonly string[],
): readonly string[] {
  return [
    'env',
    `HOME=${installerHome}`,
    `CLAUDE_CODE_PLUGIN_CACHE_DIR=${seedPath}`,
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
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
  argv: readonly string[],
  signal: AbortSignal,
  message: string,
): Promise<CommandResult> {
  return runChecked(
    commands,
    [
      'env',
      `HOME=${CLAUDE_PLUGIN_STATE_PATH}/${INSTALLER_HOME_RELATIVE_PATH}`,
      'GIT_CONFIG_NOSYSTEM=1',
      'GIT_CONFIG_GLOBAL=/dev/null',
      'GIT_TERMINAL_PROMPT=0',
      'git',
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
  return Object.freeze({name, marketplace});
}

function marketplaceAlias(distribution: PluginSelectionV1): string {
  const digest = createHash('sha256')
    .update(
      serializeCanonicalJson({
        repository: distribution.marketplace,
        marketplace: parseQualifiedPluginId(distribution.plugin).marketplace,
      }),
    )
    .digest('hex');
  return `forge-${digest.slice(0, 32)}`;
}

function isGitMarketplaceSource(value: unknown): value is Record<string, unknown> {
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

function hasSafeOptionalGitCoordinates(value: Record<string, unknown>): boolean {
  return (
    (!Object.hasOwn(value, 'ref') ||
      (typeof value.ref === 'string' && isSafeGitReference(value.ref))) &&
    (!Object.hasOwn(value, 'sha') ||
      (typeof value.sha === 'string' && FULL_GIT_COMMIT.test(value.sha)))
  );
}

function isSafeGitReference(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\0-\x1f\x7f]/.test(value)
  );
}

function isSafeGitRepository(value: string): boolean {
  return isSafeGitHubRepository(value) || isSafeHttpsUrl(value);
}

function marketplaceRepositoryUrl(repository: string): string {
  if (!isSafeGitHubRepository(repository)) {
    throw new TypeError('Plugin marketplace must be a GitHub owner/repository.');
  }
  return `https://github.com/${repository}.git`;
}

function isSafeHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || /\s|[\0-\x1f\x7f]/.test(value)) {
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
    throw new Error(`${label} is not valid JSON.`, {cause: error});
  }
}

function assertBoundedJson(value: unknown, label: string): void {
  const pending: Array<{value: unknown; depth: number}> = [{value, depth: 0}];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new Error(`${label} exceeds Forge's structural limits.`);
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({value: child, depth: current.depth + 1});
      }
    } else if (isPlainRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({value: child, depth: current.depth + 1});
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

function entryName(value: unknown): string {
  return isPlainRecord(value) && typeof value.name === 'string' ? value.name : '';
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Reflect.ownKeys(value).length === keys.length && hasOnlyKeys(value, keys);
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
