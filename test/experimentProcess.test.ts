import assert from 'node:assert/strict';
import {fork, type ChildProcess} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseExperimentRunReport, type ExperimentRunSummary} from '../src/experiment.js';
import {verifyCompletedRun} from '../src/results/index.js';

const childFile = fileURLToPath(new URL('./support/experimentProcess.js', import.meta.url));

describe('experiment run recovery across real process death', () => {
  it('reclaims a dead owner, keeps its completed artifacts and reruns only interrupted/pending work', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-experiment-run-process-'));
    const root = path.join(temporary, 'experiment-run');
    let child: ChildProcess | undefined;
    try {
      let started = launch(root, 'crash');
      child = started.child;
      assert.deepEqual(await message(child), {type: 'reserved', run_id: 'crashed-2'});
      const before = JSON.parse(await fs.readFile(path.join(root, 'experiment.json'), 'utf8'));
      assert.deepEqual(before.entries.map((entry: {attempts: {state: string}[]}) => entry.attempts.at(-1)?.state),
        ['completed', 'running', undefined]);
      const owners = await fs.readdir(path.join(root, '.experiment.lock'));
      assert.equal(owners.length, 1);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, '.experiment.lock', owners[0]!), 'utf8')).pid, child.pid);
      const first = await verifyCompletedRun(path.join(root, 'runs', 'crashed-1'));
      const retained = new Map<string, Buffer>();
      for (const name of ['result.json', ...first.result.artifacts.map(({path}) => path)]) {
        retained.set(name, await fs.readFile(path.join(first.location, name)));
      }
      assert.equal(child.kill('SIGKILL'), true);
      assert.deepEqual(await started.exited, {code: null, signal: 'SIGKILL'});
      // Leave the real stale lock and running attempt untouched for Forge to recover.
      await fs.stat(path.join(root, '.experiment.lock'));
      started = launch(root, 'resume');
      child = started.child;
      const completed = await message(child) as {type: string; summary: ExperimentRunSummary};
      assert.equal(completed.type, 'completed');
      assert.equal((await started.exited).code, 0, started.stderr());
      assert.deepEqual({executed: completed.summary.executed, skipped: completed.summary.skipped,
        completed: completed.summary.completed, errored: completed.summary.errored},
      {executed: 2, skipped: 1, completed: 3, errored: 0});
      const checkpoint = JSON.parse(await fs.readFile(path.join(root, 'experiment.json'), 'utf8'));
      assert.deepEqual(checkpoint.entries.map((entry: {attempts: {run_id: string}[]}) => entry.attempts.map(({run_id}) => run_id)),
        [['crashed-1'], ['crashed-2', 'resumed-1'], ['resumed-2']]);
      assert.equal(checkpoint.entries[1].attempts[0].error_code, 'invalid_artifacts');
      for (const [name, bytes] of retained) assert.deepEqual(await fs.readFile(path.join(first.location, name)), bytes);
      const report = parseExperimentRunReport(JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8')));
      assert.deepEqual(report.runs.map(({attempt_count}) => attempt_count), [1, 2, 1]);
      assert.equal(report.summary.completed, 3);
      await assert.rejects(fs.stat(path.join(root, '.experiment.lock')), {code: 'ENOENT'});
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child!.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
      await fs.rm(temporary, {recursive: true, force: true});
    }
  });
});

function launch(root: string, mode: string) {
  const child = fork(childFile, [root, mode], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {stderr += chunk.toString();});
  const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve) => {
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  return {child, exited, stderr: () => stderr};
}

async function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for experiment run child readiness')), 10_000);
    const received = (value: unknown) => finish(undefined, value);
    const exited = () => finish(new Error('Experiment run child exited before sending readiness'));
    const failed = (error: Error) => finish(error);
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timeout);
      child.removeListener('message', received);
      child.removeListener('exit', exited);
      child.removeListener('error', failed);
      if (error) reject(error);
      else resolve(value);
    }
    child.once('message', received);
    child.once('exit', exited);
    child.once('error', failed);
  });
}
