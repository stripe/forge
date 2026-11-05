import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import {
  type PreparedCompletionRuntime,
  prepareCompletionRuntime,
} from '../../../execution/completionRuntime.ts';
import { ForgeExecutionError } from '../../../execution/errors.ts';

import { prepareCompletions } from './prepareCompletions.ts';

vi.mock('../../../execution/completionRuntime.ts', () => ({
  prepareCompletionRuntime: vi.fn(),
}));

const input = {
  runId: 'run-1',
  bindings: [],
  credentialResolver: { resolve: vi.fn() },
  environment: {
    variables: {},
    credentials: { API_KEY: { value: 'sk_one', scopes: ['agent'] as const } },
  },
  signal: new AbortController().signal,
};

describe('prepareCompletions', () => {
  it('prepares the providers, redacting the run credentials', async () => {
    const runtime = { secrets: [] } as unknown as PreparedCompletionRuntime;
    vi.mocked(prepareCompletionRuntime).mockResolvedValue(runtime);

    assert.equal(await prepareCompletions(input), runtime);
    assert.deepEqual(vi.mocked(prepareCompletionRuntime).mock.calls[0]?.[0], {
      runId: 'run-1',
      bindings: [],
      credentialResolver: input.credentialResolver,
      redactionSecrets: ['sk_one'],
      signal: input.signal,
    });
  });

  it('reports a provider failure as credential_failed during preflight', async () => {
    vi.mocked(prepareCompletionRuntime).mockRejectedValue(new Error('no key'));

    await assert.rejects(
      prepareCompletions(input),
      (error: unknown) =>
        error instanceof ForgeExecutionError &&
        error.code === 'credential_failed' &&
        error.phase === 'preflight',
    );
  });
});
