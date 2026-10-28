import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { CommandExecutionError } from '../../contracts/command.ts';
import type {
  AgentInvocationRecord,
  RestrictedAgentExcerpts,
} from '../../diagnostics/agent.ts';
import {
  MAX_CLI_EXCERPT_BYTES,
  MAX_STDERR_EXCERPT_BYTES,
} from '../../diagnostics/agent.ts';
import { createRedactedTail } from '../../security/diagnosticRedaction.ts';
import { redactSecrets } from '../../security/redaction.ts';
import {
  codexRejection,
  createCodexInvocationCapture,
  summarizeCodexLine,
} from './diagnostics.ts';

import { parseCodexStream } from './stream.ts';

const time = new Date('2026-01-01T00:00:00.000Z');

describe('bounded Codex diagnostic capture', () => {
  it('keeps the first failure and final 20 events, with periodic durable observations', async () => {
    let elapsed = 0;
    const records: AgentInvocationRecord[] = [];
    const publications: Array<'invocation_boundary' | undefined> = [];
    let body: RestrictedAgentExcerpts | undefined;
    const capture = createCodexInvocationCapture({
      sequence: 1,
      resume: true,
      cliVersion: '1.0.0',
      now: () => time,
      monotonicNow: () => elapsed,
      capture: {
        restrictedExcerpts: true,
        redact: (text) => redactSecrets(text, ['secret-value']).value,
        redactedTail: (maximumBytes) =>
          createRedactedTail(['secret-value'], maximumBytes),
        async record(record, excerpts, publication) {
          records.push(record);
          publications.push(publication);
          body = excerpts;
        },
      },
    });
    await capture.start();
    const failure = JSON.stringify({
      type: 'error',
      message: 'HTTP 502 secret-value',
    });
    capture.onStdoutLine(failure);
    const lines = [failure];
    for (let i = 0; i < 30; i++) {
      const line = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'private'.repeat(6000) },
      });
      lines.push(line);
      elapsed = i * 1000;
      capture.onStdoutLine(line);
    }
    assert.ok(records.length > 2);
    assert.equal(records.at(-1)!.state, 'running');
    await capture.finish({
      result: {
        stdout: lines.join('\n'),
        stderr: `secret-value${'x'.repeat(40000)}secret-value`,
        exitCode: 1,
        durationMs: 1,
      },
      rejection: { code: 'process_nonzero_exit' },
    });
    assert.equal(publications[0], 'invocation_boundary');
    assert.equal(publications.at(-1), 'invocation_boundary');
    assert.ok(publications.slice(1, -1).every((entry) => entry === undefined));
    const final = records.at(-1)!;
    assert.equal(final.events.length, 20);
    assert.equal(final.events[0]!.sequence, 12);
    assert.equal(final.events.at(-1)!.sequence, 31);
    assert.equal(final.first_failure!.sequence, 1);
    assert.equal(final.first_failure!.http_status, 502);
    assert.equal(JSON.stringify(records).includes('private'), false);
    assert.ok(body);
    assert.ok(Buffer.byteLength(body.cli_events) <= MAX_CLI_EXCERPT_BYTES);
    assert.ok(Buffer.byteLength(body.stderr) <= MAX_STDERR_EXCERPT_BYTES);
    assert.equal(body.events_truncated, true);
    assert.equal(body.stderr_truncated, true);
    const parsed = JSON.parse(body.cli_events);
    assert.equal(parsed.failure.line_index, 1);
    assert.equal(parsed.failure.text.includes('[REDACTED]'), true);
    assert.equal(body.cli_events.includes('secret-value'), false);
    assert.equal(body.stderr.includes('secret-value'), false);
    assert.equal(parsed.operation, 'agent_resume');
  });

  it('redacts secrets across every chunk split before applying tail bounds', () => {
    const secret = 'credential-value';
    for (let i = 0; i <= secret.length; i++) {
      const tail = createRedactedTail([secret], 16);
      tail.push(`prefix${secret.slice(0, i)}`);
      tail.push(`${secret.slice(i)}suffix`);
      assert.deepEqual(tail.finish(), {
        text: '[REDACTED]suffix',
        truncated: true,
      });
    }
  });

  it('does not release a credential prefix when output ends at its capture bound', async () => {
    const secret = 'credential-value';
    const stdout = '{"type":"error","message":"credential-';
    const records: AgentInvocationRecord[] = [];
    let excerpts: RestrictedAgentExcerpts | undefined;
    const capture = createCodexInvocationCapture({
      sequence: 1,
      resume: false,
      cliVersion: '1.0.0',
      capture: {
        restrictedExcerpts: true,
        redact: (text) => redactSecrets(text, [secret]).value,
        redactedTail: (maximumBytes) =>
          createRedactedTail([secret], maximumBytes),
        async record(record, body) {
          records.push(record);
          excerpts = body;
        },
      },
    });
    capture.onStdoutLine(stdout);
    await capture.finish({
      commandError: new CommandExecutionError(
        'Output limit.',
        'command_output_limit',
        {
          capture: {
            stdout,
            stderr: 'stderr credential-',
            stdoutBytes: 100,
            stderrBytes: 100,
            durationMs: 1,
            stdoutTruncated: true,
            stderrTruncated: true,
          },
        },
      ),
      rejection: { code: 'output_limit' },
    });
    assert.ok(excerpts);
    assert.equal(excerpts.cli_events.includes('credential-'), false);
    assert.equal(excerpts.stderr.includes('credential-'), false);
    assert.equal(excerpts.stderr_truncated, true);
    assert.equal(records.at(-1)!.capture, 'partial');
  });

  it('projects only known structure, even with hostile keys and names', () => {
    const summary = summarizeCodexLine(
      JSON.stringify({
        type: 'secret-name',
        item: {
          type: 'secret-type',
          status: 'secret-status',
          command: 'private',
          exit_code: 1,
        },
        __proto__: { message: 'secret' },
      }),
      1,
      time.toISOString(),
    );
    assert.deepEqual(summary, {
      sequence: 1,
      observed_at: time.toISOString(),
      event_type: 'unknown',
      item_type: 'unknown',
    });
  });

  it('keeps excerpts disabled unless the explicit capture capability enables them', async () => {
    let body: RestrictedAgentExcerpts | undefined;
    const capture = createCodexInvocationCapture({
      sequence: 1,
      resume: false,
      cliVersion: '1',
      capture: {
        restrictedExcerpts: false,
        redact: (text) => redactSecrets(text, []).value,
        redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
        async record(_record, excerpts) {
          body = excerpts;
        },
      },
    });
    capture.onStdoutLine('{private');
    capture.onStderrChunk('private');
    await capture.finish({ rejection: { code: 'invalid_json' } });
    assert.equal(body, undefined);
  });
});

it('reserves the first rejected event even when it precedes a later reported failure and leaves the tail', async () => {
  const lines = [
    JSON.stringify({ type: 'turn.started', extra: 'early rejection' }),
    ...Array.from({ length: 25 }, () =>
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'later output' },
      }),
    ),
    JSON.stringify({ type: 'error', message: 'later failure' }),
  ];
  let final: AgentInvocationRecord | undefined;
  let excerpts: RestrictedAgentExcerpts | undefined;
  const capture = createCodexInvocationCapture({
    sequence: 1,
    resume: false,
    cliVersion: '1',
    capture: {
      restrictedExcerpts: true,
      redact: (text) => redactSecrets(text, []).value,
      redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
      async record(record, body) {
        final = record;
        excerpts = body;
      },
    },
  });
  for (const line of lines) capture.onStdoutLine(line);
  await capture.finish({
    result: {
      stdout: lines.join('\n'),
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    },
    rejection: {
      code: 'unexpected_field',
      line_index: 1,
      schema_path: 'event',
    },
  });
  assert.equal(final!.first_failure!.sequence, 1);
  assert.equal(JSON.parse(excerpts!.cli_events).failure.line_index, 1);
  assert.equal(
    JSON.parse(excerpts!.cli_events).failure.text.includes('early rejection'),
    true,
  );
});

it('does not serialize raw command capture into ordinary error JSON', () => {
  const error = new CommandExecutionError(
    'Command failed.',
    'command_timeout',
    {
      capture: {
        stdout: 'private stdout',
        stderr: 'private stderr',
        stdoutBytes: 14,
        stderrBytes: 14,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      },
    },
  );
  assert.equal(error.capture!.stdout, 'private stdout');
  assert.equal(JSON.stringify(error).includes('private'), false);
});

const streamOptions = {
  model: 'test-model',
  workspacePath: '/workspace',
  hookAutomation: true,
};
const advisories = [
  'Model metadata for `test-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
  '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.',
  'Ignored unsupported project-local config keys in /workspace/.codex/config.toml: model_providers. If you want these settings to apply, manually set them in your user-level config.toml.',
];

it.each(advisories)(
  'keeps accepted advisories out of the first-failure slot: %s',
  async (message) => {
    for (const rejected of [false, true]) {
      const events = [
        {
          type: 'thread.started',
          thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53',
        },
        {
          type: 'item.completed',
          item: { id: 'notice', type: 'error', message },
        },
        { type: 'turn.started' },
        ...Array.from({ length: 26 }, (_, index) => ({
          type: 'item.completed',
          item: {
            id: `answer-${index}`,
            type: 'agent_message',
            text: 'answer',
            ...(rejected && index === 0
              ? { extra: 'rejected-event-marker' }
              : {}),
          },
        })),
        {
          type: 'turn.completed',
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
        },
      ];
      const stdout = events.map((event) => JSON.stringify(event)).join('\n');
      let final: AgentInvocationRecord | undefined;
      let excerpts: RestrictedAgentExcerpts | undefined;
      const capture = createCodexInvocationCapture({
        sequence: 1,
        resume: false,
        cliVersion: '1',
        streamOptions,
        capture: {
          restrictedExcerpts: true,
          redact: (text) => text,
          redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
          async record(record, body) {
            final = record;
            excerpts = body;
          },
        },
      });
      for (const line of stdout.split('\n')) capture.onStdoutLine(line);
      let rejection: ReturnType<typeof codexRejection> | undefined;
      try {
        parseCodexStream(stdout, undefined, streamOptions);
        assert.equal(rejected, false);
      } catch (error) {
        assert.equal(rejected, true);
        rejection = codexRejection(error);
        assert.equal(rejection.code, 'unexpected_field');
        assert.equal(rejection.line_index, 4);
      }
      await capture.finish({
        result: { stdout, stderr: '', exitCode: 0, durationMs: 1 },
        ...(rejection ? { rejection } : {}),
      });
      assert.ok(final);
      if (rejected) {
        assert.equal(final.first_failure?.sequence, 4);
        assert.ok(final.events.every((event) => event.sequence > 4));
        assert.equal(JSON.parse(excerpts!.cli_events).failure.line_index, 4);
        assert.ok(
          JSON.parse(excerpts!.cli_events).failure.text.includes(
            'rejected-event-marker',
          ),
        );
      } else {
        assert.equal(final.state, 'completed');
        assert.equal(final.first_failure, undefined);
        assert.equal(excerpts, undefined);
      }
    }
  },
);

it('treats advisory text as a failure outside its accepted context', async () => {
  for (const midTurn of [false, true]) {
    let final: AgentInvocationRecord | undefined;
    const capture = createCodexInvocationCapture({
      sequence: 1,
      resume: false,
      cliVersion: '1',
      streamOptions: midTurn ? streamOptions : {},
      capture: {
        restrictedExcerpts: false,
        redact: (text) => text,
        redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
        async record(record) {
          final = record;
        },
      },
    });
    capture.onStdoutLine(JSON.stringify({ type: 'thread.started' }));
    if (midTurn) capture.onStdoutLine(JSON.stringify({ type: 'turn.started' }));
    capture.onStdoutLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'notice', type: 'error', message: advisories[0] },
      }),
    );
    await capture.finish({ rejection: { code: 'item_error' } });
    assert.equal(final!.first_failure!.sequence, midTurn ? 3 : 2);
  }
});

it.each([
  { stdout: '{"type":"turn.started"}', line: 2 },
  { stdout: '{"type":"turn.started"}\n{"type":"turn.completed"}', line: 2 },
  { stdout: '{"type":"turn.started"}\n\n', line: 2 },
  { stdout: '{"type":"turn.started"}\n', line: 2 },
])(
  'does not synthesize a failed event at a blank or unobserved rejection line: $stdout',
  async ({ stdout, line }) => {
    let final: AgentInvocationRecord | undefined;
    let body: RestrictedAgentExcerpts | undefined;
    const capture = createCodexInvocationCapture({
      sequence: 1,
      resume: false,
      cliVersion: '1',
      capture: {
        restrictedExcerpts: true,
        redact: (text) => text,
        redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
        async record(record, excerpts) {
          final = record;
          body = excerpts;
        },
      },
    });
    capture.onStdoutLine('{"type":"turn.started"}');
    if (stdout.endsWith('\n\n')) capture.onStdoutLine('');
    await capture.finish({
      result: { stdout, stderr: '', exitCode: 1, durationMs: 1 },
      rejection: { code: 'invalid_event_order', line_index: line },
    });
    assert.equal(final!.first_failure, undefined);
    assert.equal(JSON.parse(body!.cli_events).failure, null);
  },
);

it.each(['live', 'fallback', 'live_without_capture', 'truncated'] as const)(
  'uses one overlap-safe stderr tail for %s output',
  async (source) => {
    let tails = 0;
    let body: RestrictedAgentExcerpts | undefined;
    const secret = 'credential-value';
    const stderr =
      source === 'truncated' ? 'prefix credential-' : `prefix ${secret}`;
    const capture = createCodexInvocationCapture({
      sequence: 1,
      resume: false,
      cliVersion: '1',
      capture: {
        restrictedExcerpts: true,
        redact: (text) => redactSecrets(text, [secret]).value,
        redactedTail: (maximumBytes) => {
          tails++;
          return createRedactedTail([secret], maximumBytes);
        },
        async record(_record, excerpts) {
          body = excerpts;
        },
      },
    });
    if (source !== 'fallback') {
      capture.onStderrChunk('prefix credential-');
      if (source !== 'truncated') capture.onStderrChunk('value');
    }
    const partial = {
      stdout: '',
      stderr,
      durationMs: 1,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr),
      stdoutTruncated: false,
      stderrTruncated: source === 'truncated',
    };
    await capture.finish({
      rejection: { code: 'unknown' },
      ...(source === 'live_without_capture'
        ? {}
        : {
            commandError: new CommandExecutionError(
              'Command failed.',
              'command_timeout',
              { capture: partial },
            ),
          }),
    });
    assert.equal(tails, 1);
    if (source === 'truncated') {
      assert.ok('prefix '.startsWith(body!.stderr));
      assert.equal(body!.stderr.includes('credential-'), false);
    } else assert.equal(body!.stderr, 'prefix [REDACTED]');
    assert.equal(body!.stderr_truncated, source === 'truncated');
  },
);

it('keeps event excerpts within the byte cap when truncation splits a UTF-8 character', async () => {
  let body: RestrictedAgentExcerpts | undefined;
  const capture = createCodexInvocationCapture({
    sequence: 1,
    resume: false,
    cliVersion: '1',
    capture: {
      restrictedExcerpts: true,
      redact: (text) => text,
      redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
      async record(_record, excerpts) {
        body = excerpts;
      },
    },
  });
  const prefix = '{"type":"error","message":"';
  const line = `${prefix}${'a'.repeat(8192 - Buffer.byteLength(prefix) - 1)}€"}`;
  capture.onStdoutLine(line);
  await capture.finish({ rejection: { code: 'turn_failed' } });
  const excerpts = JSON.parse(body!.cli_events);
  assert.equal(excerpts.truncated, true);
  for (const entry of [excerpts.failure, ...excerpts.events])
    assert.ok(Buffer.byteLength(entry.text) <= 8192);
});
