import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mcpToolRefusalWarnings } from './mcpToolRefusals.ts';

describe('MCP refusal warnings', () => {
  it('omits warnings for absent and zero counts and degrades invalid data', () => {
    assert.deepEqual(mcpToolRefusalWarnings(undefined), []);
    assert.deepEqual(
      mcpToolRefusalWarnings({ state: 'available', count: 0 }),
      [],
    );
    for (const invalid of [
      null,
      { state: 'available', count: -1 },
      { state: 'available', count: Number.MAX_SAFE_INTEGER + 1 },
      { state: 'unavailable', reason: 'untrusted text' },
      { state: 'available', count: 2, content: 'untrusted text' },
    ]) {
      const warnings = mcpToolRefusalWarnings(invalid);
      assert.deepEqual(warnings[0]?.mcp_tool_refusals, {
        state: 'unavailable',
        reason: 'source_invalid',
      });
      assert.ok(!JSON.stringify(warnings).includes('untrusted text'));
    }
  });
});
