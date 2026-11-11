import {
  ATIF_SCHEMA_VERSION,
  type AtifAgentStep,
  type AtifStep,
  type JsonObject,
  parseAtifTrajectory,
} from '../../atif/index.ts';
import { assertBoundedJsonValue } from '../../atif/parser.ts';
import type {
  AgentNativeArtifact,
  AgentNativeEvidenceResult,
  AgentNativeEvidenceWarning,
} from '../../contracts/agent.ts';
import type { ReadonlyWorkspace } from '../../contracts/runtime.ts';
import {
  array,
  EXPORT_PATH,
  identifier,
  MAX_NATIVE_BYTES,
  nonnegative,
  OPENCODE_FORMAT,
  OpenCodeNativeError,
  record,
  sessionId,
  string,
  terminal,
  tool,
} from './native.ts';

export interface LoadOpenCodeEvidenceInput {
  readonly state: ReadonlyWorkspace | undefined;
  readonly sessionId: string;
  readonly agentVersion: string;
  readonly model: string;
  readonly signal: AbortSignal;
}

async function readExport(
  input: Pick<LoadOpenCodeEvidenceInput, 'state' | 'sessionId' | 'signal'>,
) {
  input.signal.throwIfAborted();
  if (!input.state) return undefined;
  sessionId(input.sessionId);
  const entry = await input.state.inspect(EXPORT_PATH);
  if (entry.kind === 'absent' || entry.size === 0) return undefined;
  if (entry.kind !== 'file' || (entry.size ?? 0) > MAX_NATIVE_BYTES)
    throw new OpenCodeNativeError();
  const body = await input.state.readFile(EXPORT_PATH, {
    maxBytes: MAX_NATIVE_BYTES,
    signal: input.signal,
  });
  input.signal.throwIfAborted();
  const value = record(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
  );
  if (record(value.info).id !== input.sessionId)
    throw new OpenCodeNativeError();
  return { body, value };
}

export async function loadOpenCodeNativeArtifact(
  input: Pick<LoadOpenCodeEvidenceInput, 'state' | 'sessionId' | 'signal'>,
): Promise<AgentNativeArtifact | undefined> {
  try {
    const captured = await readExport(input);
    if (!captured) return undefined;
    return {
      format: OPENCODE_FORMAT,
      sessionId: input.sessionId,
      mediaType: 'application/json',
      extension: 'json',
      body: Uint8Array.from(captured.body),
    };
  } catch {
    input.signal.throwIfAborted();
    return undefined;
  }
}

/** Reads only an exact-session export captured before the runtime was sealed. */
export async function loadOpenCodeEvidence(
  input: LoadOpenCodeEvidenceInput,
): Promise<AgentNativeEvidenceResult> {
  try {
    const captured = await readExport(input);
    if (!captured) return unavailable('source_unavailable');
    const { value } = captured;
    assertBoundedJsonValue(value);
    const info = record(value.info);
    if (info.version !== input.agentVersion) throw new OpenCodeNativeError();
    if (
      info.parentID !== undefined ||
      info.revert !== undefined ||
      record(info.time).compacting
    )
      throw new OpenCodeNativeError(true);
    const steps: AtifStep[] = [];
    const warnings: AgentNativeEvidenceWarning[] = [];
    const messageIds = new Set<string>();
    const partIds = new Set<string>();
    let userId: string | undefined;
    let finished = false;
    for (const rawMessage of array(value.messages)) {
      input.signal.throwIfAborted();
      const message = record(rawMessage);
      const meta = record(message.info);
      const id = identifier(meta.id);
      if (messageIds.has(id) || meta.sessionID !== input.sessionId)
        throw new OpenCodeNativeError();
      messageIds.add(id);
      const user = meta.role === 'user';
      if (!user && meta.role !== 'assistant')
        throw new OpenCodeNativeError(true);
      const selected = user ? record(meta.model) : meta;
      if (selected.modelID !== input.model || selected.providerID !== 'forge')
        throw new OpenCodeNativeError();
      if (user) {
        if (userId !== undefined && !finished)
          throw new OpenCodeNativeError(true);
        userId = id;
        finished = false;
      } else {
        if (
          userId === undefined ||
          meta.parentID !== userId ||
          meta.error !== undefined ||
          meta.summary === true
        )
          throw new OpenCodeNativeError(true);
        nonnegative(record(meta.time).completed);
        finished = terminal(meta.finish);
      }
      const texts: string[] = [];
      const reasoning: string[] = [];
      const calls: NonNullable<AtifAgentStep['tool_calls']> = [];
      const results: NonNullable<AtifAgentStep['observation']>['results'] = [];
      for (const rawPart of array(message.parts)) {
        const part = record(rawPart);
        const partId = identifier(part.id);
        if (
          partIds.has(partId) ||
          part.sessionID !== input.sessionId ||
          part.messageID !== id
        )
          throw new OpenCodeNativeError();
        partIds.add(partId);
        switch (part.type) {
          case 'text':
            if (part.synthetic === true || part.ignored === true)
              throw new OpenCodeNativeError(true);
            texts.push(string(part.text));
            break;
          case 'reasoning':
            if (user) throw new OpenCodeNativeError(true);
            reasoning.push(string(part.text));
            break;
          case 'tool': {
            if (user) throw new OpenCodeNativeError(true);
            const call = tool(part);
            const state = record(part.state);
            if (
              record(state.time).compacted !== undefined ||
              (state.attachments !== undefined &&
                array(state.attachments).length > 0)
            )
              throw new OpenCodeNativeError(true);
            calls.push({
              tool_call_id: call.id,
              function_name: call.name,
              arguments: call.input as JsonObject,
            });
            results.push({
              source_call_id: call.id,
              content: string(
                state.status === 'error' ? state.error : state.output,
              ),
              extra: { is_error: state.status === 'error' },
            });
            break;
          }
          // These pinned native parts describe accounting or filesystem snapshots,
          // never additional conversation. Tools already carry their visible result.
          case 'step-start':
          case 'step-finish':
          case 'snapshot':
          case 'patch':
            if (user) throw new OpenCodeNativeError(true);
            break;
          default:
            throw new OpenCodeNativeError(true);
        }
      }
      const base = { step_id: steps.length + 1, message: texts.join('\n\n') };
      if (user) {
        if (!texts.length) throw new OpenCodeNativeError(true);
        steps.push({ ...base, source: 'user' });
      } else {
        const tokens = record(meta.tokens);
        const cache = record(tokens.cache);
        steps.push({
          ...base,
          source: 'agent',
          model_name: input.model,
          ...(reasoning.length
            ? { reasoning_content: reasoning.join('\n\n') }
            : {}),
          ...(calls.length
            ? { tool_calls: calls, observation: { results } }
            : {}),
          metrics: {
            prompt_tokens: nonnegative(tokens.input),
            completion_tokens: nonnegative(tokens.output),
            cached_tokens: nonnegative(cache.read),
            cost_usd: nonnegative(meta.cost),
            extra: {
              reasoning_tokens: nonnegative(tokens.reasoning),
              cache_write_tokens: nonnegative(cache.write),
            },
          },
        });
      }
      const created = record(meta.time).created;
      if (
        typeof created === 'number' &&
        Number.isFinite(created) &&
        created >= 0 &&
        created <= 8.64e15
      ) {
        steps[steps.length - 1]!.timestamp = new Date(created).toISOString();
      } else
        warnings.push({
          code: 'value_omitted',
          message: 'OpenCode message timestamp was omitted.',
        });
    }
    if (!finished || !steps.length) throw new OpenCodeNativeError(true);
    return {
      kind: 'available',
      trajectory: parseAtifTrajectory({
        schema_version: ATIF_SCHEMA_VERSION,
        session_id: input.sessionId,
        agent: {
          name: 'opencode',
          version: input.agentVersion,
          model_name: input.model,
        },
        steps,
      }),
      source: {
        kind: 'native_log',
        format: OPENCODE_FORMAT,
        sessionId: input.sessionId,
      },
      warnings,
    };
  } catch (error) {
    input.signal.throwIfAborted();
    return unavailable(
      error instanceof OpenCodeNativeError && error.incomplete
        ? 'source_incomplete'
        : 'source_invalid',
    );
  }
}

function unavailable(
  code: 'source_unavailable' | 'source_invalid' | 'source_incomplete',
): AgentNativeEvidenceResult {
  return {
    kind: 'unavailable',
    reason: {
      code,
      message:
        'The exact OpenCode session export is unavailable, invalid, or incomplete.',
    },
  };
}
