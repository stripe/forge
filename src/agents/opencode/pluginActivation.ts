import type {
  MutableWorkspace,
  ReadonlyWorkspace,
} from '../../contracts/runtime.ts';
import { parseJson, record } from './native.ts';
import { PLUGIN_ROOT } from './pluginConfig.ts';

// Run-owned adapter protocol, outside the fingerprinted plugin tree.
export const PLUGIN_ACTIVATION_PATH = 'plugin-activation.json';
const MAX_ACTIVATION_BYTES = 16 * 1024;
const FORMAT = 'forge-opencode-plugins-v1';

export async function initializePluginActivation(
  state: MutableWorkspace,
): Promise<void> {
  if ((await state.inspect(PLUGIN_ACTIVATION_PATH)).kind !== 'absent')
    throw new Error('OpenCode plugin activation state already exists.');
  await writePluginActivation(state, false);
}

export async function writePluginActivation(
  state: MutableWorkspace,
  active: boolean,
): Promise<void> {
  await state.writeFile(
    PLUGIN_ACTIVATION_PATH,
    Buffer.from(
      JSON.stringify({ format: FORMAT, plugins: active ? ['stripe'] : [] }),
    ),
    { mode: 0o600 },
  );
}

/** Missing state is an error; an empty record explicitly selects the baseline. */
export async function readPluginActivation(
  state: ReadonlyWorkspace,
): Promise<boolean> {
  const entry = await state.inspect(PLUGIN_ACTIVATION_PATH);
  if (entry.kind !== 'file')
    throw new Error('OpenCode plugin activation state must be a regular file.');
  const value = record(
    parseJson(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await state.readFile(PLUGIN_ACTIVATION_PATH, {
          maxBytes: MAX_ACTIVATION_BYTES,
        }),
      ),
      MAX_ACTIVATION_BYTES,
    ),
  );
  if (
    Object.keys(value).length !== 2 ||
    value.format !== FORMAT ||
    !Array.isArray(value.plugins) ||
    !(
      value.plugins.length === 0 ||
      (value.plugins.length === 1 && value.plugins[0] === 'stripe')
    )
  )
    throw new Error('Invalid OpenCode plugin activation state.');
  const active = value.plugins.length === 1;
  if (!active && (await state.inspect(PLUGIN_ROOT)).kind !== 'absent')
    throw new Error('OpenCode has an orphaned Stripe plugin root.');
  return active;
}
