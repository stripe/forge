import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertNoCleanupWarnings } from './cleanup.mjs';
import { MODEL } from './configuration.mjs';

export function createRunVerifiers(forge) {
  const {
    parseAtifTrajectory,
    parseInteractionArtifact,
    parseJudgeEvidence,
    FORGE_CLAUDE_CODE_VERSION,
    JUDGE_TRANSCRIPT_COPIED_CONTEXT,
    JUDGE_TRANSCRIPT_INCLUDED_FIELDS,
    JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES,
    JUDGE_TRANSCRIPT_PROJECTION_ID,
    JUDGE_TRANSCRIPT_SOURCE,
    JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE,
  } = forge;
  return { verifyOneShotRun, verifyMultiTurnRun, verifyNativeSession };

  async function verifyOneShotRun(completed, nativeIdentity) {
    const { result } = completed;
    assertNoCleanupWarnings(result, completed.location);
    requireCondition(
      result.stop_reason === 'task_complete' && result.failure === null,
      'The live one-shot run did not complete the task.',
      completed.location,
    );
    requireCondition(
      result.interaction.mode === 'one_shot' &&
        result.interaction.turn_count === 1,
      'The live one-shot run did not record exactly one turn.',
      completed.location,
    );
    requireCondition(
      result.evaluation.status === 'passed' &&
        result.evaluation.score === 0 &&
        result.evaluation.judging_criteria_total === 0 &&
        result.evaluation.checks.length > 0 &&
        result.evaluation.checks.every(({ passed }) => passed),
      'The live one-shot checks did not all pass.',
      completed.location,
    );
    requireCondition(
      result.completion_calls.length === 0,
      'The checks-only one-shot unexpectedly used a host completion provider.',
      completed.location,
    );
    requireArtifactPaths(
      result,
      [
        'plan.json',
        'setup.json',
        'trajectory.json',
        'interaction.json',
        'workspace-evidence.json',
      ],
      completed.location,
    );

    const [interaction, trajectory] = await Promise.all([
      readJsonArtifact(completed.location, 'interaction.json', (value) =>
        parseInteractionArtifact(value, { forgeVersion: result.forge.version }),
      ),
      readJsonArtifact(
        completed.location,
        'trajectory.json',
        parseAtifTrajectory,
      ),
    ]);
    requireCondition(
      interaction.mode === 'one_shot' &&
        interaction.turns.length === 1 &&
        interaction.role_player === undefined &&
        interaction.failure === null,
      'The live one-shot interaction audit is inconsistent.',
      completed.location,
    );
    verifyNativeSession(
      result,
      trajectory,
      1,
      completed.location,
      nativeIdentity,
    );
    verifyTrajectoryTurns(trajectory, interaction.turns, completed.location);

    return Object.freeze({
      verified: true,
      run_id: result.run_id,
      location: completed.location,
      status: result.evaluation.status,
      score: result.evaluation.score,
      turns: result.interaction.turn_count,
      agent_cost_usd: result.agent.cost_usd,
      evidence: evidenceSummary(result.evidence),
    });
  }

  async function verifyMultiTurnRun(completed) {
    const { result } = completed;
    assertNoCleanupWarnings(result, completed.location);
    requireCondition(
      result.stop_reason === 'task_complete' && result.failure === null,
      'The live multi-turn run did not complete the task.',
      completed.location,
    );
    requireCondition(
      result.interaction.mode === 'multi_turn' &&
        result.interaction.turn_count >= 2 &&
        result.interaction.turn_count <= 4,
      'The live multi-turn run did not exercise between two and four turns.',
      completed.location,
    );
    requireCondition(
      result.evaluation.status === 'passed' &&
        result.evaluation.score === 1 &&
        result.evaluation.judging_criteria_total >= 1 &&
        result.evaluation.judging_criteria_passed ===
          result.evaluation.judging_criteria_total &&
        result.evaluation.judging_criteria.every(({ passed }) => passed) &&
        result.evaluation.checks.length > 0 &&
        result.evaluation.checks.every(({ passed }) => passed),
      'The live multi-turn checks and criteria did not all pass.',
      completed.location,
    );
    requireArtifactPaths(
      result,
      [
        'plan.json',
        'setup.json',
        'trajectory.json',
        'interaction.json',
        'workspace-evidence.json',
        'judge-evidence.json',
      ],
      completed.location,
    );

    const [interaction, trajectory, judgeEvidence] = await Promise.all([
      readJsonArtifact(completed.location, 'interaction.json', (value) =>
        parseInteractionArtifact(value, { forgeVersion: result.forge.version }),
      ),
      readJsonArtifact(
        completed.location,
        'trajectory.json',
        parseAtifTrajectory,
      ),
      readJsonArtifact(completed.location, 'judge-evidence.json', (value) =>
        parseJudgeEvidence(value, { forgeVersion: result.forge.version }),
      ),
    ]);
    const invokedDecisions = interaction.role_player?.decisions.filter(
      ({ coding_agent_invoked: invoked }) => invoked,
    );
    requireCondition(
      interaction.mode === 'multi_turn' &&
        interaction.turns.length === result.interaction.turn_count &&
        interaction.turns.length >= 2 &&
        interaction.failure === null &&
        interaction.role_player !== undefined &&
        interaction.role_player.needs !== null &&
        interaction.role_player.needs.length > 0 &&
        interaction.role_player.decisions[0]?.source ===
          'configured_initial_prompt' &&
        invokedDecisions?.length === interaction.turns.length &&
        interaction.role_player.decisions.at(-1)?.stop === true,
      'The live multi-turn interaction audit is incomplete.',
      completed.location,
    );
    verifyNativeSession(
      result,
      trajectory,
      result.interaction.turn_count,
      completed.location,
    );
    verifyTrajectoryTurns(trajectory, interaction.turns, completed.location);

    const releaseSummary = judgeEvidence.workspace.entries.find(
      ({ path: evidencePath }) => evidencePath === 'release-summary.txt',
    );
    requireCondition(
      judgeEvidence.transcript.steps.length > 0 &&
        judgeEvidence.transcript.source === JUDGE_TRANSCRIPT_SOURCE &&
        judgeEvidence.transcript.projection_id ===
          JUDGE_TRANSCRIPT_PROJECTION_ID &&
        judgeEvidence.transcript.trajectory_scope ===
          JUDGE_TRANSCRIPT_TRAJECTORY_SCOPE &&
        judgeEvidence.transcript.included_step_sources.length ===
          JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES.length &&
        judgeEvidence.transcript.included_step_sources.every(
          (source, index) =>
            source === JUDGE_TRANSCRIPT_INCLUDED_STEP_SOURCES[index],
        ) &&
        judgeEvidence.transcript.copied_context ===
          JUDGE_TRANSCRIPT_COPIED_CONTEXT &&
        judgeEvidence.transcript.included_fields.length ===
          JUDGE_TRANSCRIPT_INCLUDED_FIELDS.length &&
        judgeEvidence.transcript.included_fields.every(
          (field, index) => field === JUDGE_TRANSCRIPT_INCLUDED_FIELDS[index],
        ) &&
        judgeEvidence.workspace.complete === true &&
        judgeEvidence.workspace.warnings.length === 0 &&
        releaseSummary?.truncated === false &&
        releaseSummary.content ===
          'Forge is ready for multi-turn evaluation.\n',
      'The live judge evidence is incomplete or does not bind the exact deliverable.',
      completed.location,
    );

    const completionCalls = {
      role_player: completionSummary(result.completion_calls, 'role_player'),
      judge: completionSummary(result.completion_calls, 'judge'),
    };
    requireCondition(
      completionCalls.role_player.succeeded >= 2 &&
        completionCalls.judge.succeeded >= 1,
      'The live run did not complete all required Ava and judge calls.',
      completed.location,
    );

    return Object.freeze({
      verified: true,
      run_id: result.run_id,
      location: completed.location,
      status: result.evaluation.status,
      score: result.evaluation.score,
      turns: result.interaction.turn_count,
      judging_criteria_passed: result.evaluation.judging_criteria_passed,
      agent_cost_usd: result.agent.cost_usd,
      session_provenance_verified: true,
      evidence: evidenceSummary(result.evidence),
      completion_calls: completionCalls,
    });
  }

  function verifyNativeSession(
    result,
    trajectory,
    minimumAgentSteps,
    location,
    identity = {
      format: 'claude-code-jsonl',
      version: FORGE_CLAUDE_CODE_VERSION,
    },
  ) {
    const source = result.evidence.provenance.source;
    const sessionId = result.agent.session_id;
    requireCondition(
      source.kind === 'native_log' &&
        source.format === identity.format &&
        result.evidence.completeness !== 'fallback' &&
        sessionId !== null &&
        source.session_id === sessionId &&
        result.evidence.provenance.adapter.id === result.agent.adapter &&
        result.evidence.provenance.adapter.version ===
          result.agent.adapter_version &&
        trajectory.session_id === sessionId &&
        trajectory.agent.name === result.agent.adapter &&
        trajectory.agent.version === identity.version &&
        trajectory.agent.model_name === result.agent.model &&
        trajectory.steps.filter(
          ({ source: stepSource }) => stepSource === 'agent',
        ).length >= minimumAgentSteps,
      'The live run did not preserve exact native agent session evidence.',
      location,
    );
  }

  function verifyTrajectoryTurns(trajectory, turns, location) {
    const trajectoryTurns = [];
    let current;
    for (const step of trajectory.steps) {
      if (step.is_copied_context === true || step.source === 'system') continue;
      if (step.source === 'user') {
        if (typeof step.message !== 'string') {
          current = undefined;
          trajectoryTurns.push({
            user: undefined,
            hasAgent: false,
            hasResponse: false,
          });
          continue;
        }
        current = { user: step.message, hasAgent: false, hasResponse: false };
        trajectoryTurns.push(current);
        continue;
      }
      if (current === undefined) {
        requireCondition(
          false,
          'The native trajectory contains agent activity before a completed user turn.',
          location,
        );
      }
      current.hasAgent = true;
      const hasMessage =
        typeof step.message === 'string'
          ? step.message.length > 0
          : Array.isArray(step.message) &&
            step.message.some(
              (part) => part.type !== 'text' || part.text.length > 0,
            );
      if (hasMessage || (step.tool_calls?.length ?? 0) > 0) {
        current.hasResponse = true;
      }
    }

    requireCondition(
      trajectoryTurns.length === turns.length &&
        turns.every((turn, index) => {
          const persisted = trajectoryTurns[index];
          const completedHasResponse =
            turn.assistant.length > 0 || turn.tool_calls.length > 0;
          return (
            persisted?.user === turn.user &&
            persisted.hasAgent &&
            (!completedHasResponse || persisted.hasResponse)
          );
        }),
      'The native trajectory does not structurally cover every completed turn.',
      location,
    );
  }

  function requireArtifactPaths(result, expected, location) {
    const actual = result.artifacts.map(
      ({ path: artifactPath }) => artifactPath,
    );
    const nativePath = `native/${result.agent.adapter}/session.jsonl`;
    const nativeArtifact = result.supplemental_artifacts.find(
      ({ path: artifactPath }) => artifactPath === nativePath,
    );
    requireCondition(
      actual.length === expected.length &&
        expected.every((artifactPath) => actual.includes(artifactPath)) &&
        result.supplemental_artifacts.length === 1 &&
        nativeArtifact?.media_type === 'application/x-ndjson' &&
        nativeArtifact.sensitivity === 'restricted' &&
        nativeArtifact.size_bytes > 0,
      'The live run did not commit the expected canonical artifact set.',
      location,
    );
  }

  async function readJsonArtifact(location, artifactPath, parse) {
    let value;
    try {
      value = JSON.parse(
        await fs.readFile(path.join(location, artifactPath), 'utf8'),
      );
    } catch (error) {
      throw new Error(
        `Could not read ${artifactPath} from the completed run.`,
        {
          cause: error,
        },
      );
    }
    return parse(value);
  }

  function completionSummary(calls, purpose) {
    const selected = calls.filter((call) => call.purpose === purpose);
    const safeModel = selected.every(
      ({ provider, model }) => provider === 'anthropic' && model === MODEL,
    );
    if (!safeModel || selected.length === 0) {
      throw new Error(
        `The live ${purpose} calls used unexpected model coordinates.`,
      );
    }
    return Object.freeze({
      attempts: selected.length,
      succeeded: selected.filter(({ status }) => status === 'succeeded').length,
      failed: selected.filter(({ status }) => status === 'failed').length,
      input_tokens: sumNullable(
        selected.map(({ input_tokens: value }) => value),
      ),
      output_tokens: sumNullable(
        selected.map(({ output_tokens: value }) => value),
      ),
      error_codes: selected.flatMap(({ error_code: errorCode }) =>
        errorCode === null ? [] : [errorCode],
      ),
    });
  }

  function evidenceSummary(evidence) {
    const warningCounts = {};
    for (const { code } of evidence.warnings) {
      warningCounts[code] = (warningCounts[code] ?? 0) + 1;
    }
    return Object.freeze({
      completeness: evidence.completeness,
      source: evidence.provenance.source.kind,
      warning_counts: warningCounts,
    });
  }

  function sumNullable(values) {
    const present = values.filter((value) => value !== null);
    return present.length === 0
      ? null
      : present.reduce((sum, value) => sum + value, 0);
  }

  function requireCondition(condition, message, location) {
    if (!condition) {
      throw new Error(`${message} Result: ${location}`);
    }
  }
}
