import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { parseAtifTrajectory } from '../atif/index.ts';
import {
  renderTrajectoryCaptureStatus,
  UNKNOWN_EVIDENCE_WARNINGS,
} from '../evaluation/criterionEvidence.ts';
import { EMPTY_JUDGE_TRANSCRIPT } from '../evaluation/judgeTranscript.ts';
import { parseResolvedRunPlan } from '../model/parse.ts';
import { parseJudgeEvidence, verifyCompletedRun } from '../results/index.ts';
import {
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../testing/index.ts';
import {
  ORIGINAL_JUDGMENT,
  runJudgedFixture,
  temporaryRoot,
} from './__tests__/judgedFixture.ts';
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

describe('regradeCompletedRun', () => {
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
      JSON.stringify({
        results: [{ index: 0, passed: false, explanation: 'Not shown.' }],
      }),
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

  it('records no method and no capture status for the default judge', async () => {
    const source = await fixture();
    const regrade = await regradeCompletedRun(
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
    );
    assert.ok(regrade);
    assert.equal(Object.hasOwn(regrade, 'judge_mode'), false);
    assert.equal(Object.hasOwn(regrade, 'judge_candidates'), false);
    assert.equal(Object.hasOwn(regrade.evaluation, 'evidence_warnings'), false);
  });

  it('judges a saved run by the selected method with the capture status it recorded', async () => {
    const source = await fixture();
    const original = await verifyCompletedRun(source.runLocation);
    const scripted = judge([SAMPLING_REPLY]);
    const regrade = await regradeCompletedRun(
      {
        location: source.runLocation,
        judge: { provider: 'anthropic', model: 'claude-opus-4-6' },
        judgeMethod: { mode: 'verbalized-sampling', candidates: 5 },
      },
      {
        completionProviders: new Map([['anthropic', scripted.provider]]),
        credentialResolver: createStaticCredentialResolver(),
      },
    );
    assert.ok(regrade);
    assert.equal(regrade.judge_mode, 'verbalized-sampling');
    assert.equal(regrade.judge_candidates, 5);
    const request = scripted.calls[0]!.request;
    assert.equal(request.maxTokens, 4096);
    assert.match(request.systemPrompt!, /Generate 5 candidate answers/);
    const criterion = regrade.evaluation.judging_criteria[0]!;
    assert.equal(criterion.passed, true);
    assert.equal(criterion.decision?.choice, 'met');
    assert.equal(criterion.evidence_warnings_ref, 'evaluation');
    // The status shown is the one recorded with the evaluation, and it comes
    // from the run's saved evidence: the fixture agent saved no native session.
    const warnings = regrade.evaluation.evidence_warnings!;
    assert.ok(
      warnings.some(
        ({ source, code }) =>
          source === 'trajectory' && code === 'source_unavailable',
      ),
    );
    assert.ok(
      request.systemPrompt!.includes(renderTrajectoryCaptureStatus(warnings)),
    );
    assert.deepEqual(regrade.evaluation.checks, original.result.evaluation.checks);
  });

  it('reproduces the request and evaluation of a run originally judged by sampling', async () => {
    const root = await temporaryRoot('forge-regrade-sampling-');
    roots.push(root);
    const source = await runJudgedFixture(root, {
      sampling: { candidates: 5, reply: SAMPLING_REPLY },
    });
    const original = await verifyCompletedRun(source.runLocation);
    const scripted = judge([SAMPLING_REPLY]);
    const regrade = await regradeCompletedRun(
      {
        location: source.runLocation,
        judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        judgeMethod: { mode: 'verbalized-sampling', candidates: 5 },
      },
      {
        completionProviders: new Map([['anthropic', scripted.provider]]),
        credentialResolver: createStaticCredentialResolver(),
      },
    );
    assert.ok(regrade);
    const { signal: _a, ...replayed } = scripted.calls[0]!.request;
    const { signal: _b, ...recorded } = source.originalJudgeRequests[0]!;
    assert.deepEqual(replayed, recorded);
    assert.deepEqual(regrade.evaluation, original.result.evaluation);
    // The source plan names the method; the saved original judge keeps only the model.
    assert.deepEqual(regrade.source.original_judge, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  describe('judgeInputFromSavedRun', () => {
    async function saved() {
      const source = await fixture();
      const read = async (name: string) =>
        JSON.parse(await fs.readFile(path.join(source.runLocation, name), 'utf8'));
      const original = await verifyCompletedRun(source.runLocation);
      return {
        plan: parseResolvedRunPlan(await read('plan.json')),
        trajectory: parseAtifTrajectory(await read('trajectory.json')),
        judgeEvidence: parseJudgeEvidence(await read('judge-evidence.json'), {
          forgeVersion: original.result.forge.version,
        }),
        evidence: original.result.evidence,
      };
    }

    it('judges code only when the original judge saw no transcript', async () => {
      const inputs = await saved();
      assert.notEqual(
        judgeInputFromSavedRun(inputs).transcript.transcriptJson,
        EMPTY_JUDGE_TRANSCRIPT.transcriptJson,
      );
      const omitted = {
        ...inputs,
        judgeEvidence: {
          ...inputs.judgeEvidence,
          transcript: {
            ...inputs.judgeEvidence.transcript,
            steps: [],
            omitted: 'judge_budget_exceeded' as const,
          },
        },
      };
      assert.deepEqual(
        judgeInputFromSavedRun(omitted).transcript,
        EMPTY_JUDGE_TRANSCRIPT,
      );
    });

    it('marks unrecorded trajectory completeness as unknown, not partial', async () => {
      const { evidence: _evidence, ...withoutEvidence } = await saved();
      const warnings = judgeInputFromSavedRun(withoutEvidence).evidenceWarnings!;
      assert.deepEqual(
        warnings.filter(({ source }) => source === 'trajectory'),
        [...UNKNOWN_EVIDENCE_WARNINGS],
      );
    });
  });
});

const SAMPLING_REPLY = JSON.stringify({
  answers: {
    criterion: {
      type: 'choice',
      candidates: [
        {
          reading: 'The sentence is present.',
          rationale: 'The conversation supplied the exact status sentence.',
          label: 'met',
          probability: 0.8,
        },
        {
          reading: 'A stricter reading.',
          rationale: 'The file contents were not shown.',
          label: 'insufficient_evidence',
          probability: 0.2,
        },
      ],
    },
  },
});
