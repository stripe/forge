import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  appendExperimentRunEvent,
  parseExperimentRunEvent,
  readLastExperimentRunEvent,
} from './experimentEvents.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-events-'));
  roots.push(root);
  return { root, file: path.join(root, 'events.jsonl') };
}
const now = () => new Date('2026-01-02T03:04:05.678Z');

describe('experiment progress log', () => {
  it('writes canonical timestamped records and keeps the progress payload unchanged', async () => {
    const { root, file } = await fixture();
    const event = { state: 'resuming', location: '/example' } as const;
    await appendExperimentRunEvent(root, event, now);
    assert.equal(
      await fs.readFile(file, 'utf8'),
      `{"experiment_run_id":"${path.basename(root)}","location":"/example","observed_at":"2026-01-02T03:04:05.678Z","state":"resumed"}\n`,
    );
    assert.equal(event.state, 'resuming');
    assert.deepEqual(await readLastExperimentRunEvent(root), {
      experiment_run_id: path.basename(root),
      state: 'resumed',
      location: '/example',
      observed_at: now().toISOString(),
    });
    if (process.platform !== 'win32')
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });

  it('reads old folders and an incomplete final write without changing any bytes', async () => {
    const { root, file } = await fixture();
    assert.equal(await readLastExperimentRunEvent(root), undefined);
    await fs.writeFile(file, '');
    assert.equal(await readLastExperimentRunEvent(root), undefined);
    await appendExperimentRunEvent(
      root,
      { state: 'started', location: root },
      now,
    );
    const event = await readLastExperimentRunEvent(root);
    await fs.appendFile(file, '{"state":');
    const before = await fs.readFile(file);
    assert.deepEqual(await readLastExperimentRunEvent(root), event);
    assert.deepEqual(await fs.readFile(file), before);
    await appendExperimentRunEvent(
      root,
      { state: 'resuming', location: root },
      now,
    );
    assert.equal((await readLastExperimentRunEvent(root))!.state, 'resumed');
    assert.ok(
      (await fs.readFile(file)).subarray(0, before.length).equals(before),
    );
  });

  it('bounds the tail read even when the full log is large', async () => {
    const { root, file } = await fixture();
    await fs.writeFile(file, 'ignored historical record\n'.repeat(10_000));
    await appendExperimentRunEvent(
      root,
      { state: 'started', location: root },
      now,
    );
    assert.equal(
      (await readLastExperimentRunEvent(root))!.observed_at,
      now().toISOString(),
    );
    await fs.writeFile(file, 'x'.repeat(70_000));
    await assert.rejects(readLastExperimentRunEvent(root), /byte limit/);
    await assert.rejects(
      appendExperimentRunEvent(
        root,
        { state: 'started', location: 'x'.repeat(70_000) },
        now,
      ),
      /byte limit/,
    );
  });

  it('rejects unknown fields, invalid times, and malformed complete records', async () => {
    const event = {
      experiment_run_id: 'example',
      state: 'started',
      location: '/example',
      observed_at: now().toISOString(),
    };
    assert.throws(() => parseExperimentRunEvent({ ...event, extra: true }));
    assert.throws(() =>
      parseExperimentRunEvent({ ...event, observed_at: 'yesterday' }),
    );
    assert.throws(() =>
      parseExperimentRunEvent({ ...event, observed_at: undefined }),
    );
    const { root, file } = await fixture();
    await fs.writeFile(file, '{}\n');
    await assert.rejects(readLastExperimentRunEvent(root));
  });

  it('rejects symlinks and directories without modifying their targets', async () => {
    const { root, file } = await fixture();
    const target = path.join(root, 'target');
    await fs.writeFile(target, 'untouched');
    await fs.symlink(target, file);
    await assert.rejects(
      appendExperimentRunEvent(root, { state: 'started', location: root }, now),
    );
    await assert.rejects(readLastExperimentRunEvent(root));
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
    await fs.unlink(file);
    await fs.mkdir(file);
    await assert.rejects(
      appendExperimentRunEvent(root, { state: 'started', location: root }, now),
    );
    await assert.rejects(readLastExperimentRunEvent(root));
  });
});
