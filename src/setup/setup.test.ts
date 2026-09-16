import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {CommandResult} from '../contracts/command.js';
import type {MutableWorkspace, WorkspaceEntry} from '../contracts/runtime.js';
import type {SetupStepV1} from '../model/types.js';
import {createSetupExecutor} from './executor.js';

function result(exitCode = 0): CommandResult {
  return {stdout: '', stderr: '', exitCode, durationMs: 1};
}

describe('portable setup actions', () => {
  it('applies forge/write@1 and forge/command@1 in source order', async () => {
    const events: string[] = [];
    const writes = new Map<string, Uint8Array>();
    const workspace: MutableWorkspace = {
      async inspect(relativePath): Promise<WorkspaceEntry> {
        return {path: relativePath, kind: writes.has(relativePath) ? 'file' : 'absent'};
      },
      async readFile(relativePath) {
        return writes.get(relativePath) ?? new Uint8Array();
      },
      async listFiles() {
        return [];
      },
      async writeFile(relativePath, body) {
        events.push(`write:${relativePath}`);
        writes.set(relativePath, body);
      },
    };
    const steps: SetupStepV1[] = [
      {
        uses: 'forge/write@1',
        with: {target: 'notes/inline.txt', source: {content: 'inline'}},
      },
      {
        uses: 'forge/write@1',
        with: {
          target: 'notes/fixture.txt',
          source: {dataset_path: 'fixtures/source.txt'},
        },
      },
      {
        uses: 'forge/command@1',
        with: {argv: ['node', '--version'], cwd: '.', timeout_ms: 1234},
      },
    ];

    await createSetupExecutor().apply(steps, {
      runId: 'run-1',
      workspace,
      commands: {
        async run(argv, options) {
          events.push(`command:${argv.join(' ')}`);
          assert.equal(options?.cwd, '.');
          assert.equal(options?.timeoutMs, 1234);
          return result();
        },
      },
      inputs: {
        async inspect(datasetPath) {
          return {path: datasetPath, kind: 'file', size: 7};
        },
        async read(datasetPath) {
          assert.equal(datasetPath, 'fixtures/source.txt');
          return Buffer.from('fixture');
        },
        async listFiles() {
          return [];
        },
      },
      signal: new AbortController().signal,
    });

    assert.deepEqual(events, [
      'write:notes/inline.txt',
      'write:notes/fixture.txt',
      'command:node --version',
    ]);
    assert.equal(Buffer.from(writes.get('notes/fixture.txt')!).toString(), 'fixture');
  });

  it('preflights all handlers before performing mutations', async () => {
    let mutated = false;
    const executor = createSetupExecutor();
    const steps: SetupStepV1[] = [
      {uses: 'forge/write@1', with: {target: 'ok', source: {content: 'x'}}},
      {uses: 'example/missing@1', with: {}},
    ];
    await assert.rejects(
      executor.apply(steps, {
        runId: 'run-1',
        workspace: {
          async inspect(path): Promise<WorkspaceEntry> {
            return {path, kind: 'absent'};
          },
          async readFile() {
            return new Uint8Array();
          },
          async listFiles() {
            return [];
          },
          async writeFile() {
            mutated = true;
          },
        },
        commands: {async run() { return result(); }},
        inputs: {
          async inspect(path) { return {path, kind: 'file'}; },
          async read() { return new Uint8Array(); },
          async listFiles() { return []; },
        },
        signal: new AbortController().signal,
      }),
      /No setup handler/,
    );
    assert.equal(mutated, false);
  });

  it('does not attach potentially sensitive command output to setup errors', async () => {
    await assert.rejects(
      createSetupExecutor().apply(
        [{uses: 'forge/command@1', with: {argv: ['false']}}],
        {
          runId: 'run-1',
          workspace: {
            async inspect(path): Promise<WorkspaceEntry> { return {path, kind: 'absent'}; },
            async readFile() { return new Uint8Array(); },
            async listFiles() { return []; },
            async writeFile() {},
          },
          commands: {
            async run() {
              return {stdout: 'TOP_SECRET', stderr: 'TOP_SECRET', exitCode: 9, durationMs: 1};
            },
          },
          inputs: {
            async inspect(path) { return {path, kind: 'file'}; },
            async read() { return new Uint8Array(); },
            async listFiles() { return []; },
          },
          signal: new AbortController().signal,
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(String(error).includes('TOP_SECRET'), false);
        return true;
      },
    );
  });
});
