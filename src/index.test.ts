import {describe, it} from 'node:test';

import {expect} from '../test/support/expect.js';

import {
  JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_PROJECTION_VERSION,
  JUDGE_TRANSCRIPT_SOURCE,
  createArtifactStore,
  createJudgeTranscriptProjection,
  createSetupExecutor,
  credentialReference,
  evaluateRunEvidence,
  executeEval,
  parseInteractionArtifact,
  preflightEval,
  parseResolvedRunPlan,
  resolveManifestCaseIdFromFile,
  resolveRunPlan,
  type AgentAdapter,
  type ForgeComposition,
  type RuntimeAdapter,
} from './index.js';

describe('@stripe/forge package root', () => {
  it('exports the engine, wire model, persistence, and extension contracts', () => {
    expect(executeEval).toBeTypeOf('function');
    expect(preflightEval).toBeTypeOf('function');
    expect(parseInteractionArtifact).toBeTypeOf('function');
    expect(evaluateRunEvidence).toBeTypeOf('function');
    expect(resolveRunPlan).toBeTypeOf('function');
    expect(parseResolvedRunPlan).toBeTypeOf('function');
    expect(resolveManifestCaseIdFromFile).toBeTypeOf('function');
    expect(createArtifactStore).toBeTypeOf('function');
    expect(createSetupExecutor).toBeTypeOf('function');
    expect(credentialReference).toBeTypeOf('function');
    expect(createJudgeTranscriptProjection).toBeTypeOf('function');
    expect(JUDGE_TRANSCRIPT_SOURCE).toBe('trajectory.json');
    expect(JUDGE_TRANSCRIPT_PROJECTION_ID).toBe('forge-visible-atif-steps');
    expect(JUDGE_TRANSCRIPT_PROJECTION_VERSION).toBe(1);
    expect(JUDGE_TRANSCRIPT_EXCLUDED_FIELDS).toEqual([
      'reasoning_content',
      'reasoning_effort',
    ]);

    const acceptsPublicContracts = (
      _agent: AgentAdapter,
      _runtime: RuntimeAdapter,
      _composition: ForgeComposition,
    ): void => undefined;
    expect(acceptsPublicContracts).toBeTypeOf('function');
  });
});
