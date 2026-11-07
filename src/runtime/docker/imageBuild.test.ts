import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { createTestResolvedRunPlan } from '../../testing/plans.ts';
import { defineDockerImageBuild } from './imageBuild.ts';
import {
  createDockerRuntimeAdapter,
  validateDockerRuntimeHost,
} from './runtime.ts';

const input = {
  id: 'example',
  dockerfile: 'FROM example\n',
  tools: { claudeCode: '2.1.0', codex: '0.1.0', opencode: '1.0.0' },
};

describe('standalone Docker image builds', () => {
  it('pins cloned build inputs and versions, rejects unsafe context paths', () => {
    const files = { 'z.txt': 'z', 'a.txt': 'a' };
    const tools = { ...input.tools };
    const bundle = defineDockerImageBuild({ ...input, files, tools });
    assert.equal(
      bundle.sha256,
      defineDockerImageBuild({
        ...input,
        files: { 'a.txt': 'a', 'z.txt': 'z' },
        tools,
      }).sha256,
    );
    assert.ok(Object.isFrozen(bundle.files));
    files['a.txt'] = 'changed';
    tools.claudeCode = '9.0.0';
    assert.equal(bundle.files['a.txt'], 'a');
    assert.equal(bundle.tools.claudeCode, '2.1.0');
    assert.ok(Object.isFrozen(bundle.tools));
    assert.notEqual(
      bundle.sha256,
      defineDockerImageBuild({ ...input, tools }).sha256,
    );
    for (const name of [
      '../secret',
      '/absolute',
      'Dockerfile',
      'Dockerfile/child',
      'a//b',
    ])
      assert.throws(() =>
        defineDockerImageBuild({ ...input, files: { [name]: 'x' } }),
      );
    assert.throws(
      () =>
        defineDockerImageBuild({
          ...input,
          files: { a: 'file', 'a/b': 'child' },
        }),
      /paths conflict/,
    );
    assert.throws(() =>
      defineDockerImageBuild({
        ...input,
        tools: { ...input.tools, claudeCode: 'latest' },
      }),
    );
    assert.throws(() =>
      defineDockerImageBuild({
        ...input,
        dockerfile: 'x'.repeat(4 * 1024 * 1024),
      }),
    );
  });

  it('requires an exact plan pin before any host command and retains strict image parsing', () => {
    const original = createTestResolvedRunPlan();
    assert.ok('image' in original.runtime);
    const bundle = defineDockerImageBuild(input);
    const plan = createTestResolvedRunPlan({
      runtime: {
        ...original.runtime,
        image: { kind: 'build', id: bundle.id, sha256: bundle.sha256 },
      },
    });
    const preflight = {
      plan,
      requirements: { executables: [], stateDirectories: [] },
      environment: { variables: {}, credentials: {} },
    };
    assert.throws(
      () => createDockerRuntimeAdapter().preflight(preflight),
      /does not match/,
    );
    assert.throws(
      () =>
        createDockerRuntimeAdapter({
          imageBuild: defineDockerImageBuild({
            ...input,
            dockerfile: 'FROM different\n',
          }),
        }).preflight(preflight),
      /does not match/,
    );
    createDockerRuntimeAdapter({ imageBuild: bundle }).preflight(preflight);
    createDockerRuntimeAdapter({ imageBuild: bundle }).preflight({
      ...preflight,
      plan: original,
    });
    assert.throws(() =>
      createTestResolvedRunPlan({
        runtime: {
          ...original.runtime,
          image: {
            kind: 'forge',
            extension: { id: bundle.id, sha256: bundle.sha256 },
          },
        },
      } as never),
    );
    assert.throws(() =>
      createTestResolvedRunPlan({
        runtime: {
          ...original.runtime,
          image: {
            kind: 'build',
            id: bundle.id,
            sha256: bundle.sha256,
            unexpected: true,
          },
        },
      } as never),
    );
  });

  it.each(['success', 'startup', 'tools'] as const)(
    'builds only the supplied recipe and cleans up after %s',
    async (failure) => {
      const calls: string[][] = [];
      let root = '';
      let probeRoot = '';
      const bundle = defineDockerImageBuild({
        ...input,
        files: {
          'workspace/setup.sh': 'true',
          'home/config': 'config',
          cid: 'context-file',
        },
      });
      const operation = validateDockerRuntimeHost({
        platform: 'linux/amd64',
        imageBuild: bundle,
        hostCommands: {
          async run(argv) {
            calls.push([...argv]);
            if (argv[1] === 'build') {
              root = argv.at(-1)!;
              assert.equal(
                await fs.readFile(path.join(root, 'Dockerfile'), 'utf8'),
                input.dockerfile,
              );
            }
            if (argv.includes('--detach'))
              probeRoot = path.dirname(argv[argv.indexOf('--cidfile') + 1]!);
            if (argv[1] === 'exec' && failure === 'success')
              for (const name of ['workspace', 'home'])
                await fs.writeFile(
                  path.join(probeRoot, name, 'probe'),
                  'forge-compatible',
                );
            const exitCode =
              (failure === 'startup' && argv.includes('--detach')) ||
              (failure === 'tools' && argv[1] === 'exec')
                ? 1
                : 0;
            return {
              exitCode,
              stdout: argv[1] === 'image' ? `sha256:${'a'.repeat(64)}` : '',
              stderr: '',
              durationMs: 0,
            };
          },
        },
      });
      if (failure === 'success') await operation;
      else await assert.rejects(operation, /compatibility/);
      assert.equal(calls.filter((argv) => argv[1] === 'build').length, 1);
      const startup = calls.find((argv) => argv.includes('--detach'))!;
      assert.ok(startup.includes('--read-only'));
      assert.ok(startup.includes('none'));
      assert.ok(!startup.includes('--entrypoint'));
      assert.ok(
        calls.some((argv) => argv[1] === 'rm' && argv.includes('--force')),
      );
      await assert.rejects(fs.stat(root), { code: 'ENOENT' });
      await assert.rejects(fs.stat(probeRoot), { code: 'ENOENT' });
    },
  );
});
