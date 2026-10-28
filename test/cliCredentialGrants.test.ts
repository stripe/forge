import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  createDefaultCliComposition,
  type RunCliOptions,
  runCli,
} from '../src/cli.ts';
import { credentialReference } from '../src/contracts/credentials.ts';
import { createForgeEngine } from '../src/engine.ts';
import type { ExecuteEvalInput } from '../src/execution/execute.ts';
import { parseExperimentConfigYaml } from '../src/model/index.ts';
import { defineSetupActionBundle } from '../src/setup/index.ts';
import {
  createFakeRuntimeAdapter,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
} from '../src/testing/index.ts';

const temporaryDirectories: string[] = [];
const sharedReference = credentialReference('shared.token');

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('CLI credential grant scopes', () => {
  it('suggests a usable explicit grant for a custom host completion reference', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-custom-completion-'),
    );
    temporaryDirectories.push(root);
    await fs.cp(path.join(import.meta.dirname, 'fixtures', 'one-shot'), root, {
      recursive: true,
    });
    const experimentPath = path.join(root, 'experiment.yaml');
    const experiment = parseExperimentConfigYaml(
      await fs.readFile(experimentPath, 'utf8'),
    );
    await fs.writeFile(
      experimentPath,
      JSON.stringify({
        ...experiment,
        models: { judge: { provider: 'custom', model: 'judge-model' } },
      }),
    );
    await fs.writeFile(
      path.join(root, 'dataset', 'cases', 'examples', 'hello-file.case.yaml'),
      JSON.stringify({
        id: 'examples/hello-file',
        version: '0.1.0',
        task: 'Complete the task.',
        execution_mode: 'one_shot',
        setup: [],
        judging_criteria: ['Completes the requested task.'],
      }),
    );

    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter({ id: 'claude-code' });
    const completion = createScriptedCompletionProvider({
      id: 'custom',
      requirements: {
        credentials: {
          token: { reference: credentialReference('env:API_TOKEN') },
        },
      },
      responses: [
        JSON.stringify({
          results: [{ index: 0, passed: true, explanation: 'Task completed.' }],
        }),
      ],
    });
    let secretReads = 0;
    async function invoke(grants: readonly string[]) {
      let stderr = '';
      const exitCode = await runCli(
        [
          'run',
          '--experiment',
          experimentPath,
          ...grants.flatMap((grant) => ['--credential-env', grant]),
        ],
        {
          cwd: root,
          environment: {
            get API_TOKEN() {
              secretReads += 1;
              return 'custom-completion-key';
            },
          },
          compositionFactory: async (options) => ({
            ...(await createDefaultCliComposition(options)),
            runtime: runtime.adapter,
            agents: new Map([[agent.adapter.id, agent.adapter]]),
            completionProviders: new Map([
              [completion.provider.id, completion.provider],
            ]),
          }),
          stdout: () => undefined,
          stderr: (text) => {
            stderr += text;
          },
        },
      );
      return { exitCode, stderr };
    }

    let suggestedGrant: string | undefined;
    for (const grants of [[], ['API_TOKEN']]) {
      const missing = await invoke(grants);
      assert.equal(missing.exitCode, 1, missing.stderr);
      assert.equal(secretReads, 0);
      assert.equal(runtime.runs.length, 0);
      assert.equal(completion.calls.length, 0);
      suggestedGrant = /Add --credential-env (\S+)\./.exec(missing.stderr)?.[1];
      assert.equal(suggestedGrant, 'env:API_TOKEN=API_TOKEN', missing.stderr);
    }

    const authorized = await invoke([suggestedGrant!]);
    assert.equal(authorized.exitCode, 0, authorized.stderr);
    assert.ok(secretReads > 0);
    assert.equal(runtime.runs.length, 1);
    assert.deepEqual(runtime.runs[0]!.input.environment.credentials, {});
    assert.equal(completion.calls.length, 1);
    assert.equal(completion.calls[0]!.request.purpose, 'judge');
    assert.deepEqual(completion.calls[0]!.context.credentials, {
      token: 'custom-completion-key',
    });
  });

  it('does not authorize a different runtime name through a shared reference', async () => {
    for (const selection of [[], ['--case', 'case/second']]) {
      const fixture = await createFixture();
      const result = await fixture.invoke(['FIRST_TOKEN'], selection);

      assert.equal(result.exitCode, 1, result.stderr);
      assert.match(result.stderr, /--credential-env SECOND_TOKEN/);
      assert.equal(fixture.runtime.runs.length, selection.length === 0 ? 1 : 0);
      assert.equal(
        fixture.secretReads.filter((name) => name === 'FIRST_TOKEN').length,
        selection.length === 0 ? 1 : 0,
      );
      assert.ok(!fixture.secretReads.includes('SECOND_TOKEN'));
    }
  });

  it('does not retain a completed case grant when resuming a different name', async () => {
    const fixture = await createFixture();
    const initial = await fixture.invoke(['FIRST_TOKEN'], [], {
      execute: async (input) => {
        if (input.plan.selection.case_id === 'case/second') {
          throw new Error('Leave the second case pending.');
        }
        return fixture.execute(input);
      },
    });
    assert.equal(initial.exitCode, 1, initial.stderr);
    assert.equal(fixture.runtime.runs.length, 1);

    fixture.secretReads.length = 0;
    const resumed = await fixture.invoke(
      ['FIRST_TOKEN'],
      ['--resume', 'credential-grants'],
    );
    assert.equal(resumed.exitCode, 1, resumed.stderr);
    assert.match(resumed.stderr, /--credential-env SECOND_TOKEN/);
    assert.equal(JSON.parse(resumed.stdout).skipped, 1);
    assert.equal(fixture.runtime.runs.length, 1);
    assert.ok(!fixture.secretReads.includes('FIRST_TOKEN'));
    assert.ok(!fixture.secretReads.includes('SECOND_TOKEN'));

    const authorized = await fixture.invoke(
      ['SECOND_TOKEN'],
      ['--resume', 'credential-grants'],
    );
    assert.equal(authorized.exitCode, 0, authorized.stderr);
    assert.equal(JSON.parse(authorized.stdout).skipped, 1);
    assert.equal(fixture.runtime.runs.length, 2);
    assert.deepEqual(
      fixture.runtime.runs[1]!.input.environment.credentials.SECOND_TOKEN,
      { value: 'second-key', scopes: ['agent'] },
    );
  });

  it('allows two bare grants to use different host values for one reference', async () => {
    const fixture = await createFixture(['first', 'second', 'both']);
    const result = await fixture.invoke(['FIRST_TOKEN', 'SECOND_TOKEN']);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      fixture.runtime.runs.map((run) => run.input.environment.credentials),
      [
        {
          OPENAI_API_KEY: { value: 'agent-key', scopes: ['agent'] },
          FIRST_TOKEN: { value: 'first-key', scopes: ['agent'] },
        },
        {
          OPENAI_API_KEY: { value: 'agent-key', scopes: ['agent'] },
          SECOND_TOKEN: { value: 'second-key', scopes: ['agent'] },
        },
        {
          OPENAI_API_KEY: { value: 'agent-key', scopes: ['agent'] },
          FIRST_TOKEN: { value: 'first-key', scopes: ['agent'] },
          SECOND_TOKEN: { value: 'second-key', scopes: ['agent'] },
        },
      ],
    );
  });

  it('requires the declared purpose and runtime name for execution source identities', async () => {
    const fixture = await createFixture(['first']);
    let inspected = false;
    const result = await fixture.invoke(['FIRST_TOKEN'], [], {
      execute: async (input) => {
        const resolver = input.composition.credentialResolver;
        assert.equal(
          resolver.sourceIdentity?.(sharedReference, {
            phase: 'execution',
            environmentName: 'FIRST_TOKEN',
            purpose: 'forge-eval:FIRST_TOKEN',
          }),
          'FIRST_TOKEN',
        );
        for (const context of [
          {
            environmentName: 'SECOND_TOKEN',
            purpose: 'forge-eval:FIRST_TOKEN',
          },
          { environmentName: 'FIRST_TOKEN', purpose: 'judge' },
          {
            environmentName: 'SECOND_TOKEN',
            purpose: 'forge-eval:SECOND_TOKEN',
          },
        ]) {
          assert.equal(
            resolver.sourceIdentity?.(sharedReference, {
              ...context,
              phase: 'execution',
            }),
            undefined,
          );
        }
        for (const purpose of ['judge', 'forge-eval:SECOND_TOKEN']) {
          await assert.rejects(
            resolver.resolve(sharedReference, {
              runId: input.runId,
              purpose,
              signal: input.signal ?? new AbortController().signal,
            }),
            /No environment binding exists/,
          );
        }

        const alias = credentialReference('env:FIRST_TOKEN');
        const context = {
          environmentName: 'FIRST_TOKEN',
          purpose: 'forge-eval:FIRST_TOKEN',
        };
        assert.equal(
          resolver.sourceIdentity?.(alias, { ...context, phase: 'preflight' }),
          'FIRST_TOKEN',
        );
        assert.equal(
          resolver.sourceIdentity?.(alias, { ...context, phase: 'execution' }),
          undefined,
        );
        await assert.rejects(
          resolver.resolve(alias, {
            runId: input.runId,
            purpose: context.purpose,
            signal: input.signal ?? new AbortController().signal,
          }),
          /No environment binding exists/,
        );
        assert.deepEqual(fixture.secretReads, []);
        inspected = true;
        return fixture.execute(input);
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(inspected, true);
    assert.equal(fixture.runtime.runs.length, 1);
  });

  it('keeps explicit reference grants valid across runtime names and purposes', async () => {
    const fixture = await createFixture();
    const result = await fixture.invoke(['shared.token=HOST_TOKEN'], [], {
      execute: async (input) => {
        const resolver = input.composition.credentialResolver;
        assert.equal(
          resolver.sourceIdentity?.(sharedReference, {
            phase: 'execution',
            environmentName: 'ANOTHER_TOKEN',
            purpose: 'judge',
          }),
          'HOST_TOKEN',
        );
        assert.equal(
          await resolver.resolve(sharedReference, {
            runId: input.runId,
            purpose: 'judge',
            signal: input.signal ?? new AbortController().signal,
          }),
          'explicit-key',
        );
        return fixture.execute(input);
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      fixture.runtime.runs.map(
        (run, index) =>
          run.input.environment.credentials[
            index === 0 ? 'FIRST_TOKEN' : 'SECOND_TOKEN'
          ],
      ),
      [
        { value: 'explicit-key', scopes: ['agent'] },
        { value: 'explicit-key', scopes: ['agent'] },
      ],
    );
  });
});

async function createFixture(
  cases: readonly ('first' | 'second' | 'both')[] = ['first', 'second'],
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-credential-grants-'),
  );
  temporaryDirectories.push(root);
  const bundle = defineSetupActionBundle({
    manifest: {
      namespace: 'acme-evals',
      version: '1.0.0',
      sha256: `sha256:${'a'.repeat(64)}`,
    },
    actions: ['FIRST_TOKEN', 'SECOND_TOKEN'].map((name, index) => ({
      uses: `acme-evals/credential-${index}`,
      parseWith: () => ({}),
      preflight: () => ({
        requirements: {
          credentials: { agent: { [name]: { reference: sharedReference } } },
        },
        async apply() {},
      }),
    })),
  });
  const engine = createForgeEngine({ setupActionBundles: [bundle] });
  const datasetRoot = path.join(root, 'dataset');
  await fs.mkdir(path.join(datasetRoot, 'cases'), { recursive: true });
  for (const name of cases) {
    const actions =
      name === 'both'
        ? bundle.actions
        : [bundle.actions[name === 'first' ? 0 : 1]!];
    await fs.writeFile(
      path.join(datasetRoot, 'cases', `${name}.case.yaml`),
      JSON.stringify({
        id: `case/${name}`,
        version: '1.0.0',
        task: 'Complete the task.',
        execution_mode: 'one_shot',
        setup: actions.map(({ uses }) => ({ uses, with: {} })),
        judging_criteria: [],
      }),
    );
  }
  await fs.writeFile(
    path.join(datasetRoot, 'manifest.json'),
    JSON.stringify({
      dataset: { id: 'credential-grants', version: '1.0.0' },
      cases: cases.map((name) => ({
        id: `case/${name}`,
        version: '1.0.0',
        path: `cases/${name}.case.yaml`,
      })),
    }),
  );
  const experimentPath = path.join(root, 'experiment.yaml');
  await fs.writeFile(
    experimentPath,
    JSON.stringify({
      id: 'experiment/credential-grants',
      version: '1.0.0',
      forge: { action_bundles: [bundle.manifest] },
      dataset: { path: './dataset', id: 'credential-grants', version: '1.0.0' },
      runtime: {
        adapter: 'docker',
        image: { kind: 'forge' },
        platform: 'linux/amd64',
        resources: {
          memory_bytes: 4294967296,
          cpu_count: 2,
          process_count: 512,
        },
      },
      models: {},
      treatments: { baseline: { setup: [] } },
      matrix: {
        cases: cases.map((name) => `cases/${name}.case.yaml`),
        treatments: ['baseline'],
        agents: [{ adapter: 'codex', provider: 'openai', model: 'gpt-5.4' }],
        repetitions: 1,
        retries: 0,
      },
      limits: { run_timeout_ms: 1800000 },
    }),
  );
  const runtime = createFakeRuntimeAdapter();
  const secretReads: string[] = [];
  const values = {
    OPENAI_API_KEY: 'agent-key',
    FIRST_TOKEN: 'first-key',
    SECOND_TOKEN: 'second-key',
    HOST_TOKEN: 'explicit-key',
  };
  const environment = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      {
        enumerable: true,
        get() {
          secretReads.push(name);
          return value;
        },
      },
    ]),
  );
  async function execute(input: ExecuteEvalInput) {
    const selection = input.plan.selection.agent;
    const builtin = input.composition.agents.get(selection.adapter)!;
    const scripted = createScriptedAgentAdapter({
      id: selection.adapter,
      requirements: builtin.requirements(selection),
    });
    return engine.executeEval({
      ...input,
      composition: {
        ...input.composition,
        runtime: runtime.adapter,
        agents: new Map([[scripted.adapter.id, scripted.adapter]]),
      },
    });
  }
  return {
    runtime,
    secretReads,
    execute,
    async invoke(
      grants: readonly string[],
      selection: readonly string[] = [],
      options: RunCliOptions = {},
    ) {
      let stdout = '';
      let stderr = '';
      const exitCode = await runCli(
        [
          'run',
          '--experiment',
          experimentPath,
          '--credential-env',
          'OPENAI_API_KEY',
          ...grants.flatMap((grant) => ['--credential-env', grant]),
          ...selection,
        ],
        {
          cwd: root,
          engine,
          environment: Object.defineProperties({}, environment),
          experimentRunIdFactory: () => 'credential-grants',
          execute,
          ...options,
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );
      return { exitCode, stdout, stderr };
    },
  };
}
