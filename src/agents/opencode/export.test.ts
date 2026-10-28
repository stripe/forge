import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import {
  OPEN_CODE_MODEL,
  OPEN_CODE_SESSION,
  openCodeExport,
} from '../../../test/support/opencode.ts';
import { createMemoryWorkspace } from '../../testing/index.ts';
import {
  loadOpenCodeEvidence,
  loadOpenCodeNativeArtifact,
} from './evidence.ts';
import {
  captureOpenCodeExport,
  invalidateOpenCodeExport,
  OPENCODE_EXPORT_LAUNCHER,
} from './export.ts';
import { EXPORT_PATH, MAX_NATIVE_BYTES } from './native.ts';

const body = Buffer.from(
  JSON.stringify(
    openCodeExport([{ prompt: 'Task', response: 'x'.repeat(80 * 1024) }]),
  ),
);

async function capture(
  attempts: readonly { body: Uint8Array; exitCode?: number }[],
) {
  const state = createMemoryWorkspace();
  let calls = 0;
  await captureOpenCodeExport({
    state: state.mutable,
    stateDirectory: '/state',
    executable: 'opencode',
    sessionId: OPEN_CODE_SESSION,
    signal: new AbortController().signal,
    commands: {
      async run(argv, options) {
        assert.equal(options?.timeoutMs, 30_000);
        const attempt = attempts[calls++];
        assert.ok(attempt, 'export must not exceed the expected attempts');
        if (argv[0] === 'node')
          await state.mutable.writeFile(EXPORT_PATH, attempt.body);
        return {
          stdout: Buffer.from(attempt.body.subarray(0, 4096)).toString(),
          stderr: '',
          exitCode: attempt.exitCode ?? 0,
          durationMs: 1,
        };
      },
    },
  });
  const input = {
    state: state.readonly,
    sessionId: OPEN_CODE_SESSION,
    model: OPEN_CODE_MODEL,
    agentVersion: '1.19.0',
    signal: new AbortController().signal,
  };
  return {
    calls,
    state,
    evidence: await loadOpenCodeEvidence(input),
    native: await loadOpenCodeNativeArtifact(input),
  };
}

describe('OpenCode export capture', () => {
  it('keeps exports over 64 KiB when the runner truncates piped stdout at 4 KiB', async () => {
    const result = await capture([{ body }]);
    assert.equal(result.calls, 1);
    assert.equal(result.evidence.kind, 'available');
    assert.deepEqual(Buffer.from(result.native!.body), body);
  });

  it('retries one parse failure and keeps the successful exact-session bytes', async () => {
    for (const first of [
      body.subarray(0, 4096),
      Buffer.from('{broken}'),
      Buffer.from([0xff]),
      Buffer.alloc(0),
    ]) {
      const result = await capture([{ body: first }, { body }]);
      assert.equal(result.calls, 2);
      assert.equal(result.evidence.kind, 'available');
      assert.deepEqual(Buffer.from(result.native!.body), body);
    }
  });

  it('reports a still-truncated export with its byte count and no payload', async () => {
    const partial = body.subarray(0, 4096);
    const result = await capture([{ body: partial }, { body: partial }]);
    assert.equal(result.calls, 2);
    assert.deepEqual(result.evidence, {
      kind: 'unavailable',
      reason: {
        code: 'source_truncated',
        message:
          'The OpenCode session export ended before its JSON was complete (4096 bytes).',
      },
    });
    assert.equal(result.native, undefined);
  });

  it('keeps malformed data distinct from truncated data after a bounded retry', async () => {
    const invalid = Buffer.from('{broken}');
    const result = await capture([{ body: invalid }, { body: invalid }]);
    assert.equal(result.calls, 2);
    assert.equal(result.evidence.kind, 'unavailable');
    if (result.evidence.kind === 'unavailable')
      assert.equal(result.evidence.reason.code, 'source_invalid');
    assert.equal(result.native, undefined);
  });

  it('recognizes abrupt JSON and UTF-8 endings without labeling interior corruption as truncation', async () => {
    for (const partial of [
      Buffer.from('{'),
      Buffer.from('{"info":'),
      Buffer.from('{"info":true'),
      Buffer.from('{"info":"unfinished'),
      Buffer.from('{"info":[true,'),
      Buffer.from('{"info":"世界').subarray(0, -1),
    ]) {
      const result = await capture([{ body: partial }, { body: partial }]);
      assert.equal(result.calls, 2);
      assert.equal(result.evidence.kind, 'unavailable');
      if (result.evidence.kind === 'unavailable') {
        assert.equal(result.evidence.reason.code, 'source_truncated');
        assert.ok(
          result.evidence.reason.message.includes(`${partial.length} bytes`),
        );
      }
    }
    for (const invalid of [
      Buffer.from([0xff]),
      Buffer.from('{"x":!}'),
      Buffer.from('{"x":!,"y":"世界').subarray(0, -1),
      Buffer.from('{}世界').subarray(0, -1),
    ]) {
      const result = await capture([{ body: invalid }, { body: invalid }]);
      assert.equal(result.calls, 2);
      assert.equal(result.evidence.kind, 'unavailable');
      if (result.evidence.kind === 'unavailable')
        assert.equal(result.evidence.reason.code, 'source_invalid');
    }
  });

  it('rejects mismatched sessions without retrying', async () => {
    const wrong = openCodeExport([{ prompt: 'Task', response: 'Done' }]);
    wrong.info.id = 'ses_other';
    const result = await capture([
      { body: Buffer.from(JSON.stringify(wrong)) },
    ]);
    assert.equal(result.calls, 1);
    assert.equal(result.evidence.kind, 'unavailable');
    if (result.evidence.kind === 'unavailable')
      assert.equal(result.evidence.reason.code, 'source_invalid');
    assert.equal(result.native, undefined);
  });

  it('clears an oversized file rejected after a custom runner exits', async () => {
    const result = await capture([
      { body: Buffer.alloc(MAX_NATIVE_BYTES + 1, ' ') },
    ]);
    assert.equal(result.calls, 1);
    assert.equal(result.evidence.kind, 'unavailable');
    assert.equal((await result.state.readonly.readFile(EXPORT_PATH)).length, 0);
    assert.equal(result.native, undefined);
  });

  it('records successful empty output as truncated at 0 bytes after exactly one retry', async () => {
    const empty = Buffer.alloc(0);
    const result = await capture([{ body: empty }, { body: empty }]);
    assert.equal(result.calls, 2);
    assert.deepEqual(result.evidence, {
      kind: 'unavailable',
      reason: {
        code: 'source_truncated',
        message:
          'The OpenCode session export ended before its JSON was complete (0 bytes).',
      },
    });
    assert.equal(result.native, undefined);

    await invalidateOpenCodeExport(result.state.mutable);
    const unattempted = await loadOpenCodeEvidence({
      state: result.state.readonly,
      sessionId: OPEN_CODE_SESSION,
      model: OPEN_CODE_MODEL,
      agentVersion: '1.19.0',
      signal: new AbortController().signal,
    });
    assert.equal(unattempted.kind, 'unavailable');
    if (unattempted.kind === 'unavailable')
      assert.equal(unattempted.reason.code, 'source_unavailable');
  });

  it('does not treat an empty failed command as a successful empty export', async () => {
    const empty = Buffer.alloc(0);
    for (const attempts of [
      [{ body: empty, exitCode: 1 }],
      [{ body: empty }, { body: empty, exitCode: 1 }],
    ]) {
      const result = await capture(attempts);
      assert.equal(result.calls, attempts.length);
      assert.equal(result.evidence.kind, 'unavailable');
      if (result.evidence.kind === 'unavailable')
        assert.equal(result.evidence.reason.code, 'source_unavailable');
    }
  });

  it('rejects foreign, malformed, or oversized empty-export receipts without exposing their content', async () => {
    const state = createMemoryWorkspace();
    await state.mutable.writeFile(EXPORT_PATH, new Uint8Array());
    for (const receipt of [
      JSON.stringify({ sessionId: 'ses_other', byteCount: 0 }),
      JSON.stringify({
        sessionId: OPEN_CODE_SESSION,
        byteCount: 0,
        extra: true,
      }),
      JSON.stringify({ sessionId: OPEN_CODE_SESSION, byteCount: 1 }),
      '{private payload',
      'x'.repeat(513),
    ]) {
      await state.mutable.writeFile(
        'session-export-empty.json',
        Buffer.from(receipt),
      );
      const evidence = await loadOpenCodeEvidence({
        state: state.readonly,
        sessionId: OPEN_CODE_SESSION,
        model: OPEN_CODE_MODEL,
        agentVersion: '1.19.0',
        signal: new AbortController().signal,
      });
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind === 'unavailable') {
        assert.equal(evidence.reason.code, 'source_invalid');
        assert.ok(!evidence.reason.message.includes(receipt));
      }
    }
  });

  it('does not accept file bytes from a failed export command', async () => {
    const result = await capture([{ body, exitCode: 1 }]);
    assert.equal(result.calls, 1);
    assert.equal(result.evidence.kind, 'unavailable');
    if (result.evidence.kind === 'unavailable')
      assert.equal(result.evidence.reason.code, 'source_unavailable');
    assert.equal(result.native, undefined);
  });

  it('gives real child stdout a regular file and retains a large exit-time write', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forge-opencode-export-'));
    try {
      const output = path.join(root, 'session.json');
      await writeFile(output, '', { mode: 0o600 });
      const launched = spawnSync(process.execPath, [
        '-e',
        OPENCODE_EXPORT_LAUNCHER,
        output,
        process.execPath,
        '-e',
        `
const fs = require('node:fs');
if (!fs.fstatSync(1).isFile()) process.exit(2);
process.stdout.write(JSON.stringify({ info: { id: 'ses_test' }, text: 'x'.repeat(543 * 1024) }));
process.exit(0);
`,
      ]);
      assert.equal(launched.status, 0, launched.stderr.toString());
      assert.equal(launched.stdout.length, 0);
      const value = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(value.info.id, 'ses_test');
      assert.equal(value.text.length, 543 * 1024);
      assert.equal((await stat(output)).mode & 0o777, 0o600);

      const linked = path.join(root, 'linked.json');
      await symlink(output, linked);
      const refused = spawnSync(process.execPath, [
        '-e',
        OPENCODE_EXPORT_LAUNCHER,
        linked,
        process.execPath,
        '-e',
        'process.exit(0)',
      ]);
      assert.equal(refused.status, 1);
      assert.equal(await readFile(output, 'utf8'), JSON.stringify(value));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops a runaway export while it writes and removes its oversized file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forge-opencode-size-'));
    try {
      const output = path.join(root, 'session.json');
      const completed = path.join(root, 'finished');
      for (const continuous of [true, false]) {
        await writeFile(output, '', { mode: 0o600 });
        const launched = spawnSync(
          process.execPath,
          [
            '-e',
            OPENCODE_EXPORT_LAUNCHER,
            output,
            process.execPath,
            '-e',
            continuous
              ? `
const fs = require('node:fs');
const block = Buffer.alloc(64 * 1024);
let bytes = 0;
setInterval(() => {
  fs.writeSync(1, block);
  bytes += block.length;
  if (bytes > ${MAX_NATIVE_BYTES * 2}) {
    fs.writeFileSync(process.argv[1], 'should have stopped');
    process.exit(0);
  }
}, 1);
`
              : `require('node:fs').writeSync(1, Buffer.alloc(${MAX_NATIVE_BYTES + 1}));`,
            completed,
          ],
          { timeout: 3000 },
        );
        assert.equal(launched.error, undefined);
        assert.equal(launched.signal, null);
        assert.equal(launched.status, 1, launched.stderr.toString());
        await assert.rejects(access(output), { code: 'ENOENT' });
        await assert.rejects(access(completed), { code: 'ENOENT' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
