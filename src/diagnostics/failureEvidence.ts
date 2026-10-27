import { z } from 'zod';
import {
  ATIF_SCHEMA_VERSION,
  type AtifStep,
  parseAtifTrajectory,
} from '../atif/index.ts';
import type {
  AgentEvidenceIdentity,
  AgentNativeArtifact,
  AgentTurn,
} from '../contracts/agent.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import type { AgentDiagnosticsCapture } from './agent.ts';

export const MAX_FAILURE_EVIDENCE_BYTES = 64 * 1024;
export const MAX_FAILURE_NATIVE_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 4096;
const MAX_TOOL_CALLS = 20;
const count = z.number().int().nonnegative().safe();
const artifact = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: count.max(MAX_FAILURE_EVIDENCE_BYTES),
  })
  .strict();
const captureState = z.enum([
  'disabled',
  'unsupported',
  'unavailable',
  'empty',
  'available',
  'truncated',
]);
const nativeFormat = z.enum([
  'claude-code-jsonl',
  'codex-rollout-jsonl',
  'opencode-session-json',
]);
const evidence = z
  .object({ state: captureState, artifact: artifact.optional() })
  .strict();
export const failureEvidenceSchema = z
  .object({
    partial_trajectory: evidence.extend({
      completed_turns: count,
      tool_calls: count,
      retained_turns: count,
    }),
    native_log: evidence.extend({
      format: nativeFormat.optional(),
      source_bytes: count.optional(),
      capture_point: z.enum(['failure', 'completed_turn']).optional(),
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      [value.partial_trajectory, value.native_log].some(
        (item) =>
          (item.state === 'available' || item.state === 'truncated') !==
          (item.artifact !== undefined),
      ) ||
      value.partial_trajectory.retained_turns >
        value.partial_trajectory.completed_turns ||
      (value.partial_trajectory.state === 'empty' &&
        value.partial_trajectory.completed_turns !== 0) ||
      (value.partial_trajectory.artifact !== undefined &&
        value.partial_trajectory.retained_turns === 0) ||
      (value.native_log.artifact !== undefined &&
        (value.native_log.format === undefined ||
          value.native_log.source_bytes === undefined ||
          value.native_log.capture_point === undefined))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence state, artifact or counts disagree.',
      });
  });
export type FailureEvidenceRecord = z.infer<typeof failureEvidenceSchema>;

/** Retain a bounded projection while complete turns are still available. */
export function createFailureEvidenceCapture(input: {
  capture: AgentDiagnosticsCapture;
  identity: AgentEvidenceIdentity;
  model: string;
  requested: boolean;
}) {
  let completed = 0;
  let toolCalls = 0;
  let truncated = false;
  let unavailable = false;
  let steps: AtifStep[] = [];
  let sessionId = '';
  let completedSessionId: string | undefined;
  let completedNative:
    | {
        metadata: Omit<FailureEvidenceRecord['native_log'], 'artifact'>;
        body: string;
        sessionId: string;
      }
    | undefined;
  const policy = input.capture.restrictedExcerpts
    ? 'enabled'
    : input.requested
      ? 'unsupported'
      : 'disabled';
  function text(value: string) {
    const safe = input.capture.redact(value);
    const bytes = Buffer.from(safe);
    if (bytes.length <= MAX_MESSAGE_BYTES) return safe;
    truncated = true;
    return (
      bytes.subarray(0, MAX_MESSAGE_BYTES - 32).toString('utf8') +
      '[diagnostic text truncated]'
    );
  }
  function trajectory() {
    return {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: sessionId,
      agent: {
        name: input.capture.redact(input.identity.name),
        version: input.capture.redact(input.identity.version),
        model_name: input.capture.redact(input.model),
      },
      steps: steps.map((step, index) => ({ ...step, step_id: index + 1 })),
      extra: { diagnostic_only: true, completed_turns: completed, truncated },
    };
  }
  function nativeTail(
    native: AgentNativeArtifact,
    capturePoint: 'failure' | 'completed_turn',
  ) {
    const format = nativeFormat.safeParse(native.format);
    if (
      !format.success ||
      format.data === undefined ||
      native.body.byteLength > MAX_FAILURE_NATIVE_SOURCE_BYTES
    )
      return undefined;
    const tail = input.capture.redactedTail(MAX_FAILURE_EVIDENCE_BYTES);
    tail.push(Buffer.from(native.body).toString('utf8'));
    const result = tail.finish();
    return {
      body: result.text,
      sessionId: native.sessionId,
      metadata: {
        state: result.truncated
          ? ('truncated' as const)
          : ('available' as const),
        format: format.data,
        source_bytes: native.body.byteLength,
        capture_point: capturePoint,
      },
    };
  }
  return {
    nativeSession(native: AgentNativeArtifact) {
      if (policy !== 'enabled') return;
      try {
        completedNative = nativeTail(native, 'completed_turn');
      } catch {
        completedNative = undefined;
      }
    },
    completed(message: string, turn: AgentTurn) {
      completed++;
      completedSessionId = turn.sessionId;
      toolCalls += turn.toolCalls.length;
      if (policy !== 'enabled' || unavailable) return;
      try {
        sessionId = input.capture.redact(turn.sessionId);
        const calls = turn.toolCalls
          .slice(0, MAX_TOOL_CALLS)
          .map((call, index) => {
            if (call.input !== undefined) truncated = true;
            return {
              tool_call_id: text(
                call.id ?? `diagnostic-${completed}-${index + 1}`,
              ),
              function_name: text(call.name),
              arguments: {},
              ...(call.input === undefined
                ? {}
                : { extra: { arguments_omitted: true } }),
            };
          });
        if (calls.length !== turn.toolCalls.length) truncated = true;
        steps.push(
          { step_id: 1, source: 'user', message: text(message) },
          {
            step_id: 2,
            source: 'agent',
            message: text(turn.text),
            ...(calls.length ? { tool_calls: calls } : {}),
          },
        );
        while (
          Buffer.byteLength(serializeCanonicalJson(trajectory())) >
            MAX_FAILURE_EVIDENCE_BYTES &&
          steps.length
        ) {
          steps.splice(0, 2);
          truncated = true;
        }
      } catch {
        unavailable = true;
        steps = [];
      }
    },
    finish(native?: AgentNativeArtifact) {
      const bodies: { native_log?: string; partial_trajectory?: string } = {};
      let partialState: FailureEvidenceRecord['partial_trajectory']['state'] =
        policy === 'enabled'
          ? completed === 0
            ? 'empty'
            : 'unavailable'
          : policy;
      if (policy === 'enabled' && steps.length && !unavailable) {
        try {
          bodies.partial_trajectory = serializeCanonicalJson(
            parseAtifTrajectory(trajectory()),
          );
          partialState = truncated ? 'truncated' : 'available';
        } catch {
          partialState = 'unavailable';
        }
      }
      let nativeLog: Omit<FailureEvidenceRecord['native_log'], 'artifact'> = {
        state: policy === 'enabled' ? 'unavailable' : policy,
      };
      if (policy === 'enabled') {
        try {
          const captured =
            native === undefined
              ? completedNative?.sessionId === completedSessionId
                ? completedNative
                : undefined
              : nativeTail(native, 'failure');
          if (captured) {
            bodies.native_log = captured.body;
            nativeLog = captured.metadata;
          }
        } catch {
          nativeLog = { state: 'unavailable' };
        }
      }
      return {
        record: {
          partial_trajectory: {
            state: partialState,
            completed_turns: completed,
            tool_calls: toolCalls,
            retained_turns:
              bodies.partial_trajectory === undefined ? 0 : steps.length / 2,
          },
          native_log: nativeLog,
        },
        bodies,
      };
    },
  };
}
