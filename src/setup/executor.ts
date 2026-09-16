import {isSafeActionIdentifier} from '../model/paths.js';
import type {SetupStepV1} from '../model/types.js';
import {commandSetupHandler} from './forgeCommand.js';
import {writeSetupHandler} from './forgeWrite.js';
import {
  SetupActionError,
  UnsupportedSetupActionError,
  type SetupStepHandler,
  type SetupContext,
  type SetupExecutor,
} from './types.js';

const BUILTIN_NAMESPACE = 'forge/';

export interface CreateSetupExecutorOptions {
  /** Host-provided actions, optionally including Forge's exact built-in map. */
  readonly handlers?: ReadonlyMap<string, SetupStepHandler>;
}

export const forgeSetupHandlers: ReadonlyMap<string, SetupStepHandler> = new Map([
  [writeSetupHandler.uses, writeSetupHandler],
  [commandSetupHandler.uses, commandSetupHandler],
]);

export function createSetupExecutor(
  options: CreateSetupExecutorOptions = {},
): SetupExecutor {
  const handlers = new Map<string, SetupStepHandler>(forgeSetupHandlers);

  for (const [registeredUses, handler] of options.handlers ?? []) {
    if (!handler || typeof handler.execute !== 'function') {
      throw new TypeError('Setup handlers must provide an execute function.');
    }
    if (!isSafeActionIdentifier(handler.uses)) {
      throw new TypeError(`Invalid setup action identifier: ${String(handler.uses)}`);
    }
    if (registeredUses !== handler.uses) {
      throw new TypeError(
        `Setup handler key ${registeredUses} does not match ${handler.uses}.`,
      );
    }
    if (handler.uses.startsWith(BUILTIN_NAMESPACE)) {
      if (handlers.get(handler.uses) === handler) continue;
      throw new TypeError(`The ${BUILTIN_NAMESPACE} namespace is reserved by Forge.`);
    }
    if (handlers.has(handler.uses)) {
      throw new TypeError(`Duplicate setup action handler: ${handler.uses}`);
    }
    handlers.set(handler.uses, handler);
  }

  const preflight = (steps: readonly SetupStepV1[]): void => {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step || !isSafeActionIdentifier(step.uses) || !handlers.has(step.uses)) {
        throw new UnsupportedSetupActionError(String(step?.uses), index);
      }
    }
  };

  return Object.freeze({
    preflight,
    async apply(steps: readonly SetupStepV1[], context: SetupContext) {
      preflight(steps);
      for (let index = 0; index < steps.length; index += 1) {
        context.signal.throwIfAborted();
        const step = steps[index]!;
        const handler = handlers.get(step.uses)!;
        try {
          await handler.execute(step, context);
        } catch (error) {
          if (context.signal.aborted) context.signal.throwIfAborted();
          if (error instanceof SetupActionError) throw error;
          throw new SetupActionError(step.uses, index, {cause: error});
        }
      }
    },
  });
}
