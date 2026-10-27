import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { loadClaudeNativeArtifact } from '../src/agents/claude-code/evidence.ts';
import { loadCodexNativeArtifact } from '../src/agents/codex/evidence.ts';
import { loadOpenCodeNativeArtifact } from '../src/agents/opencode/evidence.ts';
import type { AgentEvidenceContext } from '../src/contracts/agent.ts';
import type { ReadonlyWorkspace } from '../src/contracts/runtime.ts';
import { MAX_FAILURE_NATIVE_SOURCE_BYTES } from '../src/diagnostics/failureEvidence.ts';
import { createMemoryWorkspace } from '../src/testing/memoryWorkspace.ts';

const SESSION = '01999999-1111-7111-8111-111111111111';
const CODEX_PATH = `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${SESSION}.jsonl`;
const signal = new AbortController().signal;
type Observer = AgentEvidenceContext['onNativeArtifactUnavailable'];
const sources = [
  {
    name: 'Claude Code',
    path: `${SESSION}.jsonl`,
    body: '{}\n',
    load: (workspace: ReadonlyWorkspace, observer: Observer) =>
      loadClaudeNativeArtifact({
        project: workspace,
        sessionId: SESSION,
        signal,
        onNativeArtifactUnavailable: observer,
      }),
  },
  {
    name: 'Codex',
    path: CODEX_PATH,
    body: JSON.stringify({
      type: 'session_meta',
      payload: { id: SESSION, source: 'exec' },
    }),
    load: (workspace: ReadonlyWorkspace, observer: Observer) =>
      loadCodexNativeArtifact({
        home: workspace,
        sessionId: SESSION,
        signal,
        onNativeArtifactUnavailable: observer,
      }),
  },
  {
    name: 'OpenCode',
    path: 'session.json',
    body: JSON.stringify({ info: { id: 'ses_0123456789abcdefghij' } }),
    load: (workspace: ReadonlyWorkspace, observer: Observer) =>
      loadOpenCodeNativeArtifact({
        state: workspace,
        sessionId: 'ses_0123456789abcdefghij',
        signal,
        onNativeArtifactUnavailable: observer,
      }),
  },
];

describe('native artifact diagnostic reasons', () => {
  for (const source of sources) {
    it(`${source.name} reports an oversized source before reading it`, async () => {
      const workspace = createMemoryWorkspace({
        [source.path]: source.body,
      }).readonly;
      const observed: string[] = [];
      const native = await source.load(
        {
          ...workspace,
          async inspect(file) {
            const entry = await workspace.inspect(file);
            return file === source.path
              ? { ...entry, size: MAX_FAILURE_NATIVE_SOURCE_BYTES + 1 }
              : entry;
          },
          async readFile() {
            assert.fail('An oversized file must not be read.');
          },
        },
        (reason) => observed.push(reason),
      );
      assert.equal(native, undefined);
      assert.deepEqual(observed, ['too_large']);
    });
    it(`${source.name} reports a failed or missing read without copying error text`, async () => {
      const workspace = createMemoryWorkspace({
        [source.path]: source.body,
      }).readonly;
      for (const failed of [workspace, createMemoryWorkspace().readonly]) {
        const observed: string[] = [];
        assert.equal(
          await source.load(
            {
              ...failed,
              async readFile() {
                throw new Error('private synthetic error');
              },
            },
            (reason) => observed.push(reason),
          ),
          undefined,
        );
        assert.deepEqual(observed, ['read_failed']);
      }
    });
    it(`${source.name} tolerates a throwing diagnostic observer`, async () => {
      const workspace = createMemoryWorkspace().readonly;
      assert.equal(
        await source.load(workspace, () => {
          throw new Error('observer failed');
        }),
        undefined,
      );
    });
  }
  for (const source of sources.slice(1))
    it(`${source.name} reports a conflicting identity`, async () => {
      const workspace = createMemoryWorkspace({
        [source.path]: source.body.replace(
          source.name === 'Codex' ? SESSION : 'ses_0123456789abcdefghij',
          'other-session',
        ),
      }).readonly;
      const observed: string[] = [];
      assert.equal(
        await source.load(workspace, (reason) => observed.push(reason)),
        undefined,
      );
      assert.deepEqual(observed, ['identity_conflict']);
    });
});
