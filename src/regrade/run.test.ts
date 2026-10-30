import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { afterEach, describe, it } from 'vitest';
import { criterionJudgment } from '../../test/fixtures/criterionJudgment.ts';
import { verifyCompletedRun } from '../results/index.ts';
import {
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../testing/index.ts';
import {
  ORIGINAL_JUDGMENT,
  runJudgedFixture,
  temporaryRoot,
} from './__tests__/judgedFixture.ts';
import { parseAtifTrajectory } from '../atif/index.ts';
import { EMPTY_JUDGE_TRANSCRIPT } from '../evaluation/judgeTranscript.ts';
import { parseResolvedRunPlan } from '../model/index.ts';
import { parseJudgeEvidence } from '../results/parse.ts';
import {
  judgeInputFromSavedRun,
  REGRADE_RESULT_FORMAT,
  regradeCompletedRun,
} from './run.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await temporaryRoot('forge-regrade-run-');
  roots.push(root);
  return runJudgedFixture(root);
}

function judge(responses: string[]) {
  return createScriptedCompletionProvider({ id: 'anthropic', responses });
}

describe('judgeInputFromSavedRun', () => {
  it('regrades code-only runs with the empty transcript their judges saw', async () => {
    const source = await fixture();
    const read = async (name: string) =>
      JSON.parse(await fs.readFile(`${source.runLocation}/${name}`, 'utf8'));
    const result = await read('result.json');
    const plan = parseResolvedRunPlan(await read('plan.json'));
    const trajectory = parseAtifTrajectory(await read('trajectory.json'));
    const judgeEvidence = parseJudgeEvidence(
      await read('judge-evidence.json'),
      {
        forgeVersion: result.forge.version,
      },
    );
    const normal = judgeInputFromSavedRun({ plan, trajectory, judgeEvidence });
    assert.notEqual(
      normal.transcript.transcriptJson,
      EMPTY_JUDGE_TRANSCRIPT.transcriptJson,
    );
    const omitted = judgeInputFromSavedRun({
      plan,
      trajectory,
      judgeEvidence: {
        ...judgeEvidence,
        transcript: {
          ...judgeEvidence.transcript,
          steps: [],
          omitted: 'judge_budget_exceeded',
        },
      },
    });
    assert.deepEqual(omitted.transcript, EMPTY_JUDGE_TRANSCRIPT);
  });
});

describe('regradeCompletedRun', () => {
  it('records insufficient evidence with the same thresholds and saved warnings as execution', async () => {
    const source = await fixture();
    const original = await verifyCompletedRun(source.runLocation);
    const scripted = judge([
      JSON.stringify({
        answers: {
          criterion: {
            type: 'choice',
            choice: 'insufficient_evidence',
            probabilities: {
              met: 0.05,
              not_met: 0.05,
              insufficient_evidence: 0.9,
            },
            explanation: 'The required file content is not visible.',
          },
        },
      }),
    ]);
    const regrade = await regradeCompletedRun(
      {
        location: source.runLocation,
        judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      },
      {
        completionProviders: new Map([['anthropic', scripted.provider]]),
        credentialResolver: createStaticCredentialResolver(),
      },
    );
    const result = regrade!.evaluation.judging_criteria[0]!;
    assert.equal(result.passed, false);
    assert.equal(result.decision?.thresholded_outcome, 'insufficient_evidence');
    assert.deepEqual(result.decision?.thresholds, { minimum_probability: 0.8 });
    assert.deepEqual(
      regrade!.evaluation.evidence_warnings,
      original.result.evaluation.evidence_warnings,
    );
    assert.ok(
      regrade!.evaluation.evidence_warnings!.some(
        (warning) =>
          warning.source === 'workspace' &&
          warning.code === 'workspace_binary_omitted',
      ),
    );
    assert.ok(
      regrade!.evaluation.evidence_warnings!.some(
        (warning) =>
          warning.source === 'trajectory' && warning.code === 'fallback_used',
      ),
    );
    assert.equal(regrade!.evaluation.score, 0);
    assert.equal(regrade!.evaluation.judging_criteria_errored, 0);
  });

  it('sends the original judge request and reproduces the original evaluation', async () => {
    const source = await fixture();
    const original = await verifyCompletedRun(source.runLocation);
    const scripted = judge([ORIGINAL_JUDGMENT]);
    const regrade = await regradeCompletedRun(
      {
        location: source.runLocation,
        judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        now: () => new Date('2026-10-24T00:00:00.000Z'),
      },
      {
        completionProviders: new Map([['anthropic', scripted.provider]]),
        credentialResolver: createStaticCredentialResolver(),
      },
    );
    assert.ok(regrade);
    // Byte-identical prompt: same system prompt, messages, schema, and limits.
    assert.equal(scripted.calls.length, 1);
    const { signal: _a, ...replayed } = scripted.calls[0]!.request;
    const { signal: _b, ...recorded } = source.originalJudgeRequests[0]!;
    assert.deepEqual(replayed, recorded);
    assert.deepEqual(regrade.evaluation, original.result.evaluation);
    assert.equal(regrade.format, REGRADE_RESULT_FORMAT);
    assert.equal(regrade.run_id, 'regrade-source');
    assert.deepEqual(regrade.source.original_judge, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    assert.match(regrade.source.result_sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(regrade.completion_calls.length, 1);
    assert.equal(regrade.completion_calls[0]!.purpose, 'judge');
    assert.equal(regrade.regraded_at, '2026-10-24T00:00:00.000Z');
  });

  it('applies a different judge verdict and keeps the original check results', async () => {
    const source = await fixture();
    const original = await verifyCompletedRun(source.runLocation);
    const scripted = judge([
      JSON.stringify(criterionJudgment(false, 'Not shown.')),
    ]);
    const regrade = await regradeCompletedRun(
      {
        location: source.runLocation,
        judge: { provider: 'anthropic', model: 'claude-opus-4-6' },
      },
      {
        completionProviders: new Map([['anthropic', scripted.provider]]),
        credentialResolver: createStaticCredentialResolver(),
      },
    );
    assert.ok(regrade);
    assert.equal(scripted.calls[0]!.request.model.model, 'claude-opus-4-6');
    assert.equal(regrade.completion_calls[0]!.model, 'claude-opus-4-6');
    assert.equal(regrade.evaluation.judging_criteria_passed, 0);
    assert.equal(regrade.evaluation.score, 0);
    assert.deepEqual(
      regrade.evaluation.checks,
      original.result.evaluation.checks,
    );
    assert.equal(regrade.source.original_evaluation.status, 'passed');
    assert.equal(
      (await verifyCompletedRun(source.runLocation)).result.evaluation.score,
      1,
      'the committed run is unchanged',
    );
  });

  it('records judge failures as judge_error without throwing', async () => {
    const source = await fixture();
    const scripted = judge(['not json', 'not json', 'not json']);
    const regrade = await regradeCompletedRun(
      {
        location: source.runLocation,
        judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        waitBeforeJudgeRetry: async () => {},
      },
      {
        completionProviders: new Map([['anthropic', scripted.provider]]),
        credentialResolver: createStaticCredentialResolver(),
      },
    );
    assert.ok(regrade);
    assert.equal(scripted.calls.length, 3, 'three judge attempts');
    assert.equal(regrade.evaluation.status, 'judge_error');
    assert.equal(regrade.evaluation.judging_criteria_errored, 1);
  });

  it('rejects a judge provider that is not registered before any call', async () => {
    const source = await fixture();
    await assert.rejects(
      regradeCompletedRun(
        {
          location: source.runLocation,
          judge: { provider: 'missing', model: 'x' },
        },
        {
          completionProviders: new Map(),
          credentialResolver: createStaticCredentialResolver(),
        },
      ),
      /No completion provider is registered for missing/,
    );
  });

  it('refuses a run whose artifacts no longer verify', async () => {
    const source = await fixture();
    await fs.appendFile(`${source.runLocation}/plan.json`, ' ');
    await assert.rejects(
      regradeCompletedRun(
        {
          location: source.runLocation,
          judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        },
        {
          completionProviders: new Map([
            ['anthropic', judge([ORIGINAL_JUDGMENT]).provider],
          ]),
          credentialResolver: createStaticCredentialResolver(),
        },
      ),
      /Artifact (does not match its descriptor|is unsafe or exceeds its declared size)/,
    );
  });
});
