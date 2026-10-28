import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  countMcpToolCalls,
  EMPTY_MCP_TOOL_CALL_COUNTS,
  mcpToolCallNames,
  mergeMcpToolCallCounts,
} from './mcpToolCallCounts.ts';

function toolCall(name: unknown) {
  return {
    method: 'tools/call',
    params: { name, arguments: { omit: 'synthetic-input' } },
  };
}

function names(document: unknown) {
  return mcpToolCallNames(Buffer.from(JSON.stringify(document)));
}

describe('MCP tool call observations', () => {
  it('buckets names containing credentials while keeping the transformation pure', () => {
    const body = Buffer.from(
      JSON.stringify([
        toolCall('tool_synthetic-key'),
        toolCall('synthetic-token'),
        toolCall('safe_tool'),
      ]),
    );
    assert.deepEqual(
      countMcpToolCalls(
        mcpToolCallNames(body, ['synthetic-key', 'synthetic-token']),
      ),
      {
        tools: { safe_tool: 1 },
        other: 2,
        unparsed: 0,
        overflow: 0,
      },
    );
    assert.equal(
      countMcpToolCalls(mcpToolCallNames(body)).tools['tool_synthetic-key'],
      1,
    );
  });

  it('reads only tool-call names and ignores discovery, arguments, and results', () => {
    assert.deepEqual(
      [
        ...names([
          { method: 'initialize' },
          { method: 'tools/list' },
          { method: 'notifications/initialized' },
          { ...toolCall('records.create-v2_1'), result: 'synthetic-output' },
        ]),
      ],
      [{ kind: 'tool', name: 'records.create-v2_1', count: 1 }],
    );
  });

  it('counts every call in a batch without classifying reads or writes', () => {
    assert.deepEqual(
      countMcpToolCalls(
        names([
          toolCall('records.read'),
          toolCall('records.create'),
          toolCall('records.read'),
        ]),
      ),
      {
        tools: { 'records.read': 2, 'records.create': 1 },
        other: 0,
        unparsed: 0,
        overflow: 0,
      },
    );
  });

  it('buckets missing, unsafe, and overlong names without retaining them', () => {
    const safe = 'a'.repeat(128);
    const unsafe = [
      '',
      'has space',
      'name/with/path',
      'line\nbreak',
      'é',
      'a'.repeat(129),
      42,
      null,
    ];
    const counts = countMcpToolCalls(
      names([
        toolCall(safe),
        ...unsafe.map(toolCall),
        { method: 'tools/call' },
        { method: 'tools/call', params: 'invalid' },
      ]),
    );
    assert.deepEqual(counts, {
      tools: { [safe]: 1 },
      other: 10,
      unparsed: 0,
      overflow: 0,
    });
    assert.ok(!JSON.stringify(counts).includes('synthetic-input'));
  });

  for (const body of [
    '',
    '{broken',
    'null',
    '42',
    '[]',
    '[null,{},[]]',
    Buffer.from([0xff]),
  ])
    it(`records unparsed input without throwing (${typeof body === 'string' ? body : 'invalid UTF-8'})`, () => {
      const counts = countMcpToolCalls(mcpToolCallNames(Buffer.from(body)));
      assert.deepEqual(counts, {
        tools: {},
        other: 0,
        unparsed: typeof body === 'string' && body.startsWith('[null') ? 3 : 1,
        overflow: 0,
      });
    });

  it('keeps safe prototype-like and bucket-like tool names separate from buckets', () => {
    const counts = countMcpToolCalls(
      names([
        toolCall('__proto__'),
        toolCall('constructor'),
        toolCall('other'),
        toolCall('unparsed'),
        toolCall('overflow'),
        toolCall('unsafe/name'),
      ]),
    );
    assert.deepEqual(
      counts.tools,
      Object.fromEntries([
        ['__proto__', 1],
        ['constructor', 1],
        ['other', 1],
        ['unparsed', 1],
        ['overflow', 1],
      ]),
    );
    assert.equal(counts.other, 1);
    assert.equal(Object.getPrototypeOf(counts.tools), Object.prototype);
  });

  it('retains at most 64 names across bodies and keeps counting known names after overflow', () => {
    const first = countMcpToolCalls(
      names(
        Array.from({ length: 65 }, (_, index) => toolCall(`tool_${index}`)),
      ),
    );
    const next = countMcpToolCalls(
      names([toolCall('tool_0'), toolCall('tool_64'), toolCall('tool_65')]),
      first,
    );
    assert.equal(Object.keys(next.tools).length, 64);
    assert.equal(next.tools.tool_0, 2);
    assert.equal(next.tools.tool_64, undefined);
    assert.equal(next.overflow, 3);
    assert.equal(first.tools.tool_0, 1);
    assert.equal(first.overflow, 1);
    assert.deepEqual(EMPTY_MCP_TOOL_CALL_COUNTS, {
      tools: {},
      other: 0,
      unparsed: 0,
      overflow: 0,
    });
  });

  it('merges relay snapshots under one run-wide name cap', () => {
    const first = countMcpToolCalls(
      names(
        Array.from({ length: 40 }, (_, index) => toolCall(`tool_${index}`)),
      ),
    );
    const second = countMcpToolCalls(
      names(
        Array.from({ length: 41 }, (_, index) =>
          toolCall(`tool_${index + 39}`),
        ),
      ),
    );
    const merged = mergeMcpToolCallCounts([first, second]);
    assert.equal(Object.keys(merged.tools).length, 64);
    assert.equal(merged.tools.tool_39, 2);
    assert.equal(merged.overflow, 16);
    assert.deepEqual(mergeMcpToolCallCounts([]), EMPTY_MCP_TOOL_CALL_COUNTS);
  });
});
