import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {runBoundedCommand} from './command.mjs';

export function assertNoCleanupWarnings(result, location) {
  assert.ok(!result.warnings.some(({code}) => code === 'runtime_cleanup_failed'),
    `Runtime cleanup failed for ${location}`);
}

export async function assertRuntimeCleanup({dockerExecutable, runtimeRoot, runId}, runCommand = runBoundedCommand) {
  // Cleanup verification remains independent of an aborted execution signal.
  const result = await runCommand(dockerExecutable, [
    'ps', '--all', '--filter', `name=stripe-forge-${runId}-`, '--format', '{{.ID}}',
  ], AbortSignal.timeout(30_000));
  assert.equal(result.exitCode, 0, `Could not inspect containers for ${runId}`);
  assert.equal(result.stdout.trim(), '', `Container leaked for ${runId}`);
  assert.deepEqual(await fs.readdir(runtimeRoot), [], `Runtime files leaked for ${runId}`);
}
