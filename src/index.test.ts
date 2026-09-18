import {describe, it} from 'node:test';

import {expect} from '../test/support/expect.js';

import {
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_PROJECTION_VERSION,
  JUDGE_TRANSCRIPT_SOURCE,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  MAX_GUIDELINE_JUDGE_PROMPT_BYTES,
  MAX_JUDGE_TRANSCRIPT_BYTES,
  createArtifactStore,
  createJudgeTranscriptProjection,
  createSetupExecutor,
  credentialReference,
  evaluateRunEvidence,
  executeEval,
  firstPartySetupHandlers,
  parseInteractionArtifact,
  parseJudgeTranscriptProjection,
  preflightEval,
  parseResolvedRunPlan,
  resolveManifestCaseIdFromFile,
  resolveRunPlan,
  type AgentAdapter,
  type ForgeComposition,
  type RuntimeAdapter,
} from './index.js';

describe('@stripe/forge package root', () => {
  it('exports the engine, wire model, persistence, and composition contracts', () => {
    expect(executeEval).toBeTypeOf('function');
    expect(preflightEval).toBeTypeOf('function');
    expect(parseInteractionArtifact).toBeTypeOf('function');
    expect(evaluateRunEvidence).toBeTypeOf('function');
    expect(resolveRunPlan).toBeTypeOf('function');
    expect(parseResolvedRunPlan).toBeTypeOf('function');
    expect(resolveManifestCaseIdFromFile).toBeTypeOf('function');
    expect(createArtifactStore).toBeTypeOf('function');
    expect(createSetupExecutor).toBeTypeOf('function');
    expect([...firstPartySetupHandlers.keys()].sort()).toEqual([
      'forge/command@1',
      'forge/write@1',
    ]);
    expect(credentialReference).toBeTypeOf('function');
    expect(createJudgeTranscriptProjection).toBeTypeOf('function');
    expect(parseJudgeTranscriptProjection).toBeTypeOf('function');
    expect(JUDGE_TRANSCRIPT_SOURCE).toBe('trajectory.json');
    expect(JUDGE_TRANSCRIPT_PROJECTION_ID).toBe('forge-visible-atif-steps');
    expect(JUDGE_TRANSCRIPT_PROJECTION_VERSION).toBe(1);
    expect(JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE).toBe('root');
    expect(JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES).toEqual(['user', 'agent']);
    expect(JUDGE_TRANSCRIPT_COPIED_CONTEXT).toBe('excluded');
    expect(MAX_JUDGE_TRANSCRIPT_BYTES).toBe(768 * 1024);
    expect(MAX_GUIDELINE_JUDGE_PROMPT_BYTES).toBe(1024 * 1024);
    expect(JUDGE_TRANSCRIPT_INCLUDED_FIELDS).toEqual([
      'step_id',
      'source',
      'message',
      'tool_calls[].tool_call_id',
      'tool_calls[].function_name',
      'tool_calls[].arguments',
      'observation.results[].source_call_id',
      'observation.results[].content',
      'observation.results[].is_error',
    ]);

    const acceptsPublicContracts = (
      _agent: AgentAdapter,
      _runtime: RuntimeAdapter,
      _composition: ForgeComposition,
    ): void => undefined;
    expect(acceptsPublicContracts).toBeTypeOf('function');
  });
});
