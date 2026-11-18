import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { runCli } from '../cli.ts';
import { createDirectoryRunInputProvider } from '../contracts/inputs.ts';
import { createArtifactStore } from '../results/index.ts';
import {
  createFakeRuntimeAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../testing/index.ts';
import {
  ORIGINAL_JUDGMENT,
  runJudgedFixture,
  temporaryRoot,
} from './__tests__/judgedFixture.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function invoke(argv: string[], responses: string[] = []) {
  const judge = createScriptedCompletionProvider({
    id: 'anthropic',
    responses,
  });
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    compositionFactory: async ({ datasetRoot, resultsRoot }) => ({
      runtime: createFakeRuntimeAdapter().adapter,
      agents: new Map(),
      completionProviders: new Map([['anthropic', judge.provider]]),
      credentialResolver: createStaticCredentialResolver(),
      inputProvider: await createDirectoryRunInputProvider(datasetRoot),
      artifactStore: createArtifactStore({ root: resultsRoot }),
    }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, judge };
}

describe('forge regrade', () => {
  it('regrades a saved experiment run and prints its summary', async () => {
    const root = await temporaryRoot('forge-regrade-cli-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regraded');
    const result = await invoke(
      [
        'regrade',
        '--experiment-run',
        source.experimentLocation,
        '--judge-provider',
        'anthropic',
        '--judge-model',
        'claude-opus-4-6',
        '--output',
        output,
        '--jobs',
        '2',
      ],
      [ORIGINAL_JUDGMENT],
    );
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.regraded, 1);
    assert.deepEqual(summary.judge, {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    });
    assert.equal(summary.report, path.join(output, 'report.json'));
    assert.match(result.stderr, /"state":"regraded"/);
    assert.equal(result.judge.calls[0]!.request.model.model, 'claude-opus-4-6');
  });

  it('rejects missing judge settings and options that regrade does not accept', async () => {
    const missing = await invoke([
      'regrade',
      '--experiment-run',
      '/nonexistent',
      '--judge-provider',
      'anthropic',
      '--output',
      '/tmp/x',
    ]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /regrade requires --judge-model/);
    const extra = await invoke([
      'regrade',
      '--experiment',
      'experiment.yaml',
      '--experiment-run',
      '/nonexistent',
    ]);
    assert.equal(extra.code, 2);
    assert.equal(extra.judge.calls.length, 0);
  });

  it('selects the judge method for a regrade and saves it', async () => {
    const root = await temporaryRoot('forge-regrade-cli-method-');
    roots.push(root);
    const source = await runJudgedFixture(root);
    const output = path.join(root, 'regraded');
    const result = await invoke(
      [
        'regrade',
        '--experiment-run',
        source.experimentLocation,
        '--judge-provider',
        'anthropic',
        '--judge-model',
        'claude-opus-4-6',
        '--judge-mode',
        'verbalized-sampling',
        '--judge-candidates',
        '3',
        '--output',
        output,
      ],
      [
        JSON.stringify({
          answers: {
            criterion: {
              type: 'choice',
              candidates: [
                {
                  reading: 'R.',
                  rationale: 'B.',
                  label: 'met',
                  probability: 1,
                },
              ],
            },
          },
        }),
      ],
    );
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.judge_mode, 'verbalized-sampling');
    assert.equal(summary.judge_candidates, 3);
    assert.match(
      result.judge.calls[0]!.request.systemPrompt!,
      /Generate 3 candidate answers/,
    );
  });

  it('rejects an unknown judge mode, a bad count, and a count without a mode', async () => {
    const base = [
      'regrade',
      '--experiment-run',
      '/nonexistent',
      '--judge-provider',
      'anthropic',
      '--judge-model',
      'm',
      '--output',
      '/tmp/x',
    ];
    for (const [extra, message] of [
      [
        ['--judge-mode', 'explained'],
        /--judge-mode must be one of: verbalized-sampling/,
      ],
      [
        ['--judge-mode', 'verbalized-sampling', '--judge-candidates', '11'],
        /--judge-candidates/,
      ],
      [
        ['--judge-mode', 'verbalized-sampling', '--judge-candidates', 'x'],
        /--judge-candidates/,
      ],
      [['--judge-candidates', '3'], /--judge-candidates requires --judge-mode/],
    ] as const) {
      const result = await invoke([...base, ...extra]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, message);
      assert.equal(result.judge.calls.length, 0);
    }
  });
});
