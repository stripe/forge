import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ReadonlyWorkspace,
  WorkspaceEntry,
  WorkspaceListOptions,
} from '../contracts/runtime.js';
import {
  boundJudgeWorkspaceEvidence,
  collectJudgeWorkspaceEvidence,
  MAX_JUDGE_WORKSPACE_ENTRIES,
  MAX_JUDGE_WORKSPACE_FILE_CHARACTERS,
  MAX_JUDGE_WORKSPACE_READ_BYTES,
  MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS,
  renderJudgeWorkspaceEvidence,
} from './judgeWorkspace.js';

interface WorkspaceFixture {
  readonly workspace: ReadonlyWorkspace;
  readonly listOptions: WorkspaceListOptions[];
  readonly reads: Array<{ path: string; maxBytes: number | undefined }>;
}

function fixture(
  options: {
    entries?: readonly WorkspaceEntry[];
    bodies?: Readonly<Record<string, string | Uint8Array>>;
    listError?: Error;
    readErrors?: Readonly<Record<string, Error>>;
  } = {},
): WorkspaceFixture {
  const entries = [...(options.entries ?? [])];
  const bodies = new Map(
    Object.entries(options.bodies ?? {}).map(([path, body]) => [
      path,
      typeof body === 'string' ? Uint8Array.from(Buffer.from(body)) : body,
    ]),
  );
  const listOptions: WorkspaceListOptions[] = [];
  const reads: Array<{ path: string; maxBytes: number | undefined }> = [];
  const workspace: ReadonlyWorkspace = {
    async inspect(path) {
      return (
        entries.find((entry) => entry.path === path) ?? {
          path,
          kind: 'absent',
        }
      );
    },
    async listFiles(request = {}) {
      listOptions.push(request);
      request.signal?.throwIfAborted();
      if (options.listError) throw options.listError;
      if (
        request.maxEntries !== undefined &&
        entries.length > request.maxEntries
      ) {
        throw new Error(
          `Workspace exceeds its ${request.maxEntries} entry limit.`,
        );
      }
      return entries;
    },
    async readFile(path, request = {}) {
      reads.push({ path, maxBytes: request.maxBytes });
      const readError = options.readErrors?.[path];
      if (readError) throw readError;
      const body = bodies.get(path);
      if (body === undefined) throw new Error(`Missing fixture body: ${path}`);
      if (
        request.maxBytes !== undefined &&
        body.byteLength > request.maxBytes
      ) {
        throw new Error(`File exceeds its ${request.maxBytes} byte limit.`);
      }
      return Uint8Array.from(body);
    },
  };
  return { workspace, listOptions, reads };
}

function file(path: string, size: number): WorkspaceEntry {
  return { path, kind: 'file', size };
}

describe('collectJudgeWorkspaceEvidence', () => {
  it('returns empty, complete, JSON-safe evidence for an empty workspace', async () => {
    const collected = await collectJudgeWorkspaceEvidence(fixture().workspace);

    assert.deepEqual(collected, {
      evidence: {
        entries: [],
        complete: true,
        truncated: false,
        bytes_read: 0,
        warnings: [],
      },
      renderedText: '',
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(collected.evidence)),
      collected.evidence,
    );
  });

  it('sorts files lexically and binds the exact rendered judge text', async () => {
    const test = fixture({
      entries: [file('z.txt', 4), file('a.txt', 5)],
      bodies: { 'z.txt': 'last', 'a.txt': 'first' },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace);

    assert.deepEqual(
      collected.evidence.entries.map(({ path }) => path),
      ['a.txt', 'z.txt'],
    );
    assert.equal(collected.evidence.bytes_read, 9);
    assert.ok(
      collected.renderedText.indexOf('### a.txt') <
        collected.renderedText.indexOf('### z.txt'),
    );
    assert.match(collected.renderedText, /### a\.txt\n```\nfirst\n```/);
    assert.match(collected.renderedText, /### z\.txt\n```\nlast\n```/);
    for (const entry of collected.evidence.entries) {
      assert.ok(collected.renderedText.includes(entry.content));
    }
  });

  it('skips noise directories and binary or lock extensions', async () => {
    const test = fixture({
      entries: [
        file('.git/config', 3),
        file('.claude/settings.json', 3),
        file('.agents/rules.md', 3),
        file('.codex/session.jsonl', 3),
        file('.cursor/state.json', 3),
        file('.venv/lib/package.py', 3),
        file('venv/lib/package.py', 3),
        file('node_modules/pkg/index.js', 3),
        file('vendor/pkg/index.js', 3),
        file('__pycache__/cache.pyc', 3),
        file('.cache/output.txt', 3),
        file('.mypy_cache/state.json', 3),
        file('.next/output.txt', 3),
        file('.pytest_cache/state.txt', 3),
        file('.ruff_cache/state.txt', 3),
        file('.tox/state.txt', 3),
        file('dist/output.js', 3),
        file('build/output.js', 3),
        file('coverage/output.json', 3),
        file('out/output.js', 3),
        file('target/output.bin', 3),
        file('logo.PNG', 3),
        file('package-lock.json', 3),
        file('pnpm-lock.yaml', 3),
        file('npm-shrinkwrap.json', 3),
        file('yarn.lock', 3),
        file('src/app.ts', 4),
      ],
      bodies: { 'src/app.ts': 'keep' },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace);

    assert.deepEqual(
      collected.evidence.entries.map(({ path }) => path),
      ['src/app.ts'],
    );
    assert.deepEqual(
      test.reads.map(({ path }) => path),
      ['src/app.ts'],
    );
    assert.doesNotMatch(collected.renderedText, /node_modules|logo\.PNG|\.git/);
  });

  it('does not read symlinks or paths reported below a symlink', async () => {
    const test = fixture({
      entries: [
        { path: 'linked', kind: 'symlink' },
        file('linked/host-secret.txt', 11),
        file('safe.txt', 4),
      ],
      bodies: { 'linked/host-secret.txt': 'host-secret', 'safe.txt': 'safe' },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace);

    assert.deepEqual(
      test.reads.map(({ path }) => path),
      ['safe.txt'],
    );
    assert.doesNotMatch(collected.renderedText, /host-secret/);
  });

  it('enforces the hard entry bound and allows callers only to tighten it', async () => {
    const hardBound = fixture();
    await collectJudgeWorkspaceEvidence(hardBound.workspace, {
      maxEntries: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(
      hardBound.listOptions[0]?.maxEntries,
      MAX_JUDGE_WORKSPACE_ENTRIES,
    );

    const limited = fixture({
      entries: [file('a.txt', 1), file('b.txt', 1)],
      bodies: { 'a.txt': 'a', 'b.txt': 'b' },
    });
    const collected = await collectJudgeWorkspaceEvidence(limited.workspace, {
      maxEntries: 1,
    });
    assert.equal(collected.evidence.truncated, true);
    assert.equal(collected.evidence.entries.length, 0);
    assert.equal(
      collected.evidence.warnings[0]?.code,
      'workspace_entry_limit_reached',
    );
  });

  it('stops in lexical order before evidence beyond the depth bound', async () => {
    const test = fixture({
      entries: [file('a.txt', 1), file('level/too/deep.txt', 4)],
      bodies: { 'a.txt': 'a', 'level/too/deep.txt': 'deep' },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace, {
      maxDepth: 1,
    });

    assert.deepEqual(
      collected.evidence.entries.map(({ path }) => path),
      ['a.txt'],
    );
    assert.equal(
      collected.evidence.warnings.at(-1)?.code,
      'workspace_depth_limit_reached',
    );
    assert.deepEqual(
      test.reads.map(({ path }) => path),
      ['a.txt'],
    );
  });

  it('stops before reading past the aggregate byte bound', async () => {
    const test = fixture({
      entries: [file('a.txt', 8), file('b.txt', 11)],
      bodies: { 'a.txt': '12345678', 'b.txt': 'DO_NOT_READ' },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace, {
      maxReadBytes: 8,
    });

    assert.deepEqual(
      test.reads.map(({ path }) => path),
      ['a.txt'],
    );
    assert.equal(collected.evidence.bytes_read, 8);
    assert.equal(
      collected.evidence.warnings.at(-1)?.code,
      'workspace_read_limit_reached',
    );
    assert.doesNotMatch(collected.renderedText, /DO_NOT_READ/);
  });

  it('never asks the workspace to exceed the hard aggregate read bound', async () => {
    const test = fixture({
      entries: [file('a.txt', 1)],
      bodies: { 'a.txt': 'a' },
    });

    await collectJudgeWorkspaceEvidence(test.workspace, {
      maxReadBytes: Number.MAX_SAFE_INTEGER,
    });

    assert.equal(test.reads[0]?.maxBytes, MAX_JUDGE_WORKSPACE_READ_BYTES);
  });

  it('persists and renders only the bounded per-file text', async () => {
    const test = fixture({
      entries: [file('large.txt', 6)],
      bodies: { 'large.txt': 'abcdef' },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace, {
      maxCharactersPerFile: 3,
    });

    assert.deepEqual(collected.evidence.entries[0], {
      path: 'large.txt',
      size_bytes: 6,
      bytes_read: 6,
      content: 'abc',
      truncated: true,
    });
    assert.match(collected.renderedText, /```\nabc\n```/);
    assert.doesNotMatch(collected.renderedText, /def/);
    assert.equal(
      collected.evidence.warnings[0]?.code,
      'workspace_file_truncated',
    );
  });

  it('uses a longer fence when file content contains Markdown fences', async () => {
    const test = fixture({
      entries: [file('prompt.md', 15)],
      bodies: { 'prompt.md': 'before ``` after' },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace);

    assert.match(
      collected.renderedText,
      /### prompt\.md\n````\nbefore ``` after\n````/,
    );
  });

  it('bounds the complete rendered section including its header and warning', async () => {
    const paths = Array.from(
      { length: 10 },
      (_, index) => `${String.fromCharCode('a'.charCodeAt(0) + index)}.txt`,
    );
    const test = fixture({
      entries: paths.map((path) => file(path, 1)),
      bodies: Object.fromEntries(paths.map((path) => [path, path[0]!])),
    });

    const limit = 110;
    const collected = await collectJudgeWorkspaceEvidence(test.workspace, {
      maxTotalCharacters: limit,
    });

    assert.deepEqual(
      collected.evidence.entries.map(({ path }) => path),
      ['a.txt'],
    );
    assert.equal(
      collected.evidence.warnings.at(-1)?.code,
      'workspace_output_limit_reached',
    );
    assert.ok(collected.renderedText.length <= limit);
    assert.doesNotMatch(collected.renderedText, /### b\.txt/);
  });

  it('bounds many rendered read warnings and preserves an explicit cutoff', async () => {
    const paths = Array.from(
      { length: 40 },
      (_, index) => `unreadable-${String(index).padStart(2, '0')}.txt`,
    );
    const readErrors = Object.fromEntries(
      paths.map((path) => [path, new Error('private read detail')]),
    );
    const test = fixture({
      entries: paths.map((path) => file(path, 1)),
      readErrors,
    });

    const limit = 500;
    const collected = await collectJudgeWorkspaceEvidence(test.workspace, {
      maxTotalCharacters: limit,
    });

    assert.ok(collected.renderedText.length <= limit);
    assert.equal(collected.evidence.complete, false);
    assert.equal(collected.evidence.truncated, true);
    assert.ok(
      collected.evidence.warnings.some(
        ({ code }) => code === 'workspace_read_unavailable',
      ),
    );
    assert.equal(
      collected.evidence.warnings.at(-1)?.code,
      'workspace_output_limit_reached',
    );
    assert.doesNotMatch(collected.renderedText, /private read detail/);
  });

  it('re-bounds per-file and total text after a redaction-like expansion', () => {
    const expanded = boundJudgeWorkspaceEvidence({
      entries: [
        {
          path: 'expanded.txt',
          size_bytes: 2,
          bytes_read: 2,
          content: '[REDACTED]'.repeat(20_000),
          truncated: false,
        },
      ],
      complete: true,
      truncated: false,
      bytes_read: 2,
      warnings: [],
    });
    const rendered = renderJudgeWorkspaceEvidence(expanded);

    assert.ok(
      (expanded.entries[0]?.content.length ?? 0) <=
        MAX_JUDGE_WORKSPACE_FILE_CHARACTERS,
    );
    assert.ok(rendered.length <= MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS);
    assert.equal(expanded.complete, false);
    assert.equal(expanded.truncated, true);
    assert.ok(
      expanded.warnings.some(({ code }) => code === 'workspace_file_truncated'),
    );
  });

  it('uses completeness flags when a tightened limit cannot fit a warning', () => {
    const bounded = boundJudgeWorkspaceEvidence(
      {
        entries: [
          {
            path: 'file.txt',
            size_bytes: 1,
            bytes_read: 1,
            content: 'x',
            truncated: false,
          },
        ],
        complete: true,
        truncated: false,
        bytes_read: 1,
        warnings: [],
      },
      0,
    );

    assert.equal(renderJudgeWorkspaceEvidence(bounded), '');
    assert.equal(bounded.complete, false);
    assert.equal(bounded.truncated, true);
    assert.deepEqual(bounded.warnings, []);
  });

  it('records a safe warning and continues after an unreadable file', async () => {
    const test = fixture({
      entries: [file('a.txt', 1), file('b.txt', 1)],
      bodies: { 'b.txt': 'b' },
      readErrors: { 'a.txt': new Error('sensitive raw failure') },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace);

    assert.deepEqual(
      collected.evidence.entries.map(({ path }) => path),
      ['b.txt'],
    );
    assert.deepEqual(collected.evidence.warnings, [
      {
        code: 'workspace_read_unavailable',
        message: 'A sealed workspace file could not be read safely.',
        path: 'a.txt',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(collected), /sensitive raw failure/);
  });

  it('returns a truncation warning without listing when the deadline is zero', async () => {
    const test = fixture({
      entries: [file('a.txt', 1)],
      bodies: { 'a.txt': 'a' },
    });

    const collected = await collectJudgeWorkspaceEvidence(test.workspace, {
      maxDurationMs: 0,
    });

    assert.equal(test.listOptions.length, 0);
    assert.equal(
      collected.evidence.warnings[0]?.code,
      'workspace_time_limit_reached',
    );
    assert.match(collected.renderedText, /time limit of 0ms reached/);
  });

  it('throws the caller abort reason rather than persisting partial evidence', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);

    await assert.rejects(
      collectJudgeWorkspaceEvidence(fixture().workspace, {
        signal: controller.signal,
      }),
      (error: unknown) => error === reason,
    );
  });
});
