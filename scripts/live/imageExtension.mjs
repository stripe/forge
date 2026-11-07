import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createDockerRuntimeAdapter,
  defineDockerImageExtension,
  detectDockerRuntimePlatform,
} from '../../dist/runtime/docker/index.js';
import { createTestResolvedRunPlan } from '../../dist/testing/index.js';

export async function runImageExtensionIntegration({
  dockerExecutable,
  signal,
  progress,
}) {
  progress('checking a derived image through the existing Docker lifecycle');
  const extension = defineDockerImageExtension({
    id: 'live-probe',
    dockerfile: `ARG FORGE_BASE_IMAGE\nFROM \${FORGE_BASE_IMAGE}\nCOPY marker.txt /opt/forge-extension-marker.txt\n`,
    files: { 'marker.txt': 'extension-ready\n' },
  });
  const platform = await detectDockerRuntimePlatform({
    dockerExecutable,
    signal,
  });
  const basePlan = createTestResolvedRunPlan();
  const plan = createTestResolvedRunPlan({
    runtime: {
      ...basePlan.runtime,
      platform,
      image: {
        kind: 'forge',
        extension: { id: extension.id, sha256: extension.sha256 },
      },
    },
  });
  const adapter = createDockerRuntimeAdapter({
    dockerExecutable,
    imageExtension: extension,
  });
  const requirements = { executables: ['node'], stateDirectories: [] };
  adapter.preflight({
    plan,
    requirements,
    environment: { variables: {}, credentials: {} },
  });
  const runtime = await adapter.prepare({
    runId: `extension-${randomUUID()}`,
    plan,
    requirements,
    environment: { variables: {}, credentials: {} },
    signal,
  });
  try {
    await runtime.finalizeSetup();
    const command = await runtime.commands.agent.run(
      [
        'node',
        '-e',
        'process.stdout.write(require("node:fs").readFileSync("/opt/forge-extension-marker.txt"))',
      ],
      { signal, timeoutMs: 30000, maxOutputBytes: 1024 },
    );
    assert.equal(command.exitCode, 0);
    assert.equal(command.stdout, 'extension-ready\n');
    const sealed = await runtime.quiesce();
    assert.equal(sealed.metadata.imageExtensionSha256, extension.sha256);
    assert.match(sealed.metadata.baseImageId, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(sealed.metadata.imageId, sealed.metadata.baseImageId);
    return {
      verified: true,
      image_id: sealed.metadata.imageId,
      base_image_id: sealed.metadata.baseImageId,
    };
  } finally {
    await runtime.dispose();
  }
}
