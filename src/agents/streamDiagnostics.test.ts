import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { AgentInvocationRecord } from '../diagnostics/agent.ts';
import { createInvocationCapture } from './invocationDiagnostics.ts';
import { summarizeNativeStreamLine } from './streamDiagnostics.ts';

const at = '2026-01-01T00:00:00.000Z';
describe('native stream diagnostic projections', () => {
  for (const source of ['claude_stream_json', 'opencode_run_json'] as const) {
    it(`${source} excludes payloads and untrusted event names`, () => {
      const summary = summarizeNativeStreamLine(
        source,
        JSON.stringify({
          type: 'private-event-name',
          message: 'private payload',
          part: { state: { status: 'private-state' } },
        }),
        1,
        at,
      );
      assert.deepEqual(summary, {
        sequence: 1,
        observed_at: at,
        event_type: 'unknown',
      });
      assert.deepEqual(
        summarizeNativeStreamLine(source, 'not json', 1, at),
        summary,
      );
    });
  }
  it('keeps Claude failure flags without result content', () => {
    assert.deepEqual(
      summarizeNativeStreamLine(
        'claude_stream_json',
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'private response',
        }),
        1,
        at,
      ),
      { sequence: 1, observed_at: at, event_type: 'result', status: 'failed' },
    );
  });
  it('keeps OpenCode tool failure flags without tool input or output', () => {
    assert.deepEqual(
      summarizeNativeStreamLine(
        'opencode_run_json',
        JSON.stringify({
          type: 'tool_use',
          part: {
            state: {
              status: 'error',
              input: 'private input',
              error: 'private output',
            },
          },
        }),
        1,
        at,
      ),
      {
        sequence: 1,
        observed_at: at,
        event_type: 'tool_use',
        status: 'failed',
      },
    );
  });
  it('counts a failed OpenCode tool without labeling the agent call failed', async () => {
    let record: AgentInvocationRecord | undefined;
    const capture = createInvocationCapture({
      sequence: 1,
      resume: false,
      cliVersion: '1',
      source: 'opencode_run_json',
      summarizeLine: (line, sequence, at) =>
        summarizeNativeStreamLine('opencode_run_json', line, sequence, at),
      isFailure: (summary) => summary.event_type === 'error',
      capture: {
        restrictedExcerpts: false,
        redact: (text) => text,
        redactedTail() {
          throw new Error('Text is disabled.');
        },
        async record(next) {
          record = next;
        },
      },
    });
    const stdout = JSON.stringify({
      type: 'tool_use',
      part: { state: { status: 'error', error: 'private error' } },
    });
    capture.onStdoutLine(stdout);
    await capture.finish({
      result: { stdout, stderr: '', exitCode: 0, durationMs: 1 },
    });
    assert.equal(record!.state, 'completed');
    assert.equal(record!.tool_failure_count, 1);
    assert.equal(record!.first_failure, undefined);
    assert.doesNotMatch(JSON.stringify(record), /private error/);
  });
});
