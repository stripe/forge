import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name: string;
  id?: string;
  if?: string;
  run?: string;
}
const workflow = parse(
  await fs.readFile(
    path.join(process.cwd(), '.github', 'workflows', 'publish-dev.yml'),
    'utf8',
  ),
) as { jobs: { publish: { steps: WorkflowStep[] } } };
const steps = workflow.jobs.publish.steps;
const snapshot = steps.find((step) => step.name === 'Set snapshot version')!;

describe('development snapshot publishing', () => {
  it('assigns the snapshot identity before package validation and publishing', async () => {
    const stamped = await runSnapshot('0.2.0-dev.0');
    assert.equal(stamped.status, 0, stamped.stderr);
    assert.equal(stamped.version, '0.2.0-dev.123');
    const check = steps.find((step) => step.name === 'Check package')!;
    const publish = steps.find((step) => step.name === 'Publish snapshot')!;
    assert.ok(steps.indexOf(snapshot) < steps.indexOf(check));
    assert.ok(steps.indexOf(check) < steps.indexOf(publish));
    assert.equal(check.if, undefined);
    assert.equal(publish.if, undefined);
  });

  it('publishes successive snapshots of the next patch after a stable release', async () => {
    for (const [version, runNumber, expected] of [
      ['1.0.0', '123', '1.0.1-dev.123'],
      ['1.0.0', '124', '1.0.1-dev.124'],
      ['1.2.9', '125', '1.2.10-dev.125'],
    ] as const) {
      const stamped = await runSnapshot(version, runNumber);
      assert.equal(stamped.status, 0, stamped.stderr);
      assert.equal(stamped.version, expected);
    }
  });

  it('rejects unsupported version formats before changing the package', async () => {
    for (const version of ['0.2.0-rc.1', '0.2.0-dev.7', '01.0.0']) {
      const rejected = await runSnapshot(version);
      assert.equal(rejected.status, 1);
      assert.match(
        rejected.stderr,
        /Expected a stable package version or one ending in -dev.0/,
      );
      assert.equal(rejected.version, version);
    }
  });

  it('rejects missing or invalid run numbers before changing the package', async () => {
    for (const runNumber of ['', '0', 'not-a-number']) {
      const rejected = await runSnapshot('1.0.0', runNumber);
      assert.equal(rejected.status, 1);
      assert.match(
        rejected.stderr,
        /Expected a positive GitHub Actions run number/,
      );
      assert.equal(rejected.version, '1.0.0');
    }
  });
});

async function runSnapshot(version: string, runNumber = '123') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-publish-dev-'));
  try {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'snapshot-test', version }),
    );
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.copyFile(
      path.resolve('scripts/snapshot-version.mjs'),
      path.join(root, 'scripts', 'snapshot-version.mjs'),
    );
    const result = spawnSync(
      'bash',
      ['-e', '-o', 'pipefail', '-c', snapshot.run!],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          GITHUB_RUN_NUMBER: runNumber,
        },
      },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      version: (
        JSON.parse(
          await fs.readFile(path.join(root, 'package.json'), 'utf8'),
        ) as { version: string }
      ).version,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
