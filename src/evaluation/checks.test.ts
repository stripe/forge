import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {AtifTrajectoryV1_8} from '../atif/index.js';
import type {ReadonlyWorkspace, WorkspaceEntry} from '../contracts/runtime.js';
import type {GuidelineResultV1} from '../results/types.js';
import {createTestResolvedRunPlan} from '../testing/plans.js';
import {
  UnsupportedEvaluationCapabilityError,
  collectWorkspaceEvidence,
  evaluateRunEvidence,
  runWorkspaceChecks,
} from './checks.js';

function workspace(files: Record<string, string | Uint8Array>): ReadonlyWorkspace {
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
    const body = Buffer.from('\ufeffHello, café!\r\n\0');
    const prefix = Buffer.from('excluded prefix');
    const backing = Buffer.concat([prefix, body, Buffer.from('excluded suffix')]);
    const view = backing.subarray(prefix.byteLength, prefix.byteLength + body.byteLength);
    const checks = {
      files_created: ['greeting.txt'],
      file_checks: [
        {file: 'greeting.txt', exists: true, contains: '^\ufeffHello, café!\r\n\0$'},
        {file: 'missing.txt', exists: false},
      ],
    };
    const evidence = await collectWorkspaceEvidence(
      workspace({'greeting.txt': view}),
      checks,
    );
    assert.equal(evidence.schema_version, 1);
    assert.deepEqual(evidence.entries[0], {
      path: 'greeting.txt',
      exists: true,
      kind: 'file',
      size_bytes: body.byteLength,
      content_base64: body.toString('base64'),
    });
    assert.deepEqual(Buffer.from(evidence.entries[0]!.content_base64!, 'base64'), body);
    assert.equal(runWorkspaceChecks(checks, evidence).every(({passed}) => passed), true);
  });

  it('reads only distinct requested paths in lexical order with the grading byte limit', async () => {
    const base = workspace({'a.txt': 'a', 'z.txt': 'z'});
    const calls: Array<{path: string; maxBytes?: number}> = [];
    const checks = {
      files_created: ['z.txt', 'a.txt', 'a.txt'],
      file_checks: [{file: 'z.txt', exists: true, contains: 'z'}],
    };
    const evidence = await collectWorkspaceEvidence({
      ...base,
      async readFile(path, options) {
        calls.push({path, ...options});
        return base.readFile(path, options);
      },
      async listFiles() {
        assert.fail('Deterministic checks must not scan unrelated workspace files.');
      },
    }, checks);

    assert.deepEqual(calls, [
      {path: 'a.txt', maxBytes: 256_000},
      {path: 'z.txt', maxBytes: 256_000},
    ]);
    assert.deepEqual(evidence.entries.map(({path}) => path), ['a.txt', 'z.txt']);
    assert.equal(evidence.complete, true);
    assert.deepEqual(evidence.warnings, []);
  });

  it('does not read symlinks or non-files, and cannot match their uncaptured content', async () => {
    const entries: Record<string, WorkspaceEntry> = {
      'link.txt': {path: 'link.txt', kind: 'symlink'},
      'directory': {path: 'directory', kind: 'directory'},
      'missing.txt': {path: 'missing.txt', kind: 'absent'},
    };
    const checks = {
      files_created: ['link.txt', 'missing.txt'],
      file_checks: [
        {file: 'link.txt', exists: true, contains: 'host secret'},
        {file: 'directory', exists: true, contains: 'host secret'},
        {file: 'missing.txt', exists: false},
      ],
    };
    const evidence = await collectWorkspaceEvidence({
      async inspect(path) { return entries[path]!; },
      async readFile() { assert.fail('Non-files must never be read.'); },
      async listFiles() { return []; },
    }, checks);

    assert.deepEqual(evidence.entries, [
      {path: 'directory', exists: true, kind: 'directory'},
      {
        path: 'link.txt', exists: true, kind: 'other',
        issue: 'Symbolic links are not valid grading evidence.',
      },
      {path: 'missing.txt', exists: false, kind: 'missing'},
    ]);
    assert.deepEqual(runWorkspaceChecks(checks, evidence).map(({passed}) => passed),
      [false, false, true, false, true, false, true]);
  });

  it('records safe unavailable evidence after inspect/read failures and continues grading', async () => {
    const base = workspace({'a-read.txt': 'unavailable', 'z-safe.txt': 'safe'});
    const checks = {
      files_created: ['b-inspect.txt', 'z-safe.txt'],
      file_checks: [{file: 'a-read.txt', exists: true, contains: 'unavailable'}],
    };
    const evidence = await collectWorkspaceEvidence({
      ...base,
      async inspect(path) {
        if (path === 'b-inspect.txt') throw new Error('private inspect failure');
        return base.inspect(path);
      },
      async readFile(path, options) {
        if (path === 'a-read.txt') throw new Error('private read exceeded limit');
        return base.readFile(path, options);
      },
    }, checks);

    assert.equal(evidence.complete, false);
    assert.deepEqual(evidence.warnings, [
      {code: 'workspace_evidence_unavailable', path: 'a-read.txt', message: 'Workspace evidence exceeded its byte limit.'},
      {code: 'workspace_evidence_unavailable', path: 'b-inspect.txt', message: 'Workspace evidence could not be read safely.'},
    ]);
    assert.doesNotMatch(JSON.stringify(evidence), /private/);
    assert.deepEqual(runWorkspaceChecks(checks, evidence), [
      {name: 'file_created: b-inspect.txt', passed: false, detail: 'Workspace evidence could not be read safely.'},
      {name: 'file_created: z-safe.txt', passed: true},
      {name: 'file_exists: a-read.txt', passed: true},
      {name: 'file_contains: a-read.txt /unavailable/', passed: false, detail: 'Workspace evidence exceeded its byte limit.'},
    ]);
  });

  it('requires verified absence rather than an inspection failure or missing evidence entry', async () => {
    const checks = {file_checks: [{file: 'forbidden.txt', exists: false}]};
    const unavailable = await collectWorkspaceEvidence({
      ...workspace({}),
      async inspect() { throw new Error('private inspection failure'); },
    }, checks);
    assert.equal(unavailable.complete, false);
    assert.deepEqual(runWorkspaceChecks(checks, unavailable), [
      {name: 'file_absent: forbidden.txt', passed: false, detail: 'Workspace evidence could not be read safely.'},
    ]);

    const absent = await collectWorkspaceEvidence(workspace({}), checks);
    assert.equal(absent.complete, true);
    assert.deepEqual(runWorkspaceChecks(checks, absent), [
      {name: 'file_absent: forbidden.txt', passed: true},
    ]);
    const uncollected = await collectWorkspaceEvidence(workspace({}), undefined);
    assert.equal(runWorkspaceChecks(checks, uncollected)[0]?.passed, false);
  });

  it('preserves known file existence when its content read fails', async () => {
    const checks = {file_checks: [
      {file: 'forbidden.txt', exists: false},
      {file: 'forbidden.txt', exists: true, contains: 'complete'},
    ]};
    const evidence = await collectWorkspaceEvidence({
      ...workspace({'forbidden.txt': 'complete'}),
      async readFile() { throw new Error('private read failure'); },
    }, checks);

    assert.equal(evidence.complete, false);
    assert.equal(evidence.entries[0]?.exists, true);
    assert.equal(evidence.entries[0]?.kind, 'file');
    assert.equal(evidence.entries[0]?.content_base64, undefined);
    assert.doesNotMatch(JSON.stringify(evidence), /private/);
    assert.deepEqual(runWorkspaceChecks(checks, evidence), [
      {name: 'file_absent: forbidden.txt', passed: false, detail: 'Workspace evidence could not be read safely.'},
      {name: 'file_exists: forbidden.txt', passed: true},
      {name: 'file_contains: forbidden.txt /complete/', passed: false, detail: 'Workspace evidence could not be read safely.'},
    ]);
  });

  it('fails content checks for mismatches, invalid syntax, byte overflow, and regex timeouts', async () => {
    const evidence = await collectWorkspaceEvidence(
      workspace({'answer.txt': `${'a'.repeat(30)}!`}),
      {files_created: ['answer.txt']},
    );
    for (const [pattern, detail] of [
      ['^complete$', 'Pattern not found in answer.txt.'],
      ['[', 'Invalid regular expression syntax.'],
      ['é'.repeat(513), 'Pattern exceeds 1024 bytes.'],
      ['^(a+)+$', 'Regular expression evaluation failed or timed out.'],
    ] as const) {
      assert.deepEqual(runWorkspaceChecks({
        file_checks: [{file: 'answer.txt', exists: true, contains: pattern, description: 'answer'}],
      }, evidence), [
        {name: 'file_exists: answer', passed: true},
        {name: `file_contains: answer /${pattern}/`, passed: false, detail},
      ]);
    }
  });
});

describe('evaluateRunEvidence', () => {
  const trajectory: AtifTrajectoryV1_8 = {
    schema_version: 'ATIF-v1.8',
    agent: {name: 'test-agent', version: '1'},
    steps: [{step_id: 1, source: 'agent', message: 'Completed.'}],
  };

  it('requires results for every exact authored guideline before reading workspace evidence', async () => {
    const plan = createTestResolvedRunPlan({
      successGuidelines: ['first', 'second'],
      judge: {provider: 'test-judge', model: 'test-model'},
      checks: {files_created: ['answer.txt']},
    });
    const first = {guideline: 'first', passed: true, explanation: 'yes'};
    const second = {guideline: 'second', passed: false, explanation: 'no'};
    let inspections = 0;
    const sealedWorkspace = {
      ...workspace({'answer.txt': 'answer'}),
      async inspect(): Promise<WorkspaceEntry> {
        inspections += 1;
        assert.fail('Invalid guideline alignment must fail before evidence reads.');
      },
    };

    await assert.rejects(
      evaluateRunEvidence({plan, trajectory, workspace: sealedWorkspace}),
      UnsupportedEvaluationCapabilityError,
    );
    for (const guidelineResults of [
      [], [first], [second, first], [first, {...second, guideline: 'altered'}], [first, second, first],
    ] satisfies GuidelineResultV1[][]) {
      await assert.rejects(
        evaluateRunEvidence({plan, trajectory, workspace: sealedWorkspace, guidelineResults}),
        /must correspond exactly to the resolved plan/,
      );
    }
    assert.equal(inspections, 0);
  });

  it('rejects unsupported trajectories before reading grading evidence', async () => {
    await assert.rejects(evaluateRunEvidence({
      plan: createTestResolvedRunPlan({checks: {files_created: ['answer.txt']}}),
      trajectory: {...trajectory, schema_version: 'native-transcript'} as never,
      workspace: {
        ...workspace({}),
        async inspect() { assert.fail('Unsupported evidence must not be read.'); },
      },
    }), UnsupportedEvaluationCapabilityError);
  });

  it('propagates cancellation during the final read even if the workspace returns successfully', async () => {
    for (const returnsBody of [false, true]) {
      const controller = new AbortController();
      const reason = new Error('cancelled during final grading read');
      await assert.rejects(evaluateRunEvidence({
        plan: createTestResolvedRunPlan({checks: {files_created: ['answer.txt']}}),
        trajectory,
        workspace: {
          ...workspace({'answer.txt': 'answer'}),
          async readFile() {
            controller.abort(reason);
            if (returnsBody) return Buffer.from('answer');
            throw reason;
          },
        },
        signal: controller.signal,
      }), (error: unknown) => error === reason);
    }
  });
});
