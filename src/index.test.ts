import {describe, it} from 'node:test';

import {expect} from '../test/support/expect.js';
import * as rootExports from './index.js';

import {
  FORGE_VERSION,
  RESOLVED_RUN_PLAN_SCHEMA_VERSION,
  RUN_RESULT_SCHEMA_VERSION,
  SETUP_ARTIFACT_SCHEMA_VERSION,
  WORKSPACE_EVIDENCE_SCHEMA_VERSION,
  JUDGE_EVIDENCE_SCHEMA_VERSION,
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
  createForgeEngine,
  createJudgeTranscriptProjection,
  createSetupExecutor,
  defineSetupActionBundle,
  credentialReference,
  evaluateRunEvidence,
  executeEval,
  firstPartySetupHandlers,
  normalizeEnvironmentSpecification,
  parseAgentPluginInstallationReceipt,
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseJudgeTranscriptProjection,
  parseSetupArtifact,
  preflightEval,
  parseResolvedRunPlan,
  resolveManifestCaseIdFromFile,
  resolveRunPlan,
  type AgentAdapter,
  type ForgeComposition,
  type ForgeExternalRuntimeV1,
  type JudgeEvidenceV1,
  type RuntimeAdapter,
  type RuntimePreflight,
} from './index.js';

describe('@stripe/forge package root', () => {
  it('keeps campaign orchestration on its documented subpath', () => {
    expect('runCampaign' in rootExports).toBe(false);
    expect('readCampaignSelections' in rootExports).toBe(false);
    expect('inspectCampaign' in rootExports).toBe(false);
    expect('runCampaignCommand' in rootExports).toBe(false);
  });

  it('exports the engine, wire model, persistence, and composition contracts', () => {
    expect(FORGE_VERSION).toBeTypeOf('string');
    expect(RESOLVED_RUN_PLAN_SCHEMA_VERSION).toBe(1);
    expect(RUN_RESULT_SCHEMA_VERSION).toBe(1);
    expect(SETUP_ARTIFACT_SCHEMA_VERSION).toBe(1);
    expect(WORKSPACE_EVIDENCE_SCHEMA_VERSION).toBe(1);
    expect(executeEval).toBeTypeOf('function');
    expect(preflightEval).toBeTypeOf('function');
    expect(parseInteractionArtifact).toBeTypeOf('function');
    expect(parseJudgeEvidence).toBeTypeOf('function');
    expect(JUDGE_EVIDENCE_SCHEMA_VERSION).toBe(1);
    expect(parseSetupArtifact).toBeTypeOf('function');
    expect(parseAgentPluginInstallationReceipt).toBeTypeOf('function');
    expect(evaluateRunEvidence).toBeTypeOf('function');
    expect(resolveRunPlan).toBeTypeOf('function');
    expect(parseResolvedRunPlan).toBeTypeOf('function');
    expect(resolveManifestCaseIdFromFile).toBeTypeOf('function');
    expect(createArtifactStore).toBeTypeOf('function');
    expect(createForgeEngine).toBeTypeOf('function');
    expect(createSetupExecutor).toBeTypeOf('function');
    expect(defineSetupActionBundle).toBeTypeOf('function');
    expect([...firstPartySetupHandlers.keys()].sort()).toEqual([
      'forge/command',
      'forge/plugin',
      'forge/write',
    ]);
    expect(credentialReference).toBeTypeOf('function');
    expect(normalizeEnvironmentSpecification).toBeTypeOf('function');
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
      _judgeEvidence: JudgeEvidenceV1,
      _externalRuntime: ForgeExternalRuntimeV1,
      _runtimePreflight: RuntimePreflight,
    ): void => undefined;
    expect(acceptsPublicContracts).toBeTypeOf('function');
  });
});
