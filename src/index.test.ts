import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

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
    assert.equal('runCampaign' in rootExports, false);
    assert.equal('readCampaignSelections' in rootExports, false);
    assert.equal('inspectCampaign' in rootExports, false);
    assert.equal('runCampaignCommand' in rootExports, false);
    assert.equal('parseCampaignReport' in rootExports, false);
    assert.equal('CAMPAIGN_REPORT_SCHEMA_VERSION' in rootExports, false);
    assert.equal('CampaignReportError' in rootExports, false);
  });

  it('exports the engine, wire model, persistence, and composition contracts', () => {
    assert.equal(typeof (FORGE_VERSION), 'string');
    assert.equal(RESOLVED_RUN_PLAN_SCHEMA_VERSION, 1);
    assert.equal(RUN_RESULT_SCHEMA_VERSION, 1);
    assert.equal(SETUP_ARTIFACT_SCHEMA_VERSION, 1);
    assert.equal(WORKSPACE_EVIDENCE_SCHEMA_VERSION, 1);
    assert.equal(typeof (executeEval), 'function');
    assert.equal(typeof (preflightEval), 'function');
    assert.equal(typeof (parseInteractionArtifact), 'function');
    assert.equal(typeof (parseJudgeEvidence), 'function');
    assert.equal(JUDGE_EVIDENCE_SCHEMA_VERSION, 1);
    assert.equal(typeof (parseSetupArtifact), 'function');
    assert.equal(typeof (parseAgentPluginInstallationReceipt), 'function');
    assert.equal(typeof (evaluateRunEvidence), 'function');
    assert.equal(typeof (resolveRunPlan), 'function');
    assert.equal(typeof (parseResolvedRunPlan), 'function');
    assert.equal(typeof (resolveManifestCaseIdFromFile), 'function');
    assert.equal(typeof (createArtifactStore), 'function');
    assert.equal(typeof (createForgeEngine), 'function');
    assert.equal(typeof (createSetupExecutor), 'function');
    assert.equal(typeof (defineSetupActionBundle), 'function');
    assert.deepEqual([...firstPartySetupHandlers.keys()].sort(), [
      'forge/command',
      'forge/plugin',
      'forge/write',
    ]);
    assert.equal(typeof (credentialReference), 'function');
    assert.equal(typeof (normalizeEnvironmentSpecification), 'function');
    assert.equal(typeof (createJudgeTranscriptProjection), 'function');
    assert.equal(typeof (parseJudgeTranscriptProjection), 'function');
    assert.equal(JUDGE_TRANSCRIPT_SOURCE, 'trajectory.json');
    assert.equal(JUDGE_TRANSCRIPT_PROJECTION_ID, 'forge-visible-atif-steps');
    assert.equal(JUDGE_TRANSCRIPT_PROJECTION_VERSION, 1);
    assert.equal(JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE, 'root');
    assert.deepEqual(JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES, ['user', 'agent']);
    assert.equal(JUDGE_TRANSCRIPT_COPIED_CONTEXT, 'excluded');
    assert.equal(MAX_JUDGE_TRANSCRIPT_BYTES, 768 * 1024);
    assert.equal(MAX_GUIDELINE_JUDGE_PROMPT_BYTES, 1024 * 1024);
    assert.deepEqual(JUDGE_TRANSCRIPT_INCLUDED_FIELDS, [
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
  });
});
