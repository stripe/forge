import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { bypassesUpstreamProxy } from './mcpUpstreamProxy.ts';

describe('relay upstream no_proxy matching', () => {
  const url = new URL('https://mcp.stripe.com/');
  for (const [noProxy, expected] of [
    [undefined, false],
    ['', false],
    ['*', true],
    ['mcp.stripe.com', true],
    ['.stripe.com', true],
    ['*.stripe.com', true],
    ['stripe.com', false],
    ['mcp.stripe.com:443', true],
    ['mcp.stripe.com:8443', false],
    ['localhost, .localhost,mcp.stripe.com', true],
    ['other.com,.example.org', false],
  ] as const)
    it(`${noProxy ?? 'unset'} -> ${expected}`, () => {
      assert.equal(bypassesUpstreamProxy(url, noProxy), expected);
    });
});
