import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, it} from 'node:test';
import {parse} from 'yaml';

interface WorkflowStep {
  name: string;
  id?: string;
  if?: string;
  run?: string;
}
const workflow = parse(await fs.readFile(
  path.join(process.cwd(), '.github', 'workflows', 'publish-dev.yml'), 'utf8',
)) as {jobs: {publish: {steps: WorkflowStep[]}}};
const steps = workflow.jobs.publish.steps;
const snapshot = steps.find((step) => step.name === 'Set snapshot version')!;

describe('development snapshot publishing', () => {
  it('assigns the snapshot identity before package validation and publishing', async () => {
    const stamped = await runSnapshot('0.2.0-dev.0');
    assert.equal(stamped.status, 0, stamped.stderr);
    assert.equal(stamped.version, '0.2.0-dev.123');
    assert.equal(stamped.output, 'publish=true\n');
    assert.equal(snapshot.id, 'snapshot');
    const check = steps.find((step) => step.name === 'Check package')!;
    const publish = steps.find((step) => step.name === 'Publish snapshot')!;
    assert.ok(steps.indexOf(snapshot) < steps.indexOf(check));
    assert.ok(steps.indexOf(check) < steps.indexOf(publish));
    assert.equal(check.if, "steps.snapshot.outputs.publish == 'true'");
    assert.equal(publish.if, check.if);
  });

  it('skips stable release commits without changing their version', async () => {
    const skipped = await runSnapshot('0.2.0');
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(skipped.version, '0.2.0');
    assert.equal(skipped.output, 'publish=false\n');
  });

  it('rejects prereleases that are not development snapshot bases', async () => {
    for (const version of ['0.2.0-rc.1', '0.2.0-dev.7']) {
      const rejected = await runSnapshot(version);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /Expected package version to end in -dev.0/);
      assert.equal(rejected.version, version);
      assert.equal(rejected.output, '');
    }
  });
});

async function runSnapshot(version: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-publish-dev-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({name: 'snapshot-test', version}));
    const output = path.join(root, 'github-output');
    await fs.writeFile(output, '');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', snapshot.run!], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: {...process.env, GITHUB_RUN_NUMBER: '123', GITHUB_OUTPUT: output},
    });
    return {
      status: result.status, stderr: result.stderr,
      version: (JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {version: string}).version,
      output: await fs.readFile(output, 'utf8'),
    };
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}
