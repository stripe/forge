import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { createHostCommandRunner } from './processCommandRunner.ts';

const roots: string[] = [];
const runner = createHostCommandRunner();
const options = { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 };
const node = (script: string, ...args: string[]) => [
  process.execPath,
  '-e',
  script,
  ...args,
];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-host-command-'));
  roots.push(root);
  return root;
}

describe('host command runner with real subprocesses', () => {
  it('preserves literal argv, cwd, environment, stdout/stderr and unsuccessful exit status', async () => {
    const root = await temporaryRoot();
    const args = [
      'space value',
      '$HOME',
      '$(touch expanded)',
      '*',
      'line\nbreak',
      '世界',
    ];
    const result = await runner.run(
      node(
        `
      process.stdout.write(JSON.stringify({args: process.argv.slice(1), cwd: process.cwd(), value: process.env.FORGE_TEST_VALUE}));
      process.stderr.write('diagnostic');
      process.exitCode = 7;
    `,
        ...args,
      ),
      { ...options, cwd: root, environment: { FORGE_TEST_VALUE: 'explicit' } },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      args,
      cwd: await fs.realpath(root),
      value: 'explicit',
    });
    assert.equal(result.stderr, 'diagnostic');
    assert.equal(result.exitCode, 7);
    assert.ok(result.durationMs >= 0);
    assert.deepEqual(
      await fs.readdir(root),
      [],
      'argv must not be interpreted by a shell',
    );
  });

  it('decodes split UTF-8 before delivering CRLF lines and the final partial line', async () => {
    const ack = path.join(await temporaryRoot(), 'ack');
    const lines: string[] = [];
    const result = await runner.run(
      node(
        `
      const fs = require('node:fs');
      const ack = process.argv[1];
      process.stdout.write(Buffer.concat([Buffer.from('ready\\n'), Buffer.from([0xe2])]));
      const wait = setInterval(() => {
        if (!fs.existsSync(ack)) return;
        clearInterval(wait);
        process.stdout.write(Buffer.concat([Buffer.from([0x82, 0xac]), Buffer.from('\\r\\ntail')]));
      }, 5);
    `,
        ack,
      ),
      {
        ...options,
        onStdoutLine(line) {
          lines.push(line);
          if (line === 'ready') writeFileSync(ack, 'continue');
        },
      },
    );
    assert.equal(result.stdout, 'ready\n€\r\ntail');
    assert.deepEqual(lines, ['ready', '€', 'tail']);
  });

  it('counts stdout and stderr together, allowing the exact output limit', async () => {
    const script = 'process.stdout.write("abc"); process.stderr.write("de");';
    const result = await runner.run(node(script), {
      ...options,
      maxOutputBytes: 5,
    });
    assert.equal(result.stdout, 'abc');
    assert.equal(result.stderr, 'de');
    await assert.rejects(
      runner.run(node(script), { ...options, maxOutputBytes: 4 }),
      { code: 'command_output_limit' },
    );
  });

  it('reports a missing executable as a startup failure', async () => {
    await assert.rejects(
      runner.run([path.join(await temporaryRoot(), 'missing')], options),
      { code: 'command_start_failed' },
    );
  });

  it('rejects invalid argv and bounds before starting a process', () => {
    for (const argv of [[], ['nul\0'], [42] as unknown as string[]]) {
      assert.throws(() => runner.run(argv, options), /argv/);
    }
    for (const value of [0, -1, 0.5, NaN, Infinity]) {
      assert.throws(
        () => runner.run(node(''), { ...options, timeoutMs: value }),
        /timeoutMs/,
      );
      assert.throws(
        () => runner.run(node(''), { ...options, maxOutputBytes: value }),
        /maxOutputBytes/,
      );
    }
  });

  it('does not start a command with an already-aborted signal', async () => {
    const marker = path.join(await temporaryRoot(), 'must-not-exist');
    const reason = new Error('cancel before spawn');
    assert.throws(
      () =>
        runner.run(
          node(
            'require("node:fs").writeFileSync(process.argv[1], "started")',
            marker,
          ),
          { ...options, signal: AbortSignal.abort(reason) },
        ),
      (error) => error === reason,
    );
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  });

  it('times out a ready command and waits for the real process to exit', {
    timeout: 10_000,
  }, async (t) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    t.onTestFinished(() => {
      vi.useRealTimers();
    });
    let markReady!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      markReady = resolve;
    });
    const command = runner.run(
      node('console.log(process.pid); setInterval(() => {}, 1000);'),
      {
        ...options,
        timeoutMs: 500,
        onStdoutLine(line) {
          markReady(Number(line));
        },
      },
    );
    const rejected = assert.rejects(command, { code: 'command_timeout' });
    let pid: number | undefined;
    try {
      pid = await ready;
      assert.equal(await running(pid), true);
      vi.advanceTimersByTime(500);
      await rejected;
      assert.equal(await running(pid), false);
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }
  });

  it('aborts the process group and escalates when the parent ignores SIGTERM', {
    skip: process.platform === 'win32',
  }, async () => {
    const controller = new AbortController();
    const reason = new Error('cancel running tree');
    let pids: number[] = [];
    const grandchild = `
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
        process.send('ready');
      `;
    const command = runner.run(
      node(
        `
        const {spawn} = require('node:child_process');
        process.on('SIGTERM', () => {});
        const child = spawn(process.execPath, ['-e', process.argv[1]], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
        child.on('message', () => console.log(JSON.stringify([process.pid, child.pid])));
        setInterval(() => {}, 1000);
      `,
        grandchild,
      ),
      {
        ...options,
        signal: controller.signal,
        onStdoutLine(line) {
          pids = JSON.parse(line) as number[];
          controller.abort(reason);
        },
      },
    );
    try {
      await assert.rejects(command, { code: 'command_aborted', cause: reason });
      assert.equal(
        pids.length,
        2,
        'Abort must happen after both processes are ready',
      );
      for (const pid of pids) await waitUntilExited(pid);
    } finally {
      controller.abort();
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
      await command.catch(() => undefined);
    }
  });
});

async function running(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      return (
        stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
      );
    }
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'ENOENT')
    )
      return false;
    throw error;
  }
}

async function waitUntilExited(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (await running(pid)) {
    assert.ok(Date.now() < deadline, `Process ${pid} survived cancellation`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
