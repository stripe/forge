import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createDockerRuntimeAdapter,
  defineDockerImageBuild,
  detectDockerRuntimePlatform,
  FORGE_CLAUDE_CODE_VERSION,
  FORGE_CODEX_VERSION,
  FORGE_OPENCODE_VERSION,
  validateDockerRuntimeHost,
} from '../../dist/runtime/docker/index.js';
import {
  assertRuntimeAdapterConforms,
  createTestResolvedRunPlan,
} from '../../dist/testing/index.js';

export async function runImageBuildIntegration({
  dockerExecutable,
  signal,
  progress,
}) {
  progress('checking standalone image compatibility and lifecycle');
  const sourceDockerfile = await readFile(
    new URL('../../src/runtime/docker/assets/Dockerfile', import.meta.url),
    'utf8',
  );
  const entrypoint = await readFile(
    new URL('../../src/runtime/docker/assets/entrypoint.sh', import.meta.url),
    'utf8',
  );
  const alternateClaudeVersion = '2.1.272';
  const dockerfile = sourceDockerfile.replace(
    `@anthropic-ai/claude-code@${FORGE_CLAUDE_CODE_VERSION}`,
    `@anthropic-ai/claude-code@${alternateClaudeVersion}`,
  );
  const tools = {
    claudeCode: alternateClaudeVersion,
    codex: FORGE_CODEX_VERSION,
    opencode: FORGE_OPENCODE_VERSION,
  };
  const bundle = defineDockerImageBuild({
    id: 'live-standalone',
    dockerfile,
    files: { 'entrypoint.sh': entrypoint },
    tools,
  });
  const platform = await detectDockerRuntimePlatform({
    dockerExecutable,
    signal,
  });
  const base = createTestResolvedRunPlan();
  const plan = createTestResolvedRunPlan({
    runtime: {
      ...base.runtime,
      platform,
      image: { kind: 'build', id: bundle.id, sha256: bundle.sha256 },
    },
  });
  const adapter = createDockerRuntimeAdapter({
    dockerExecutable,
    imageBuild: bundle,
  });
  const requirements = {
    executables: ['node'],
    stateDirectories: [
      {
        id: 'sealed-probe',
        containerPath: '/opt/forge-probe',
        sealAfterSetup: true,
      },
    ],
  };
  adapter.preflight({
    plan,
    requirements,
    environment: { variables: {}, credentials: {} },
  });
  let metadata;
  const observedAdapter = {
    ...adapter,
    async prepare(input) {
      const runtime = await adapter.prepare(input);
      return {
        ...runtime,
        async quiesce() {
          const sealed = await runtime.quiesce();
          metadata = sealed.metadata;
          return sealed;
        },
      };
    },
  };
  await assertRuntimeAdapterConforms(
    observedAdapter,
    {
      runId: `standalone-${randomUUID()}`,
      plan,
      requirements,
      environment: { variables: {}, credentials: {} },
      signal,
    },
    {
      commandProbes: [
        {
          scope: 'agent',
          argv: ['node', '-e', 'process.stdout.write("standalone-ready")'],
          expectedStdout: 'standalone-ready',
        },
      ],
    },
  );
  assert.equal(metadata.imageBuildSha256, bundle.sha256);
  assert.equal(metadata.claudeCodeVersion, alternateClaudeVersion);
  assert.equal(metadata.imageCompatibility, 'forge/docker-v1');
  assert.ok(!('imageAssetDigest' in metadata));
  // A successful build is insufficient: the real entrypoint and exact versions must work.
  for (const [label, broken] of [
    [
      'entrypoint',
      { ...bundle, dockerfile: `${dockerfile}\nENTRYPOINT ["/bin/false"]\n` },
    ],
    ['version', { ...bundle, tools: { ...tools, claudeCode: '999.0.0' } }],
  ]) {
    progress(`checking rejection of incompatible standalone ${label}`);
    await assert.rejects(
      validateDockerRuntimeHost({
        dockerExecutable,
        platform,
        signal,
        imageBuild: defineDockerImageBuild(broken),
      }),
      /compatibility/,
    );
  }
  return {
    verified: true,
    bundle_sha256: bundle.sha256,
    rejected: ['entrypoint', 'version'],
  };
}
