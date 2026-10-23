import { DockerProxySchema } from './model/dockerNetwork.ts';
import type { LoadedExperimentConfigV1 } from './model/types.ts';

/** Resolve explicit CLI overrides before planning; core parsing stays ambient-free. */
export function resolveCliRuntime(
  experiment: LoadedExperimentConfigV1,
  environment: Readonly<Record<string, string | undefined>>,
): LoadedExperimentConfigV1 {
  const overrides = [
    ['FORGE_DOCKER_NETWORK', 'network'],
    ['FORGE_DOCKER_BUILD_NETWORK', 'build_network'],
  ] as const;
  const output = structuredClone(experiment);
  for (const [name, field] of overrides) {
    const value = environment[name];
    if (value === undefined) continue;
    if (value !== 'host' && value !== 'default')
      throw new TypeError(`${name} must be host or default.`);
    if (
      output.config.runtime.adapter !== 'docker' ||
      'config' in output.config.runtime
    )
      throw new TypeError(`${name} requires the built-in Docker runtime.`);
    if (value === 'default') delete output.config.runtime[field];
    else output.config.runtime[field] = value;
  }
  for (const [name, field] of [
    ['FORGE_HTTP_PROXY', 'http'],
    ['FORGE_HTTPS_PROXY', 'https'],
    ['FORGE_NO_PROXY', 'no_proxy'],
  ] as const) {
    const value = environment[name];
    if (value === undefined) continue;
    if (
      output.config.runtime.adapter !== 'docker' ||
      'config' in output.config.runtime
    )
      throw new TypeError(`${name} requires the built-in Docker runtime.`);
    const proxy = { ...output.config.runtime.proxy };
    if (value === '') delete proxy[field];
    else proxy[field] = value;
    const parsed = DockerProxySchema.safeParse(proxy);
    if (!parsed.success)
      throw new TypeError(
        `${name} must be a nonsecret proxy setting; URL credentials are unsupported.`,
      );
    output.config.runtime.proxy = parsed.data;
  }
  return output;
}
