import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import * as rootExports from './index.js';

import {
  FORGE_VERSION,
  FORGE_BUILD_IDENTITY,
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_SOURCE,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
  MAX_JUDGE_TRANSCRIPT_BYTES,
  createArtifactStore,
  createForgeEngine,
  createJudgeTranscriptProjection,
  createSetupExecutor,
  defineSetupActionBundle,
  credentialReference,
  evaluateRunEvidence,
  criterionResultMatchesDefinition,
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
  it('keeps experiment run orchestration on its documented subpath', () => {
    assert.equal('runExperiment' in rootExports, false);
    assert.equal('readExperimentRunSelections' in rootExports, false);
    assert.equal('inspectExperimentRun' in rootExports, false);
    assert.equal('runExperimentCommand' in rootExports, false);
    assert.equal('parseExperimentRunReport' in rootExports, false);
    assert.equal('EXPERIMENT_RUN_REPORT_SCHEMA_VERSION' in rootExports, false);
    assert.equal('ExperimentRunReportError' in rootExports, false);
  });

  it('exports the engine, wire model, persistence, and composition contracts', () => {
    for (const removed of ['BENCHMARK_SCHEMA_VERSION', 'RESOLVED_RUN_PLAN_SCHEMA_VERSION', 'RUN_RESULT_SCHEMA_VERSION', 'SETUP_ARTIFACT_SCHEMA_VERSION', 'INTERACTION_SCHEMA_VERSION', 'WORKSPACE_EVIDENCE_SCHEMA_VERSION', 'JUDGE_EVIDENCE_SCHEMA_VERSION', 'EVALUATION_SCHEMA_VERSION', 'CRITERION_JUDGE_PROMPT_VERSION', 'JUDGE_TRANSCRIPT_PROJECTION_VERSION', 'JUDGE_WORKSPACE_EVIDENCE_SCHEMA_VERSION']) {
      assert.equal(removed in rootExports, false);
    }
    assert.equal(typeof (FORGE_VERSION), 'string');
    assert.equal(FORGE_BUILD_IDENTITY.version, FORGE_VERSION);
    assert.equal(Object.isFrozen(FORGE_BUILD_IDENTITY), true);
    assert.equal(typeof criterionResultMatchesDefinition, 'function');
    assert.equal(typeof (executeEval), 'function');
    assert.equal(typeof (preflightEval), 'function');
    assert.equal(typeof (parseInteractionArtifact), 'function');
    assert.equal(typeof (parseJudgeEvidence), 'function');
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
    assert.equal(JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE, 'root');
    assert.deepEqual(JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES, ['user', 'agent']);
    assert.equal(JUDGE_TRANSCRIPT_COPIED_CONTEXT, 'excluded');
    assert.equal(MAX_JUDGE_TRANSCRIPT_BYTES, 768 * 1024);
    assert.equal(MAX_CRITERION_JUDGE_PROMPT_BYTES, 1024 * 1024);
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
