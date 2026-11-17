import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  criterionEvidenceWarnings,
  renderTrajectoryCaptureStatus,
} from '../src/evaluation/criterionEvidence.ts';
import { executeEval } from '../src/execution/execute.ts';
import type { JudgeModelRefV1 } from '../src/model/types.ts';
import {
  createArtifactStore,
  type JudgeEvidenceV1,
  verifyCompletedRun,
} from '../src/results/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../src/testing/index.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const model = { provider: 'test-provider', model: 'test-model' };
const candidates = [
  { reading: 'Strict.', rationale: 'Strict reading fails.', label: 'not_met', probability: 0.4 },
  { reading: 'Lenient.', rationale: 'Lenient reading passes.', label: 'met', probability: 0.3 },
  { reading: 'Final code.', rationale: 'Code passes.', label: 'met', probability: 0.2 },
  { reading: 'Missing data.', rationale: 'Data is absent.', label: 'insufficient_evidence', probability: 0.05 },
  { reading: 'Visible behavior.', rationale: 'Behavior passes.', label: 'met', probability: 0.05 },
];

async function run(judge: JudgeModelRefV1, reply: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sampling-'));
  roots.push(root);
  const completion = createScriptedCompletionProvider({
    id: model.provider,
    responses: [JSON.stringify(reply)],
  });
  const agent = createScriptedAgentAdapter();
  const completed = await executeEval({
    runId: 'sampling-judge',
    plan: createTestResolvedRunPlan({ judgingCriteria: ['Answers.'], judge }),
    composition: {
      runtime: createFakeRuntimeAdapter().adapter,
      agents: new Map([[agent.adapter.id, agent.adapter]]),
      completionProviders: new Map([[completion.provider.id, completion.provider]]),
      credentialResolver: createStaticCredentialResolver(),
      inputProvider: createMemoryRunInputProvider(),
      artifactStore: createArtifactStore({ root }),
    },
  });
  return { completed, completion, verified: await verifyCompletedRun(completed.location) };
}

describe('experiment-selected verbalized-sampling judge', () => {
  it('executes, records the decision and capture status, and verifies the run', async () => {
    const judge: JudgeModelRefV1 = {
      ...model,
      mode: 'verbalized-sampling',
      candidates: 5,
    };
    const { completed, completion, verified } = await run(judge, {
      answers: { criterion: { type: 'choice', candidates } },
    });
    assert.deepEqual(verified.result, completed.result);
    const savedPlan = JSON.parse(
      await fs.readFile(path.join(completed.location, 'plan.json'), 'utf8'),
    );
    assert.deepEqual(savedPlan.evaluation.judge, judge);

    const request = completion.calls[0]!.request;
    assert.deepEqual(request.model, model);
    assert.equal(Object.hasOwn(request, 'temperature'), false);
    assert.equal(request.maxTokens, 4096);
    assert.match(request.systemPrompt!, /Generate 5 candidate answers/);

    const { evaluation, evidence } = verified.result;
    const criterion = evaluation.judging_criteria[0]!;
    assert.equal(criterion.passed, true);
    assert.equal(criterion.decision!.choice, 'met');
    assert.ok(Math.abs(criterion.decision!.probabilities.met - 0.55) < 1e-12);
    assert.equal(criterion.decision!.thresholded_outcome, 'insufficient_evidence');
    assert.deepEqual(criterion.decision!.candidates, candidates);
    assert.equal(criterion.explanation, 'Strict reading fails.');
    assert.equal(criterion.evidence_warnings_ref, 'evaluation');
    assert.equal(evaluation.score, 1);

    const judgeEvidence = JSON.parse(
      await fs.readFile(
        path.join(completed.location, 'judge-evidence.json'),
        'utf8',
      ),
    ) as JudgeEvidenceV1;
    const warnings = criterionEvidenceWarnings({
      trajectory: evidence,
      workspace: judgeEvidence.workspace,
    });
    assert.deepEqual(evaluation.evidence_warnings, warnings);
    assert.ok(
      request.systemPrompt!.includes(renderTrajectoryCaptureStatus(warnings)),
    );
  });

  it('keeps the default judge and its saved shape when no method is selected', async () => {
    const { completion, verified } = await run(model, criterionBoolean());
    const request = completion.calls[0]!.request;
    assert.equal(request.maxTokens, 1024);
    assert.doesNotMatch(request.systemPrompt!, /capture status/);
    const { evaluation } = verified.result;
    assert.equal(Object.hasOwn(evaluation, 'evidence_warnings'), false);
    assert.equal(Object.hasOwn(evaluation.judging_criteria[0]!, 'decision'), false);
  });
});

/** A pass/fail reply of the default judge. */
function criterionBoolean() {
  return { results: [{ index: 0, passed: true, explanation: 'Done.' }] };
}
