import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import * as rootExports from './index.ts';

import {
  type AgentAdapter,
  createArtifactStore,
  createForgeEngine,
  createJudgeTranscriptProjection,
  createSetupExecutor,
  credentialReference,
  credentialsSetupHandler,
  criterionResultMatchesDefinition,
  defineSetupActionBundle,
  evaluateRunEvidence,
  executeEval,
  FORGE_BUILD_IDENTITY,
  FORGE_VERSION,
  type ForgeComposition,
  type ForgeExternalRuntimeV1,
  firstPartySetupHandlers,
  JUDGE_TRANSCRIPT_COPIED_CONTEXT,
  JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_SOURCE,
  JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  type JudgeEvidenceV1,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
  normalizeEnvironmentSpecification,
  parseAgentPluginInstallationReceipt,
  parseInteractionArtifact,
  parseJudgeEvidence,
  parseJudgeTranscriptProjection,
  parseResolvedRunPlan,
  parseSetupArtifact,
  preflightEval,
  type RuntimeAdapter,
  type RuntimePreflight,
  resolveManifestCaseIdFromFile,
  resolveRunPlan,
  selectJudgeEvidence,
} from './index.ts';

describe('@stripe/forge package root', () => {
  it('keeps image extensions on the Docker subpath', async () => {
    assert.equal('defineDockerImageExtension' in rootExports, false);
    const docker = await import('./runtime/docker/index.ts');
    assert.equal(typeof docker.defineDockerImageExtension, 'function');
  });
  it('keeps the OpenAI provider on its documented implementation subpath', async () => {
    assert.equal('createOpenAICompletionProvider' in rootExports, false);
    const openai = await import('./providers/openai/index.ts');
    assert.equal(typeof openai.createOpenAICompletionProvider, 'function');
    assert.equal(
      openai.createOpenAICompletionProvider().version,
      FORGE_VERSION,
    );
  });

  it('keeps OpenCode on its documented implementation subpath', async () => {
    assert.equal('createOpenCodeAdapter' in rootExports, false);
    const opencode = await import('./agents/opencode/index.js');
    assert.deepEqual(
      Object.keys(opencode).sort(),
      [
        'OPENCODE_STATE_ID',
        'OpenCodeStreamError',
        'createOpenCodeAdapter',
        'loadOpenCodeEvidence',
        'parseOpenCodeStream',
      ].sort(),
    );
  });
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
    for (const removed of [
      'BENCHMARK_SCHEMA_VERSION',
      'RESOLVED_RUN_PLAN_SCHEMA_VERSION',
      'RUN_RESULT_SCHEMA_VERSION',
      'SETUP_ARTIFACT_SCHEMA_VERSION',
      'INTERACTION_SCHEMA_VERSION',
      'WORKSPACE_EVIDENCE_SCHEMA_VERSION',
      'JUDGE_EVIDENCE_SCHEMA_VERSION',
      'EVALUATION_SCHEMA_VERSION',
      'CRITERION_JUDGE_PROMPT_VERSION',
      'JUDGE_TRANSCRIPT_PROJECTION_VERSION',
      'MAX_JUDGE_TRANSCRIPT_BYTES',
      'JUDGE_WORKSPACE_EVIDENCE_SCHEMA_VERSION',
    ]) {
      assert.equal(removed in rootExports, false);
    }
    assert.equal(typeof FORGE_VERSION, 'string');
    assert.equal(FORGE_BUILD_IDENTITY.version, FORGE_VERSION);
    assert.equal(Object.isFrozen(FORGE_BUILD_IDENTITY), true);
    assert.equal(typeof criterionResultMatchesDefinition, 'function');
    assert.equal(typeof executeEval, 'function');
    assert.equal(typeof preflightEval, 'function');
    assert.equal(typeof parseInteractionArtifact, 'function');
    assert.equal(typeof parseJudgeEvidence, 'function');
    assert.equal(typeof parseSetupArtifact, 'function');
    assert.equal(typeof parseAgentPluginInstallationReceipt, 'function');
    assert.equal(typeof evaluateRunEvidence, 'function');
    assert.equal(typeof resolveRunPlan, 'function');
    assert.equal(typeof parseResolvedRunPlan, 'function');
    assert.equal(typeof resolveManifestCaseIdFromFile, 'function');
    assert.equal(typeof createArtifactStore, 'function');
    assert.equal(typeof createForgeEngine, 'function');
    assert.equal(typeof createSetupExecutor, 'function');
    assert.equal(credentialsSetupHandler.uses, 'forge/credentials');
    assert.equal(typeof defineSetupActionBundle, 'function');
    assert.deepEqual([...firstPartySetupHandlers.keys()].sort(), [
      'forge/command',
      'forge/credentials',
      'forge/plugin',
      'forge/write',
    ]);
    assert.equal(typeof credentialReference, 'function');
    assert.equal(typeof normalizeEnvironmentSpecification, 'function');
    assert.equal(typeof createJudgeTranscriptProjection, 'function');
    assert.equal(typeof parseJudgeTranscriptProjection, 'function');
    assert.equal(JUDGE_TRANSCRIPT_SOURCE, 'trajectory.json');
    assert.equal(JUDGE_TRANSCRIPT_PROJECTION_ID, 'forge-visible-atif-steps');
    assert.equal(JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE, 'root');
    assert.deepEqual(JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES, ['user', 'agent']);
    assert.equal(JUDGE_TRANSCRIPT_COPIED_CONTEXT, 'excluded');
    assert.equal(typeof selectJudgeEvidence, 'function');
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

    const _acceptsPublicContracts = (
      _agent: AgentAdapter,
      _runtime: RuntimeAdapter,
      _composition: ForgeComposition,
      _judgeEvidence: JudgeEvidenceV1,
      _externalRuntime: ForgeExternalRuntimeV1,
      _runtimePreflight: RuntimePreflight,
    ): void => undefined;
  });
});
