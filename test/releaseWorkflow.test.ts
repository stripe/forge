import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
  await fs.readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  ),
);

describe('npm release workflow', () => {
  it('keeps publication disabled until launch without blocking version PRs', () => {
    const { version, check, publish } = workflow.jobs;
    assert.equal(version.if, "github.ref == 'refs/heads/main'");
    assert.ok(
      version.steps.every(
        (step: { with?: Record<string, string> }) =>
          !step.with?.['publish-script'],
      ),
    );
    assert.equal(version.permissions['id-token'], undefined);
    assert.equal(check.needs, 'version');
    assert.equal(publish.needs, 'check');
    assert.equal(publish.environment, 'npm');

    // These conditions use the shared JS/Actions subset: strings, ==, and &&.
    const checkCondition = check.if.replace(
      'needs.version.outputs.has-changesets',
      'needs.version.outputs["has-changesets"]',
    );
    for (const enabled of ['', 'false', 'true']) {
      for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
        for (const hasChangesets of ['', 'true', 'false']) {
          const allowed =
            enabled === 'true' &&
            ref === 'refs/heads/main' &&
            hasChangesets === 'false';
          const context = {
            github: { ref },
            vars: { NPM_PUBLISH_ENABLED: enabled },
            needs: {
              version: { outputs: { 'has-changesets': hasChangesets } },
            },
          };
          assert.equal(runInNewContext(checkCondition, context), allowed);
        }
      }
      for (const candidate of ['', 'false', 'true']) {
        assert.equal(
          runInNewContext(publish.if, {
            vars: { NPM_PUBLISH_ENABLED: enabled },
            needs: { check: { outputs: { publish: candidate } } },
          }),
          enabled === 'true' && candidate === 'true',
        );
      }
    }
  });

  it.for([
    { status: 200, version: '0.1.1', output: 'publish=false\n' },
    { status: 404, version: '0.1.1', output: 'publish=true\n' },
    { status: 403, version: '0.1.1', error: 'HTTP 403' },
    { status: 429, version: '0.1.1', error: 'HTTP 429' },
    { status: 503, version: '0.1.1', error: 'HTTP 503' },
    { status: 0, version: '0.1.1', error: 'network unavailable' },
    {
      status: 404,
      version: '0.1.1-dev.0',
      error: 'Only stable package versions',
    },
  ])('checks npm before publishing: %j', async (scenario, context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-npm-release-'));
    context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const output = path.join(root, 'output');
    await fs.writeFile(output, '');
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: '@stripe/forge',
        version: scenario.version,
      }),
    );

    const command = workflow.jobs.check.steps.find(
      (step: { id?: string }) => step.id === 'unpublished',
    ).run;
    const script = command.match(
      /^node --input-type=module <<'JS'\n([\s\S]+)\nJS\n?$/,
    )?.[1];
    assert.ok(
      script,
      'Registry check must be the Node script executed by the workflow.',
    );
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
      timeout: 10_000,
      input: `
        import assert from 'node:assert/strict';
        globalThis.fetch = async (url, options) => {
          assert.equal(url, 'https://registry.npmjs.org/%40stripe%2Fforge/0.1.1');
          assert.ok(options.signal instanceof AbortSignal);
          if (${scenario.status} === 0) throw new Error('network unavailable');
          return {status: ${scenario.status}};
        };
        ${script}
      `,
    });
    if (scenario.error) {
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(scenario.error), result.stderr);
    } else {
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(await fs.readFile(output, 'utf8'), scenario.output ?? '');
  });
});
