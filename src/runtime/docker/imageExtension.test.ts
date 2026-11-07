import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createTestResolvedRunPlan } from '../../testing/plans.ts';
import { defineDockerImageExtension } from './imageExtension.ts';
import {
  createDockerRuntimeAdapter,
  validateDockerRuntimeHost,
} from './runtime.ts';

const dockerfile = `ARG FORGE_BASE_IMAGE\nFROM \${FORGE_BASE_IMAGE}\nRUN true\n`;

describe('Docker image extensions', () => {
  it('binds cloned, frozen content independently of map insertion order', () => {
    const files = { 'z.txt': 'z', 'a.txt': 'a' };
    const extension = defineDockerImageExtension({
      id: 'example',
      dockerfile,
      files,
    });
    assert.equal(
      extension.sha256,
      defineDockerImageExtension({
        id: 'example',
        dockerfile,
        files: { 'a.txt': 'a', 'z.txt': 'z' },
      }).sha256,
    );
    files['a.txt'] = 'changed';
    assert.equal(extension.files['a.txt'], 'a');
    assert.ok(Object.isFrozen(extension.files));
    assert.notEqual(
      extension.sha256,
      defineDockerImageExtension({ id: 'example', dockerfile, files }).sha256,
    );
    assert.throws(() =>
      defineDockerImageExtension({
        id: 'example',
        dockerfile: `${dockerfile}  FROM ubuntu\n`,
      }),
    );
    assert.throws(() =>
      defineDockerImageExtension({
        id: 'example',
        dockerfile: `${dockerfile}FROM\\\n ubuntu\n`,
      }),
    );
    assert.throws(() =>
      defineDockerImageExtension({
        id: 'example',
        dockerfile: `${dockerfile}FROM\\\n# continuation comment\n ubuntu\n`,
      }),
    );
    for (const name of ['../outside', '/absolute', 'Dockerfile', 'a//b'])
      assert.throws(() =>
        defineDockerImageExtension({
          id: 'example',
          dockerfile,
          files: { [name]: 'body' },
        }),
      );
    assert.throws(() =>
      defineDockerImageExtension({
        id: 'example',
        dockerfile: 'FROM ubuntu\n',
      }),
    );
  });

  it('rejects an unsupplied extension during pure preflight', () => {
    const original = createTestResolvedRunPlan();
    assert.ok('image' in original.runtime);
    const plan = createTestResolvedRunPlan({
      runtime: {
        ...original.runtime,
        image: {
          kind: 'forge',
          extension: { id: 'missing', sha256: `sha256:${'a'.repeat(64)}` },
        },
      },
    });
    const bundle = defineDockerImageExtension({ id: 'missing', dockerfile });
    assert.throws(
      () =>
        createDockerRuntimeAdapter({ imageExtension: bundle }).preflight({
          plan,
          requirements: { executables: [], stateDirectories: [] },
          environment: { variables: {}, credentials: {} },
        }),
      /does not match/,
    );
    assert.ok('image' in plan.runtime);
    assert.equal(
      JSON.parse(JSON.stringify(plan)).runtime.image.extension.sha256,
      plan.runtime.image.extension!.sha256,
    );
    assert.throws(
      () =>
        createDockerRuntimeAdapter().preflight({
          plan,
          requirements: { executables: [], stateDirectories: [] },
          environment: { variables: {}, credentials: {} },
        }),
      /does not match/,
    );
  });

  it('builds from the immutable base ID and probes the selected extension', async () => {
    const extension = defineDockerImageExtension({
      id: 'example',
      dockerfile,
      files: { 'hello.txt': 'hello' },
    });
    const calls: string[][] = [];
    const recorded = calls;
    await validateDockerRuntimeHost({
      platform: 'linux/amd64',
      imageExtension: extension,
      hostCommands: {
        async run(argv) {
          recorded.push([...argv]);
          return {
            exitCode: 0,
            stdout: argv[1] === 'image' ? `sha256:${'a'.repeat(64)}` : '',
            stderr: '',
            durationMs: 0,
          };
        },
      },
    });
    assert.ok(
      calls.some(
        (argv) => argv[1] === 'tag' && argv[2] === `sha256:${'a'.repeat(64)}`,
      ),
    );
    const builds = calls.filter((argv) => argv[1] === 'build');
    assert.equal(builds.length, 2);
    assert.ok(
      builds[1]!.includes(
        `FORGE_BASE_IMAGE=stripe-forge-base:${'a'.repeat(64)}`,
      ),
    );
    assert.ok(
      calls.some(
        (argv) => argv.includes('--user') && argv.includes('forge:forge'),
      ),
    );
  });
});
