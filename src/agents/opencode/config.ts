import type { ReadonlyWorkspace } from '../../contracts/runtime.ts';
import { parseJson, record } from './native.ts';

/** Authored JSON is supplied by ordinary setup, and snapshotted before interaction. */
export async function readOpenCodeConfiguration(
  workspace: ReadonlyWorkspace,
  model: string,
): Promise<string> {
  try {
    const bytes = await workspace.readFile('opencode.json', {
      maxBytes: 1024 * 1024,
    });
    const config = record(
      parseJson(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        1024 * 1024,
      ),
    );
    const provider = record(record(config.provider).forge);
    const definition = record(record(provider.models)[model]);
    // Explicit model overrides on auxiliary agents would defeat the one-model
    // experiment selection, even with small_model fixed by the adapter.
    for (const collection of [config.agent, config.agents, config.mode]) {
      if (collection === undefined) continue;
      for (const entry of Object.values(record(collection))) {
        if (record(entry).model !== undefined) throw new Error();
      }
    }
    validateConfigurationPaths(config);
    const limits = record(definition.limit);
    if (
      ![limits.context, limits.output].every(
        (value) => Number.isSafeInteger(value) && (value as number) > 0,
      ) ||
      (limits.output as number) > (limits.context as number) ||
      !['reasoning', 'temperature', 'attachment', 'tool_call'].every(
        (key) => typeof definition[key] === 'boolean',
      ) ||
      definition.tool_call !== true ||
      (definition.id !== undefined && definition.id !== model) ||
      definition.provider !== undefined ||
      definition.headers !== undefined ||
      definition.options !== undefined ||
      definition.variants !== undefined ||
      provider.api !== undefined ||
      provider.id !== undefined ||
      provider.options !== undefined ||
      provider.env !== undefined ||
      (provider.npm !== undefined &&
        provider.npm !== '@ai-sdk/openai-compatible')
    )
      throw new Error();
    // Only the selected authored definition is available to OpenCode. The
    // complete authored inventory remains in the setup step recorded by Forge.
    config.provider = {
      forge: { ...provider, models: { [model]: definition } },
    };
    return JSON.stringify(config);
  } catch {
    throw new TypeError(
      'OpenCode requires opencode.json with provider.forge.models[selected model], positive context/output limits, and explicit reasoning, temperature, attachment, and tool_call capabilities. Routing and credentials belong in adapter options; model overrides and relative config references are unsupported.',
    );
  }
}

/** Relocated native config must never silently reinterpret workspace paths. */
function validateConfigurationPaths(config: Record<string, unknown>): void {
  const absolute = (value: unknown) =>
    typeof value === 'string' && value.startsWith('/');
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{file:([^}]+)\}/g)) {
        if (!absolute(match[1])) throw new Error();
      }
    } else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) scan(child);
    }
  };
  scan(config);
  if (config.instructions !== undefined) {
    if (
      !Array.isArray(config.instructions) ||
      !config.instructions.every(
        (value) =>
          absolute(value) ||
          (typeof value === 'string' && /^https?:\/\//.test(value)),
      )
    )
      throw new Error();
  }
  if (config.skills !== undefined) {
    const paths = record(config.skills).paths;
    if (
      paths !== undefined &&
      (!Array.isArray(paths) || !paths.every(absolute))
    )
      throw new Error();
  }
  for (const plugins of [config.plugin, config.plugins]) {
    if (plugins === undefined) continue;
    if (!Array.isArray(plugins)) throw new Error();
    for (const entry of plugins) {
      const ref = Array.isArray(entry) ? entry[0] : entry;
      if (
        typeof ref !== 'string' ||
        ref.startsWith('.') ||
        ref.startsWith('~') ||
        (ref.startsWith('file:') && !ref.startsWith('file:///'))
      )
        throw new Error();
    }
  }
}
