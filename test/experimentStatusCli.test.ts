import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { createTestResolvedRunPlan } from '../src/testing/index.ts';
import { FORGE_BUILD_IDENTITY } from '../src/version.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function invoke(args: string[], cwd?: string) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    ...(cwd === undefined ? {} : { cwd }),
    environment: {},
    compositionFactory: async () => {
      throw new Error('Status must not construct execution resources.');
    },
    detectDockerPlatform: async () => {
      throw new Error('Status must not query Docker.');
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('forge status', () => {
  it('prints text and canonical JSON for a saved run using only local files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-status-cli-'));
    roots.push(root);
    const run = path.join(root, 'example');
    await fs.mkdir(run);
    const file = path.join(run, 'experiment.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        forge: FORGE_BUILD_IDENTITY,
        experiment_run_id: 'example',
        entries: [
          {
            selection: createTestResolvedRunPlan().selection,
            plan_sha256: `sha256:${'a'.repeat(64)}`,
            attempts: [],
          },
        ],
      }),
    );
    const before = await fs.readFile(file);
    const result = await invoke(
      ['status', '--experiment-run', './example'],
      root,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      'Experiment run: example\nLiveness: no lock\nLast event: unavailable\nSelections: pending=1, running=0, completed=0, errored=0\nIn flight by agent model (checkpoint):\n  none\nFailures (all attempts):\n  none\n',
    );
    const json = await invoke(['status', '--experiment-run', run, '--json']);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stderr, '');
    assert.deepEqual(JSON.parse(json.stdout), {
      experiment_run_id: 'example',
      counts: { pending: 1, running: 0, completed: 0, errored: 0 },
      failures: [],
      in_flight: [],
      last_event_at: null,
      liveness: { state: 'no_lock', pid: null },
    });
    assert.equal(
      json.stdout,
      '{"counts":{"completed":0,"errored":0,"pending":1,"running":0},"experiment_run_id":"example","failures":[],"in_flight":[],"last_event_at":null,"liveness":{"pid":null,"state":"no_lock"}}\n',
    );
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(await fs.readdir(run), ['experiment.json']);
  });

  it('prints running models and full failure diagnostics as escaped text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-status-cli-'));
    roots.push(root);
    const { selection } = createTestResolvedRunPlan();
    await fs.writeFile(
      path.join(root, 'experiment.json'),
      JSON.stringify({
        forge: FORGE_BUILD_IDENTITY,
        experiment_run_id: path.basename(root),
        entries: [
          {
            selection,
            plan_sha256: `sha256:${'a'.repeat(64)}`,
            attempts: [
              {
                state: 'errored',
                run_id: 'failed',
                error_code: 'agent_failed',
                diagnostic: {
                  phase: 'interaction',
                  reason: 'timeout',
                  message: 'Agent stopped.\nNext line.',
                },
              },
              { state: 'running', run_id: 'retry' },
            ],
          },
        ],
      }),
    );
    const result = await invoke(['status', '--experiment-run', root]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      result.stdout.includes(
        `"model":${JSON.stringify(selection.agent.model)}`,
      ),
    );
    assert.match(result.stdout, /1 \["retry"\]/);
    assert.match(result.stdout, /"error_code":"agent_failed"/);
    assert.match(
      result.stdout,
      /"phase":"interaction","reason":"timeout","message":"Agent stopped.\\nNext line."/,
    );
  });

  it('rejects missing paths and unrelated options before reading, and reports unreadable runs', async () => {
    for (const args of [
      ['status'],
      ['status', '--experiment-run', ''],
      ['status', '--experiment-run', '/missing', '--jobs', '2'],
      ['status', '--experiment-run', '/missing', '--experiment', 'input.yaml'],
      ['status', '--experiment-run', '/missing', '--resume', 'example'],
      ['validate', '--json'],
    ]) {
      const result = await invoke(args);
      assert.equal(result.code, 2, JSON.stringify(result));
      assert.equal(result.stdout, '');
    }
    const result = await invoke(['status', '--experiment-run', '/missing']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /forge:/);
  });
});
