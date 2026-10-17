import assert from 'node:assert/strict';
import { it } from 'vitest';
import { resolveCliRuntime } from './cliRuntime.ts';
import type { LoadedExperimentConfigV1 } from './model/types.ts';

it('resolves explicit network overrides without mutating input', () => {
  const experiment = {
    config: { runtime: { adapter: 'docker' } },
  } as LoadedExperimentConfigV1;
  assert.deepEqual(
    resolveCliRuntime(experiment, {
      FORGE_DOCKER_NETWORK: 'host',
      FORGE_DOCKER_BUILD_NETWORK: 'host',
    }).config.runtime,
    { adapter: 'docker', network: 'host', build_network: 'host' },
  );
  assert.deepEqual(experiment.config.runtime, { adapter: 'docker' });
  const host = resolveCliRuntime(experiment, { FORGE_DOCKER_NETWORK: 'host' });
  assert.deepEqual(
    resolveCliRuntime(host, { FORGE_DOCKER_NETWORK: 'default' }),
    experiment,
  );
  assert.throws(
    () => resolveCliRuntime(experiment, { FORGE_DOCKER_NETWORK: 'typo' }),
    /must be host or default/,
  );
});

it('forwards only explicit nonsecret proxy settings and rejects URL credentials', () => {
  const experiment = {
    config: { runtime: { adapter: 'docker' } },
  } as LoadedExperimentConfigV1;
  const output = resolveCliRuntime(experiment, {
    FORGE_HTTP_PROXY: 'http://proxy.example:8080',
    FORGE_NO_PROXY: 'localhost,.example',
    http_proxy: 'http://ambient.example:80',
  });
  assert.deepEqual(output.config.runtime, {
    adapter: 'docker',
    proxy: {
      http: 'http://proxy.example:8080',
      no_proxy: 'localhost,.example',
    },
  });
  assert.throws(
    () =>
      resolveCliRuntime(experiment, {
        FORGE_HTTP_PROXY: 'http://user:secret@proxy.example',
      }),
    /nonsecret/,
  );
});
