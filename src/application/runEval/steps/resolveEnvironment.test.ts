import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import { resolveCredentialDeclarations } from '../../../credentialDeclarations.ts';
import { ForgeExecutionError } from '../../../execution/errors.ts';

import { resolveEnvironment } from './resolveEnvironment.ts';

vi.mock('../../../credentialDeclarations.ts', () => ({
  resolveCredentialDeclarations: vi.fn(),
}));

const input = {
  runId: 'run-1',
  specification: { variables: {}, credentials: {} },
  declarations: [],
  credentialResolver: { resolve: vi.fn() },
  signal: new AbortController().signal,
};

describe('resolveEnvironment', () => {
  it('resolves the declared credentials for this run', async () => {
    const environment = { variables: {}, credentials: {} };
    vi.mocked(resolveCredentialDeclarations).mockResolvedValue(environment);

    assert.equal(await resolveEnvironment(input), environment);
    assert.deepEqual(vi.mocked(resolveCredentialDeclarations).mock.calls[0], [
      input.specification,
      input.declarations,
      input.credentialResolver,
      { runId: 'run-1', purpose: 'forge-eval', signal: input.signal },
    ]);
  });

  it('reports a resolution failure as credential_failed during preflight', async () => {
    vi.mocked(resolveCredentialDeclarations).mockRejectedValue(
      new Error('denied'),
    );

    await assert.rejects(
      resolveEnvironment(input),
      (error: unknown) =>
        error instanceof ForgeExecutionError &&
        error.code === 'credential_failed' &&
        error.phase === 'preflight',
    );
  });
});
