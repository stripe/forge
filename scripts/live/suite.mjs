import * as path from 'node:path';
import {MODEL, CODEX_MODEL, parseGatewayUrl, isLoopbackHostname} from './configuration.mjs';
import {startLoopbackGatewayBridge, assertDockerCanReachBridge} from './gateway.mjs';
import {createRunVerifiers} from './verification.mjs';
import {assertRuntimeCleanup} from './cleanup.mjs';
import {runCodexPluginIntegrationSuite} from './codex.mjs';
import {runCriterionJudgmentRegression} from './judgment.mjs';

export function createFullSuite(forge, options, overrides = {}) {
  const {
    runCli,
    CLAUDE_PLUGIN_STATE_ID,
    CLAUDE_PLUGIN_STATE_PATH,
    createClaudeCodeAdapter,
    createCodexAdapter,
    createArtifactStore,
    createDirectoryRunInputProvider,
    credentialReference,
    expandExperiment,
    loadExperimentConfig,
    loadDataset,
    resolveRunPlan,
    verifyCompletedRun,
    createAnthropicCompletionProvider,
    createDockerRuntimeAdapter,
    FORGE_CODEX_VERSION,
    assertRuntimeAdapterConforms,
  } = forge;
  const {repositoryRoot, resultsRoot, runtimeRoot, suiteId, runIds, signal, dockerExecutable, progress,
    codexSelected, liveAgent, gatewayBaseUrl, gatewaySelected, gatewayEnvironmentName,
    credentialEnvironmentName, upstreamCredential} = options;
  let bridge;
  const checks = {
    assertRuntimeCleanup, startLoopbackGatewayBridge, assertDockerCanReachBridge, runDockerConformance,
    runClaudePluginConformance, runCodexPluginIntegrationSuite, runSelection,
    runCriterionJudgmentRegression: (input) => runCriterionJudgmentRegression(forge, input),
    ...createRunVerifiers(forge), ...overrides
  };
  return {run: async () => {try {return await run();} finally {await bridge?.close();} }, runDockerConformance};

  async function checked(runId, action) {
    try {return await action();} finally {await checks.assertRuntimeCleanup({dockerExecutable, runtimeRoot, runId});}
  }

  async function run() {
    const gatewayUrl = gatewayBaseUrl === undefined && !codexSelected
      ? undefined
      : parseGatewayUrl(gatewayBaseUrl ?? 'https://api.openai.com/v1', gatewayEnvironmentName);
    // Codex always receives a one-run bridge token, never the upstream API key.
    bridge = gatewayUrl !== undefined && (codexSelected || isLoopbackHostname(gatewayUrl.hostname))
      ? await checks.startLoopbackGatewayBridge({
        upstream: gatewayUrl,
        upstreamCredential,
        protocol: codexSelected ? 'responses' : 'messages',
      })
      : undefined;

    const agentCredentialReference = credentialReference(
      bridge === undefined
        ? 'live.agent-credential'
        : 'live.ephemeral-bridge-credential',
    );
    const completionCredentialReference = credentialReference(
      'live.completion-credential',
    );
    const agentCredential = bridge?.credential ?? upstreamCredential;
    const runtime = createDockerRuntimeAdapter({dockerExecutable, temporaryRoot: runtimeRoot});
    const agentOptions = {
      credential: agentCredentialReference,
      credentialEnvironmentName,
      ...(gatewayBaseUrl === undefined && bridge === undefined
        ? {}
        : {baseUrl: bridge?.agentBaseUrl ?? gatewayBaseUrl}),
    };
    const agent = codexSelected
      ? createCodexAdapter(agentOptions)
      : createClaudeCodeAdapter(agentOptions);
    const completionProvider = codexSelected ? undefined : createAnthropicCompletionProvider({
      credential: completionCredentialReference,
      ...(gatewayBaseUrl === undefined
        ? {auth: 'api-key'}
        : {auth: 'bearer', baseUrl: gatewayBaseUrl}),
    });
    const credentialValues = new Map([
      [agentCredentialReference, agentCredential],
      ...(codexSelected ? [] : [[completionCredentialReference, upstreamCredential]]),
    ]);
    const credentialResolver = Object.freeze({
      async resolve(reference, context) {
        context.signal.throwIfAborted();
        const value = credentialValues.get(reference);
        if (value === undefined) {
          throw new Error('The live suite received an unexpected credential reference.');
        }
        return value;
      },
    });
    const compositionFactory = async ({datasetRoot, resultsRoot: selectedRoot}) =>
      Object.freeze({
        runtime,
        agents: new Map([[agent.id, agent]]),
        ...(completionProvider === undefined ? {} : {
          completionProviders: new Map([[completionProvider.id, completionProvider]]),
        }),
        credentialResolver,
        inputProvider: await createDirectoryRunInputProvider(datasetRoot),
        artifactStore: createArtifactStore({root: selectedRoot}),
      });

    progress('checking the real Docker runtime lifecycle');
    const dockerReport = await checks.runDockerConformance(runtime, runIds.docker, signal);
    let pluginReport;
    if (!codexSelected) {
      progress('checking latest Claude plugin installation');
      pluginReport = await checked(runIds.plugin, () => checks.runClaudePluginConformance({
        agent,
        runtime,
        runId: runIds.plugin,
        signal,
      }));
    } else {
      pluginReport = await checks.runCodexPluginIntegrationSuite(options);
    }
    if (bridge !== undefined) {
      progress('checking the container-to-loopback gateway bridge');
      await checks.assertDockerCanReachBridge({
        bridge,
        dockerExecutable,
        platform: dockerReport.platform,
        imageId: dockerReport.image_id,
        signal,
      });
    }

    progress(`running the one-shot ${codexSelected ? 'Codex' : 'Claude Code'} evaluation`);
    const oneShotCompleted = await checked(runIds.oneShot, () => checks.runSelection({
      label: 'one-shot',
      example: codexSelected ? 'codex' : 'quickstart',
      datasetExample: 'quickstart',
      agent: liveAgent,
      model: codexSelected ? CODEX_MODEL : MODEL,
      casePath: ['cases', 'examples', 'hello-file.yaml'],
      runId: runIds.oneShot,
      compositionFactory,
      signal,
    }));
    const oneShotReport = await checks.verifyOneShotRun(oneShotCompleted, codexSelected ? {
      format: 'codex-rollout-jsonl', version: FORGE_CODEX_VERSION,
    } : undefined);

    let multiTurnReport;
    let judgmentReport;
    if (!codexSelected) {
      progress('running the multi-turn Ava and criterion evaluation');
      const multiTurnCompleted = await checked(runIds.multiTurn, () => checks.runSelection({
        label: 'multi-turn',
        example: 'multi-turn',
        casePath: ['cases', 'examples', 'release-summary.yaml'],
        runId: runIds.multiTurn,
        compositionFactory,
        signal,
      }));
      multiTurnReport = await checks.verifyMultiTurnRun(multiTurnCompleted);
      progress('checking native structured judgment JSON escaping');
      judgmentReport = await checks.runCriterionJudgmentRegression({
        provider: completionProvider,
        credentialResolver,
        runId: `${suiteId}-judge-escaping`,
        signal,
      });
    }

    return {
      verified: true,
      suite_id: suiteId,
      authentication_mode: bridge === undefined
        ? gatewaySelected
          ? 'messages_compatible_gateway'
          : 'direct_anthropic'
        : 'loopback_gateway_bridge',
      docker: dockerReport,
      ...(pluginReport === undefined ? {} : {plugin: pluginReport}),
      ...(judgmentReport === undefined ? {} : {judgment: judgmentReport}),
      runs: {
        one_shot: oneShotReport,
        ...(multiTurnReport === undefined ? {} : {multi_turn: multiTurnReport}),
      },
    };
  }

  async function runClaudePluginConformance({
    agent,
    runtime,
    runId,
    signal: executionSignal,
  }) {
    const [dataset, experiment] = await Promise.all([
      loadDataset(path.join(repositoryRoot, 'examples', 'quickstart', 'dataset')),
      loadExperimentConfig(
        path.join(repositoryRoot, 'examples', 'quickstart', 'experiment.yaml'),
      ),
    ]);
    const selection = expandExperiment(experiment)[0];
    if (selection === undefined) {
      throw new Error('The quickstart experiment config contains no run selection.');
    }
    const plan = resolveRunPlan({dataset, experiment, selection});
    const installer = agent.pluginInstaller;
    if (installer === undefined) {
      throw new Error('The live Claude adapter does not expose plugin installation.');
    }
    const installation = installer.preflight(
      {
        plugin: 'stripe@claude-plugins-official',
        marketplace: 'anthropics/claude-plugins-official',
      },
      {selection: plan.agent, runtime: plan.runtime},
    );
    const agentRequirements = agent.requirements(plan.agent);
    let prepared;
    try {
      prepared = await runtime.prepare({
        runId,
        plan,
        environment: {variables: {}, credentials: {}},
        requirements: {
          executables: [
            ...new Set([
              ...agentRequirements.executables,
              ...installation.requirements.executables,
              'node',
            ]),
          ].sort(),
          stateDirectories: [
            ...agentRequirements.stateDirectories,
            ...installation.requirements.stateDirectories,
          ],
        },
        signal: executionSignal,
      });
      await agent.prepare({
        runId,
        plan,
        selection: plan.agent,
        runtime: {
          runtimeId: prepared.runtimeId,
          workspace: prepared.workspace,
          paths: prepared.paths,
          stateDirectories: prepared.stateDirectories,
          commands: {uncredentialed: prepared.commands.uncredentialed},
        },
        inputs: {},
        signal: executionSignal,
      });
      const pluginState = prepared.stateDirectories.get(CLAUDE_PLUGIN_STATE_ID);
      if (pluginState === undefined) {
        throw new Error('The live runtime omitted Claude plugin state.');
      }
      const receipt = await installation.install({
        runId,
        paths: prepared.paths,
        stateDirectories: new Map([
          [CLAUDE_PLUGIN_STATE_ID, pluginState],
        ]),
        commands: prepared.commands.uncredentialed,
        signal: executionSignal,
      });
      const containerIdentity = ['node', '-e', 'process.stdout.write(require("node:os").hostname())'];
      const beforeFinalization = await prepared.commands.uncredentialed.run(
        containerIdentity,
        {signal: executionSignal, timeoutMs: 30_000, maxOutputBytes: 64 * 1024},
      );
      await prepared.finalizeSetup();
      const afterFinalization = await prepared.commands.agent.run(
        containerIdentity,
        {signal: executionSignal, timeoutMs: 30_000, maxOutputBytes: 64 * 1024},
      );
      if (
        beforeFinalization.exitCode !== 0 ||
        afterFinalization.exitCode !== 0 ||
        !beforeFinalization.stdout.trim() ||
        beforeFinalization.stdout !== afterFinalization.stdout
      ) {
        throw new Error('Writable plugin setup replaced the live container.');
      }

      const listed = await prepared.commands.agent.run(
        ['claude', 'plugin', 'list', '--json'],
        {
          signal: executionSignal,
          timeoutMs: 60_000,
          maxOutputBytes: 1024 * 1024,
        },
      );
      if (listed.exitCode !== 0) {
        throw new Error('Claude could not list the installed plugin after setup.');
      }
      let plugins;
      try {
        plugins = JSON.parse(listed.stdout);
      } catch (error) {
        throw new Error('Claude returned invalid plugin-list JSON.', {cause: error});
      }
      const installed = Array.isArray(plugins)
        ? plugins.find(
          (plugin) =>
            plugin !== null &&
            typeof plugin === 'object' &&
            typeof plugin.id === 'string' &&
            plugin.id === 'stripe@claude-plugins-official',
        )
        : undefined;
      if (
        !Array.isArray(plugins) ||
        plugins.length !== 1 ||
        typeof installed?.version !== 'string' ||
        installed.version.length === 0 ||
        installed.enabled !== true ||
        receipt.plugin !== 'stripe@claude-plugins-official' ||
        receipt.marketplace !== 'anthropics/claude-plugins-official' ||
        !/^[a-f0-9]{40}$/.test(receipt.marketplace_commit) ||
        receipt.native_plugin_id !== installed.id ||
        receipt.version !== installed.version ||
        !/^sha256:[a-f0-9]{64}$/.test(receipt.installed_tree.sha256) ||
        installed.installPath !== `${CLAUDE_PLUGIN_STATE_PATH}/cache/claude-plugins-official/stripe/${installed.version}`
      ) {
        throw new Error('Claude did not load the latest plugin from native user settings.');
      }
      const mutation = await prepared.commands.agent.run(
        [
          'node', '-e', `
            const fs = require('node:fs');
            const path = require('node:path');
            const [root, settingsPath, dataRoot, pluginId] = process.argv.slice(1);
            const pluginFile = path.join(root, '.claude-plugin', 'plugin.json');
            const original = fs.readFileSync(pluginFile, 'utf8');
            fs.appendFileSync(pluginFile, '\\n');
            if (fs.readFileSync(pluginFile, 'utf8') !== original + '\\n') {
              throw new Error('Plugin file mutation was not retained.');
            }
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (settings.enabledPlugins[pluginId] !== true) {
              throw new Error('Native installation did not enable the plugin.');
            }
            settings.enabledPlugins[pluginId] = false;
            fs.writeFileSync(settingsPath, JSON.stringify(settings));
            fs.mkdirSync(dataRoot, {recursive: true});
            fs.writeFileSync(path.join(dataRoot, 'conformance-data-write'), 'writable');
          `,
          installed.installPath,
          `${prepared.paths.home}/.claude/settings.json`,
          `${CLAUDE_PLUGIN_STATE_PATH}/data`,
          installed.id,
        ],
        {
          signal: executionSignal,
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      );
      if (mutation.exitCode !== 0) {
        throw new Error('Claude plugin files, settings, or hook data were not writable.');
      }
      const changedList = await prepared.commands.agent.run(
        ['claude', 'plugin', 'list', '--json'],
        {signal: executionSignal, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024},
      );
      if (
        changedList.exitCode !== 0 ||
        !JSON.parse(changedList.stdout).some((plugin) =>
          plugin.id === installed.id && plugin.enabled === false)
      ) {
        throw new Error('Claude did not honor the changed native plugin settings.');
      }
      const sealed = await prepared.quiesce();
      const dataFile = await sealed.stateDirectories.get(CLAUDE_PLUGIN_STATE_ID)
        ?.readFile('data/conformance-data-write', {maxBytes: 64});
      if (dataFile === undefined || Buffer.from(dataFile).toString('utf8') !== 'writable') {
        throw new Error('Claude plugin hook data was not retained until quiescence.');
      }
      return Object.freeze({
        valid: true,
        run_id: runId,
        plugin: 'stripe@claude-plugins-official',
        version: installed.version,
        marketplace_commit: receipt.marketplace_commit,
        initial_installed_tree_sha256: receipt.installed_tree.sha256,
        plugin_files_writable: true,
        native_settings_writable: true,
        plugin_data_writable: true,
        container_preserved_after_setup: true,
      });
    } finally {
      await prepared?.dispose();
    }
  }

  async function runDockerConformance(runtime, runId, executionSignal) {
    return checked(runId, async () => {
      const [dataset, experiment] = await Promise.all([
        loadDataset(path.join(repositoryRoot, 'examples', 'quickstart', 'dataset')),
        loadExperimentConfig(
          path.join(repositoryRoot, 'examples', 'quickstart', 'experiment.yaml'),
        ),
      ]);
      const selection = expandExperiment(experiment)[0];
      if (selection === undefined) {
        throw new Error('The quickstart experiment config contains no run selection.');
      }
      const plan = resolveRunPlan({dataset, experiment, selection});
      let imageId;
      const report = await assertRuntimeAdapterConforms(
        {
          ...runtime,
          async prepare(input) {
            const prepared = await runtime.prepare(input);
            return Object.freeze({
              ...prepared,
              async quiesce() {
                const sealed = await prepared.quiesce();
                imageId = sealed.metadata.imageId;
                return sealed;
              },
            });
          },
        },
        {
          runId,
          plan,
          environment: {variables: {}, credentials: {}},
          requirements: {executables: [], stateDirectories: []},
          signal: executionSignal,
        },
        {
          probePath: '.forge-conformance/live-e2e.bin',
          probeBody: Buffer.from('forge-live-e2e\n', 'utf8'),
          commandProbes: [{
            scope: 'uncredentialed',
            argv: [
              '/bin/sh',
              '-c',
              'printf %s "$1" > "$2" && chmod 0600 "$2" && mkdir -m 0700 "$3" && printf private > "$3/evidence"',
              'forge-filesystem-ownership-probe',
              'forge-live-e2e\n',
              '.forge-conformance/live-e2e.bin',
              '.forge-conformance/private',
            ],
          }],
        },
      );
      if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
        throw new Error('Docker conformance did not identify the executed image.');
      }
      return Object.freeze({
        valid: true,
        adapter: {id: runtime.id},
        platform: plan.runtime.platform,
        image_id: imageId,
        run_id: report.runtimeId,
        cleanup_and_idempotent_disposal_verified: true,
      });
    });
  }

  async function runSelection({
    label,
    example,
    datasetExample = example,
    agent = 'claude-code',
    model = MODEL,
    casePath,
    runId,
    compositionFactory,
    signal: executionSignal,
  }) {
    let stdout = '';
    let hadStderr = false;
    const exitCode = await runCli(
      [
        'run',
        '--experiment',
        path.join(repositoryRoot, 'examples', example, 'experiment.yaml'),
        '--case-file',
        path.join(
          repositoryRoot,
          'examples',
          datasetExample,
          'dataset',
          ...casePath,
        ),
        '--agent',
        agent,
        '--model',
        model,
        '--output',
        resultsRoot,
        '--run-id',
        runId,
      ],
      {
        cwd: repositoryRoot,
        signal: executionSignal,
        compositionFactory,
        stdout(text) {
          stdout += text;
        },
        stderr(text) {
          hadStderr = true;
          process.stderr.write(text);
        },
      },
    );
    if (exitCode !== 0) {
      throw new Error(
        `The live ${label} run failed with exit code ${exitCode}.${hadStderr ? ' See the preceding Forge diagnostic.' : ''
        }`,
      );
    }

    let summary;
    try {
      summary = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`The live ${label} run returned invalid JSON.`, {
        cause: error,
      });
    }
    if (
      summary === null ||
      typeof summary !== 'object' ||
      summary.completed !== 1 ||
      typeof summary.experiment_run_id !== 'string' ||
      typeof summary.location !== 'string'
    ) {
      throw new Error(`The live ${label} run returned an invalid summary.`);
    }
    return verifyCompletedRun(path.join(summary.location, 'runs', runId));
  }

}
