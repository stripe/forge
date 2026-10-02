import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import type {ReadonlyWorkspace, WorkspaceEntry} from '../contracts/runtime.js';
import {collectWorkspaceEvidence, runWorkspaceChecks} from './checks.js';

function workspace(files: Record<string, string>): ReadonlyWorkspace {
  return {
    async inspect(relativePath): Promise<WorkspaceEntry> {
      const value = files[relativePath];
      return value === undefined
        ? {path: relativePath, kind: 'absent'}
        : {path: relativePath, kind: 'file', size: Buffer.byteLength(value)};
    },
    async readFile(relativePath) {
      const value = files[relativePath];
      if (value === undefined) throw new Error('missing');
      return Buffer.from(value);
    },
    async listFiles() {
      return [];
    },
  };
}

describe('workspace checks', () => {
  it('persists exact grading bytes and evaluates existence/content', async () => {
    const checks = {
      files_created: ['greeting.txt'],
      file_checks: [
        {file: 'greeting.txt', exists: true, contains: 'Hello, world!'},
        {file: 'missing.txt', exists: false},
      ],
    };
    const evidence = await collectWorkspaceEvidence(
      workspace({'greeting.txt': 'Hello, world!\n'}),
      checks,
    );
    expect(evidence.schema_version).toBe(2);
    expect(evidence.entries[0]).toEqual({
      path: 'greeting.txt',
      exists: true,
      kind: 'file',
      size_bytes: 14,
      content_base64: Buffer.from('Hello, world!\n').toString('base64'),
    });
    expect(runWorkspaceChecks(checks, evidence).every(({passed}) => passed)).toBe(true);
  });
});
