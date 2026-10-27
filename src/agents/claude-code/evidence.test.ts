import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseAtifTrajectory } from '../../atif/index.ts';
import { createJudgeTranscriptProjection } from '../../evaluation/judgeTranscript.ts';
import { trajectoryCoversCompletedTurns } from '../../evidence/selection.ts';
import { createMemoryWorkspace } from '../../testing/memoryWorkspace.ts';
import { loadClaudeEvidence, loadClaudeNativeArtifact } from './evidence.ts';

function hookSuccessRecord(context: string) {
  return {
    type: 'attachment',
    sessionId: 'session-1',
    attachment: {
      type: 'hook_success',
      command: 'example-hook',
      content: '',
      durationMs: 12,
      exitCode: 0,
      hookEvent: 'SessionStart',
      hookName: 'hook-command',
      stderr: '',
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }),
      toolUseID: 'success-id',
    },
  };
}

function hookAdditionalContextRecord(context: string) {
  return {
    type: 'attachment',
    sessionId: 'session-1',
    attachment: {
      type: 'hook_additional_context',
      content: [context],
      hookEvent: 'SessionStart',
      hookName: 'context-renderer',
      toolUseID: 'context-id',
    },
    rendered: [
      { content: `<system-reminder>\n${context}\n</system-reminder>` },
    ],
  };
}

async function nativeEvidence(raw: string) {
  return loadClaudeEvidence({
    project: createMemoryWorkspace({ 'session-1.jsonl': raw }).readonly,
    sessionId: 'session-1',
    agentVersion: '2.1.273',
    model: 'claude-test',
    signal: new AbortController().signal,
  });
}

function queuedCommandRecord(commandMode = 'task-notification') {
  const prompt = 'Background task finished.';
  return {
    type: 'attachment',
    sessionId: 'session-1',
    timestamp: '2026-09-17T16:02:51.921Z',
    attachment: {
      type: 'queued_command',
      commandMode,
      prompt,
      timestamp: '2026-09-17T16:02:50.000Z',
    },
    rendered: [
      {
        content:
          commandMode === 'task-notification'
            ? `<system-reminder>${prompt}</system-reminder>`
            : prompt,
      },
    ],
  };
}

async function conversationEvidence(records: readonly unknown[]) {
  return nativeEvidence(
    [
      {
        type: 'user',
        sessionId: 'session-1',
        message: { content: 'Do the task' },
      },
      ...records,
      {
        type: 'assistant',
        sessionId: 'session-1',
        message: { content: 'Done' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n'),
  );
}

describe('Claude native evidence', () => {
  it('returns unavailable native evidence without constructing fallback', async () => {
    const evidence = await loadClaudeEvidence({
      project: undefined,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    assert.deepEqual(evidence, {
      kind: 'unavailable',
      reason: {
        code: 'source_unavailable',
        message: 'The exact Claude session is unavailable.',
      },
    });
  });

  it('classifies a missing exact session file as unavailable', async () => {
    const evidence = await loadClaudeEvidence({
      project: createMemoryWorkspace().readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    assert.deepEqual(evidence, {
      kind: 'unavailable',
      reason: {
        code: 'source_unavailable',
        message: 'The exact Claude session is unavailable.',
      },
    });
  });

  it('captures only the exact selected Claude JSONL without transforming bytes', async () => {
    const raw =
      '{"type":"attachment","attachment":{"type":"environment","credential":"raw-secret"}}\n';
    const project = createMemoryWorkspace({
      'session-1.jsonl': raw,
      'session-2.jsonl': '{"type":"user","message":{"content":"other"}}\n',
    });

    const artifact = await loadClaudeNativeArtifact({
      project: project.readonly,
      sessionId: 'session-1',
      signal: new AbortController().signal,
    });

    {
      const actual = artifact;
      assert.ok(actual);
      assert.equal(actual.format, 'claude-code-jsonl');
      assert.equal(actual.sessionId, 'session-1');
      assert.equal(actual.mediaType, 'application/x-ndjson');
      assert.equal(actual.extension, 'jsonl');
    }
    assert.equal(Buffer.from(artifact?.body ?? []).toString('utf8'), raw);
  });

  it('classifies malformed native JSONL as invalid', async () => {
    const evidence = await loadClaudeEvidence({
      project: createMemoryWorkspace({
        'session-1.jsonl': '{"type":"user"}\nnot-json',
      }).readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    assert.deepEqual(evidence, {
      kind: 'unavailable',
      reason: {
        code: 'source_invalid',
        message: 'Claude session evidence could not be normalized safely.',
      },
    });
  });

  for (const { description, marker, diagnosticKind } of [
    {
      description: 'compact summary flag',
      marker: { type: 'summary', isCompactSummary: true },
      diagnosticKind: 'compact summary',
    },
    {
      description: 'compact boundary subtype',
      marker: { type: 'system', subtype: 'compact_boundary' },
      diagnosticKind: 'system/compact_boundary',
    },
  ]) {
    it(`classifies the ${description} as incomplete native evidence`, async () => {
      const evidence = await nativeEvidence(
        [
          JSON.stringify(marker),
          JSON.stringify({
            type: 'user',
            sessionId: 'session-1',
            message: { content: 'Do the task' },
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 'session-1',
            message: { content: 'Done' },
          }),
        ].join('\n'),
      );

      assert.deepEqual(evidence, {
        kind: 'unavailable',
        reason: {
          code: 'source_incomplete',
          message: `Claude compaction may replace earlier turns; complete conversation coverage cannot be established (${diagnosticKind} at line 1).`,
        },
      });
    });
  }

  it('classifies an unknown root conversation record as incomplete', async () => {
    const evidence = await nativeEvidence(
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        }),
        '',
        JSON.stringify({ type: 'future-conversation-record' }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        }),
      ].join('\n'),
    );

    assert.deepEqual(evidence, {
      kind: 'unavailable',
      reason: {
        code: 'source_incomplete',
        message:
          'Claude session evidence could not be normalized safely (unrecognized record at line 3).',
      },
    });
  });

  it('keeps unknown record and attachment payloads out of diagnostics', async () => {
    for (const record of [
      { type: 'Synthetic private message with a URL https://example.invalid' },
      {
        type: 'attachment',
        attachment: {
          type: 'synthetic_private_value',
          content: 'Private content',
        },
      },
    ]) {
      const evidence = await conversationEvidence([record]);
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind !== 'unavailable') continue;
      assert.equal(evidence.reason.code, 'source_incomplete');
      assert.match(evidence.reason.message, /at line 2/);
      assert.doesNotMatch(
        evidence.reason.message,
        /Synthetic|synthetic_private|Private|https/,
      );
    }
  });

  for (const { description, records } of [
    {
      description: 'user',
      records: [
        {
          type: 'user',
          sessionId: 'session-1',
          message: { content: [{ type: 'future-user-block' }] },
        },
        {
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        },
      ],
    },
    {
      description: 'assistant',
      records: [
        {
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        },
        {
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: [{ type: 'future-assistant-block' }] },
        },
      ],
    },
  ]) {
    it(`classifies an unknown ${description} content block as incomplete`, async () => {
      const evidence = await nativeEvidence(
        records.map((record) => JSON.stringify(record)).join('\n'),
      );

      assert.deepEqual(evidence, {
        kind: 'unavailable',
        reason: {
          code: 'source_incomplete',
          message: 'Claude session evidence could not be normalized safely.',
        },
      });
    });
  }

  it('accepts explicitly supported metadata records without adding steps', async () => {
    const metadataTypes = [
      'agent-name',
      'ai-title',
      'custom-title',
      'file-history-snapshot',
      'last-prompt',
      'mode',
      'permission-mode',
      'pr-link',
      'queue-operation',
      'summary',
    ];

    const evidence = await nativeEvidence(
      [
        ...metadataTypes.map((type) => JSON.stringify({ type })),
        JSON.stringify({
          type: 'atis-latch',
          atis: '',
          sessionId: 'session-1',
        }),
        JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' }),
        JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        }),
      ].join('\n'),
    );

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.deepEqual(
      trajectory.steps.map(({ source, message }) => ({ source, message })),
      [
        { source: 'user', message: 'Do the task' },
        { source: 'agent', message: 'Done' },
      ],
    );
    assert.deepEqual(evidence.warnings, []);
  });

  it('maps rendered Claude attachments to ATIF system steps', async () => {
    const rendered =
      '<system-reminder>\n# Environment\nPrimary working directory: /workspace\n</system-reminder>';

    const evidence = await nativeEvidence(
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        }),
        JSON.stringify({
          type: 'attachment',
          sessionId: 'session-1',
          timestamp: '2026-09-17T16:02:51.921Z',
          attachment: {
            type: 'environment',
            snapshot: { workingDirectory: '/workspace' },
          },
          rendered: [{ content: rendered }],
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        }),
      ].join('\n'),
    );

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.deepEqual(
      trajectory.steps.map(({ step_id, source, message }) => ({
        step_id,
        source,
        message,
      })),
      [
        { step_id: 1, source: 'user', message: 'Do the task' },
        {
          step_id: 2,
          source: 'system',
          message: rendered,
        },
        { step_id: 3, source: 'agent', message: 'Done' },
      ],
    );
    {
      const actual = trajectory.steps[1];
      assert.ok(actual);
      assert.equal(actual.timestamp, '2026-09-17T16:02:51.921Z');
      assert.equal(actual.extra!.native_record_type, 'attachment');
      assert.equal(actual.extra!.attachment_type, 'environment');
    }
    assert.deepEqual(evidence.warnings, []);
  });

  it('accepts a hook success only when its context is in the next rendered attachment', async () => {
    const context = 'Use the installed plugin for this task.';

    const evidence = await nativeEvidence(
      [
        hookSuccessRecord(context),
        hookAdditionalContextRecord(context),
        {
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        },
        {
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    assert.deepEqual(
      parseAtifTrajectory(evidence.trajectory).steps.map(
        ({ source, message }) => ({
          source,
          message,
        }),
      ),
      [
        {
          source: 'system',
          message: `<system-reminder>\n${context}\n</system-reminder>`,
        },
        { source: 'user', message: 'Do the task' },
        { source: 'agent', message: 'Done' },
      ],
    );
    assert.deepEqual(evidence.warnings, []);
  });

  for (const { description, hookRecords } of [
    {
      description: 'missing context attachment',
      hookRecords: [hookSuccessRecord('plugin context')],
    },
    {
      description: 'nonmatching context attachment',
      hookRecords: [
        hookSuccessRecord('plugin context'),
        hookAdditionalContextRecord('different context'),
      ],
    },
    {
      description: 'unrendered context attachment',
      hookRecords: [
        hookSuccessRecord('plugin context'),
        { ...hookAdditionalContextRecord('plugin context'), rendered: [] },
      ],
    },
    {
      description: 'intervening metadata record',
      hookRecords: [
        hookSuccessRecord('plugin context'),
        { type: 'summary' },
        hookAdditionalContextRecord('plugin context'),
      ],
    },
    {
      description: 'new hook-success payload field',
      hookRecords: [
        {
          ...hookSuccessRecord('plugin context'),
          attachment: {
            ...hookSuccessRecord('plugin context').attachment,
            futureContent: 'unrepresented context',
          },
        },
        hookAdditionalContextRecord('plugin context'),
      ],
    },
    {
      description: 'nonempty hook-success stderr',
      hookRecords: [
        {
          ...hookSuccessRecord('plugin context'),
          attachment: {
            ...hookSuccessRecord('plugin context').attachment,
            stderr: 'unrepresented error',
          },
        },
        hookAdditionalContextRecord('plugin context'),
      ],
    },
  ]) {
    it(`reports incomplete native evidence for ${description}`, async () => {
      const evidence = await nativeEvidence(
        [
          ...hookRecords,
          {
            type: 'user',
            sessionId: 'session-1',
            message: { content: 'Do the task' },
          },
          {
            type: 'assistant',
            sessionId: 'session-1',
            message: { content: 'Done' },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n'),
      );

      assert.deepEqual(evidence, {
        kind: 'unavailable',
        reason: {
          code: 'source_incomplete',
          message:
            'Claude session evidence could not be normalized safely (attachment/hook_success at line 1).',
        },
      });
    });
  }

  it('drops empty session context and retains prompt snapshots as partial native detail', async () => {
    const evidence = await nativeEvidence(
      [
        JSON.stringify({
          type: 'attachment',
          attachment: { type: 'session_context', context: {} },
        }),
        JSON.stringify({
          type: 'attachment',
          attachment: {
            type: 'prompt_snapshot',
            systemPrompt: ['System prompt'],
          },
        }),
        JSON.stringify({
          type: 'attachment',
          attachment: {
            type: 'prompt_snapshot',
            systemPrompt: ['System prompt'],
            cliPrefix: 'CLI prefix',
            tools: [{ name: 'Read' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        }),
      ].join('\n'),
    );

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    assert.deepEqual(evidence.warnings, [
      {
        code: 'unsupported_native_event',
        message:
          'Claude prompt snapshot detail was retained only in native evidence.',
        path: 'line:2',
      },
      {
        code: 'unsupported_native_event',
        message:
          'Claude prompt snapshot detail was retained only in native evidence.',
        path: 'line:3',
      },
    ]);
  });

  it('marks known Claude attachment context as omitted optional detail', async () => {
    const evidence = await nativeEvidence(
      [
        JSON.stringify({
          type: 'attachment',
          attachment: { type: 'nested_memory' },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        }),
      ].join('\n'),
    );

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    assert.deepEqual(evidence.warnings, [
      {
        code: 'unsupported_native_event',
        message: 'Known Claude attachment context was omitted from ATIF.',
        path: 'line:1',
      },
    ]);
  });

  it('omits batching reminder bookkeeping with an explicit warning', async () => {
    const evidence = await conversationEvidence([
      {
        type: 'attachment',
        attachment: {
          type: 'batching_reminder_sent',
          model: 'claude-test',
          text: 'Synthetic bookkeeping marker',
        },
        rendered: [],
      },
    ]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available') return;
    assert.deepEqual(
      parseAtifTrajectory(evidence.trajectory).steps.map(
        ({ source }) => source,
      ),
      ['user', 'agent'],
    );
    assert.deepEqual(evidence.warnings, [
      {
        code: 'unsupported_native_event',
        message: 'Claude batching reminder bookkeeping was omitted from ATIF.',
        path: 'line:2',
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /Synthetic bookkeeping marker/,
    );
  });

  it('retains queued task notifications as system context without adding a driver turn', async () => {
    const record = queuedCommandRecord();
    const evidence = await conversationEvidence([record]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available') return;
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.deepEqual(trajectory.steps[1], {
      step_id: 2,
      source: 'system',
      message: record.rendered[0]!.content,
      timestamp: record.timestamp,
      extra: {
        native_record_type: 'attachment',
        attachment_type: 'queued_command',
      },
    });
    assert.equal(
      trajectoryCoversCompletedTurns(
        trajectory,
        [{ user: 'Do the task', assistant: 'Done', toolCalls: [] }],
        evidence.source,
      ),
      true,
    );
    assert.deepEqual(
      JSON.parse(createJudgeTranscriptProjection(trajectory).transcriptJson),
      [
        { step_id: 1, source: 'user', message: 'Do the task' },
        { step_id: 3, source: 'agent', message: 'Done' },
      ],
    );
    assert.deepEqual(evidence.warnings, []);
  });

  it('retains a queued prompt as a user step visible to judging and turn coverage', async () => {
    const record = queuedCommandRecord('prompt');
    const evidence = await conversationEvidence([
      { type: 'assistant', message: { content: 'First response' } },
      record,
    ]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available') return;
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    const projected = JSON.parse(
      createJudgeTranscriptProjection(trajectory).transcriptJson,
    );
    assert.deepEqual(projected, [
      { step_id: 1, source: 'user', message: 'Do the task' },
      { step_id: 2, source: 'agent', message: 'First response' },
      { step_id: 3, source: 'user', message: record.attachment.prompt },
      { step_id: 4, source: 'agent', message: 'Done' },
    ]);
    assert.equal(
      trajectoryCoversCompletedTurns(
        trajectory,
        [
          { user: 'Do the task', assistant: 'First response', toolCalls: [] },
          { user: record.attachment.prompt, assistant: 'Done', toolCalls: [] },
        ],
        evidence.source,
      ),
      true,
    );
    assert.equal(trajectory.steps[2]?.timestamp, record.timestamp);
    assert.deepEqual(evidence.warnings, []);
  });

  it('omits API retry metadata without copying error bodies into evidence', async () => {
    const evidence = await conversationEvidence([
      {
        type: 'system',
        subtype: 'api_error',
        source: 'request_retry',
        level: 'error',
        retryAttempt: 1,
        maxRetries: 3,
        retryInMs: 1000,
        error: { message: 'Synthetic response body' },
      },
    ]);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available') return;
    assert.equal(parseAtifTrajectory(evidence.trajectory).steps.length, 2);
    assert.deepEqual(evidence.warnings, [
      {
        code: 'unsupported_native_event',
        message: 'Claude API retry metadata was omitted from ATIF.',
        path: 'line:2',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(evidence), /Synthetic response body/);
  });

  for (const { description, record } of [
    {
      description: 'missing queued rendering',
      record: { ...queuedCommandRecord(), rendered: [] },
    },
    {
      description: 'nontext queued rendering',
      record: { ...queuedCommandRecord(), rendered: [{ content: 42 }] },
    },
    {
      description: 'mismatched notification rendering',
      record: {
        ...queuedCommandRecord(),
        rendered: [{ content: 'Different notification' }],
      },
    },
    {
      description: 'mismatched prompt rendering',
      record: {
        ...queuedCommandRecord('prompt'),
        rendered: [{ content: 'Different prompt' }],
      },
    },
    {
      description: 'unknown queued mode',
      record: queuedCommandRecord('future-mode'),
    },
    {
      description: 'empty queued prompt',
      record: {
        ...queuedCommandRecord(),
        attachment: { ...queuedCommandRecord().attachment, prompt: '' },
      },
    },
    {
      description: 'new queued field',
      record: {
        ...queuedCommandRecord(),
        attachment: {
          ...queuedCommandRecord().attachment,
          futureContent: 'Unknown',
        },
      },
    },
    {
      description: 'missing batching model',
      record: {
        type: 'attachment',
        attachment: { type: 'batching_reminder_sent', text: 'Unknown' },
      },
    },
    {
      description: 'new batching field',
      record: {
        type: 'attachment',
        attachment: {
          type: 'batching_reminder_sent',
          model: 'claude-test',
          text: 'Bookkeeping',
          futureContent: 'Unknown',
        },
      },
    },
    {
      description: 'unexpected batching rendering',
      record: {
        type: 'attachment',
        attachment: {
          type: 'batching_reminder_sent',
          model: 'claude-test',
          text: 'Bookkeeping',
        },
        rendered: [{ content: 'Unrepresented reminder' }],
      },
    },
    {
      description: 'unknown API error source',
      record: { type: 'system', subtype: 'api_error', source: 'future-source' },
    },
  ]) {
    it(`rejects ${description} without discarding the diagnostic location`, async () => {
      const evidence = await conversationEvidence([record]);
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind !== 'unavailable') return;
      assert.equal(evidence.reason.code, 'source_incomplete');
      assert.match(evidence.reason.message, /at line 2/);
    });
  }

  for (const { description, record, diagnosticKind } of [
    {
      description: 'queued command attachment',
      diagnosticKind: 'attachment/queued_command',
      record: {
        type: 'attachment',
        attachment: { type: 'queued_command' },
        rendered: [{ content: 'Queued user command' }],
      },
    },
    {
      description: 'malformed rendered attachment',
      diagnosticKind: 'attachment',
      record: {
        type: 'attachment',
        attachment: { type: 'environment' },
        rendered: [{ content: 42 }],
      },
    },
    {
      description: 'nonempty session context attachment',
      diagnosticKind: 'attachment/session_context',
      record: {
        type: 'attachment',
        attachment: { type: 'session_context', context: { mode: 'future' } },
      },
    },
    {
      description: 'malformed prompt snapshot attachment',
      diagnosticKind: 'attachment/prompt_snapshot',
      record: {
        type: 'attachment',
        attachment: { type: 'prompt_snapshot', systemPrompt: 'not-an-array' },
      },
    },
    {
      description: 'unclassified unrendered attachment',
      diagnosticKind: 'attachment',
      record: {
        type: 'attachment',
        attachment: { type: 'future_attachment', content: 'unknown content' },
      },
    },
    {
      description: 'nonempty ATIS latch',
      diagnosticKind: 'atis-latch',
      record: {
        type: 'atis-latch',
        atis: 'future-state',
        sessionId: 'session-1',
      },
    },
    {
      description: 'conversation-bearing system event',
      diagnosticKind: 'system',
      record: { type: 'system', subtype: 'local_command' },
    },
    {
      description: 'unclassified progress event',
      diagnosticKind: 'unrecognized record',
      record: { type: 'progress' },
    },
  ]) {
    it(`classifies a ${description} as incomplete`, async () => {
      const evidence = await nativeEvidence(
        [
          JSON.stringify(record),
          JSON.stringify({
            type: 'user',
            sessionId: 'session-1',
            message: { content: 'Do the task' },
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 'session-1',
            message: { content: 'Done' },
          }),
        ].join('\n'),
      );

      assert.deepEqual(evidence, {
        kind: 'unavailable',
        reason: {
          code: 'source_incomplete',
          message: `Claude session evidence could not be normalized safely (${diagnosticKind} at line 1).`,
        },
      });
    });
  }

  it('ignores meta user records before validating their conversation blocks', async () => {
    const evidence = await nativeEvidence(
      [
        JSON.stringify({
          type: 'user',
          isMeta: true,
          sessionId: 'session-1',
          message: { content: [{ type: 'future-meta-block' }] },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        }),
      ].join('\n'),
    );

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.deepEqual(
      trajectory.steps.map(({ source, message }) => ({ source, message })),
      [
        { source: 'user', message: 'Do the task' },
        { source: 'agent', message: 'Done' },
      ],
    );
    assert.deepEqual(evidence.warnings, []);
  });

  it('classifies sidechain records as incomplete primary-session evidence', async () => {
    const evidence = await nativeEvidence(
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        sessionId: 'session-1',
        message: { content: 'Subagent response' },
      }),
    );

    assert.deepEqual(evidence, {
      kind: 'unavailable',
      reason: {
        code: 'source_incomplete',
        message: 'Claude session evidence could not be normalized safely.',
      },
    });
  });

  it('preserves multiple tool-result records on their preceding agent step', async () => {
    const evidence = await nativeEvidence(
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {
            content: [
              { type: 'thinking', thinking: 'Use both tools.' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: 'Read',
                input: { path: 'a.txt' },
              },
              {
                type: 'tool_use',
                id: 'call-2',
                name: 'Write',
                input: { path: 'b.txt' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'unrelated-call',
                name: 'Edit',
                input: { path: 'unrelated.txt' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          isMeta: true,
          sessionId: 'session-1',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: 'read output',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-2',
                content: 'write output',
                is_error: true,
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: 'Done' },
        }),
      ].join('\n'),
    );

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    const toolStep = trajectory.steps[1];
    assert.ok(toolStep?.source === 'agent');
    assert.equal(toolStep.reasoning_content, 'Use both tools.');
    assert.deepEqual(toolStep.tool_calls, [
      {
        tool_call_id: 'call-1',
        function_name: 'Read',
        arguments: { path: 'a.txt' },
      },
      {
        tool_call_id: 'call-2',
        function_name: 'Write',
        arguments: { path: 'b.txt' },
      },
    ]);
    assert.equal(trajectory.session_id, 'session-1');
    assert.deepEqual(toolStep?.observation?.results, [
      { source_call_id: 'call-1', content: 'read output' },
      {
        source_call_id: 'call-2',
        content: 'write output',
        extra: { is_error: true },
      },
    ]);
    assert.equal(trajectory.steps[2]?.observation, undefined);
    assert.equal(trajectory.steps[3]?.message, 'Done');
    assert.deepEqual(evidence.warnings, []);
  });

  it('omits impossible native timestamps without discarding the session', async () => {
    const evidence = await nativeEvidence(
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2025-02-30T00:00:00Z',
          sessionId: 'session-1',
          message: { content: 'Do the task' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2025-03-01T00:00:00Z',
          sessionId: 'session-1',
          message: { content: 'Done' },
        }),
      ].join('\n'),
    );

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.equal(trajectory.steps[0]?.timestamp, undefined);
    assert.equal(trajectory.steps[1]?.timestamp, '2025-03-01T00:00:00Z');
    assert.deepEqual(evidence.warnings, [
      {
        code: 'value_omitted',
        message: 'An invalid Claude timestamp was omitted.',
        path: 'line:1',
      },
    ]);
  });
});
