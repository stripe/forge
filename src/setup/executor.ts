import {
  assertEnvironmentName,
  credentialReference,
  type CredentialRequirement,
} from '../contracts/credentials.js';
import {isSafeActionIdentifier} from '../model/paths.js';
import type {
  AgentSelectionV1,
  ResolvedRunPlanV1,
  SetupStepV1,
} from '../model/types.js';
import {
  defaultSetupActionRegistry,
  type SetupActionRegistry,
} from './registry.js';
import {
  SetupActionError,
  UnsupportedSetupActionError,
  type PreparedSetup,
  type PreparedSetupStep,
  type SetupApplyContext,
  type SetupCredentialRequirements,
  type SetupStepHandler,
  type SetupStepRequirements,
  type SetupExecutor,
} from './types.js';

/** Actions implemented and shipped by the exact installed Forge version. */
export const firstPartySetupHandlers: ReadonlyMap<string, SetupStepHandler> =
  handlersForRegistry(defaultSetupActionRegistry);

export function createSetupExecutor(): SetupExecutor {
  return createSetupExecutorForRegistry(defaultSetupActionRegistry);
}

/** Construct an executor bound to the exact immutable registry owned by an engine. */
export function createSetupExecutorForRegistry(
  registry: SetupActionRegistry,
): SetupExecutor {
  return createSetupExecutorWithHandlers(handlersForRegistry(registry));
}

/** @internal Contract-test seam; not exported from the package entry point. */
export function createSetupExecutorWithHandlers(
  handlers: ReadonlyMap<string, SetupStepHandler>,
): SetupExecutor {
  const selectedHandlers = new Map(handlers);

  const executor: SetupExecutor = {
    preflight(
      steps: readonly SetupStepV1[],
      context: Readonly<{
        selection: AgentSelectionV1;
        runtime: ResolvedRunPlanV1['runtime'];
      }>,
    ) {
      const selection = freezeClone(context.selection);
      const runtime = freezeClone(context.runtime);
      const preparedSteps: Array<{
        readonly index: number;
        readonly uses: string;
        readonly prepared: PreparedSetupStep;
        readonly setupCredentialEnvironmentNames: readonly string[];
      }> = [];
      const requirementAccumulator = createRequirementAccumulator();

      for (let index = 0; index < steps.length; index += 1) {
        const inputStep = steps[index];
        if (!inputStep || !isSafeActionIdentifier(inputStep.uses)) {
          throw new UnsupportedSetupActionError(String(inputStep?.uses), index);
        }
        const step = freezeClone(inputStep);
        const handler = selectedHandlers.get(step.uses);
        if (!handler) {
          throw new UnsupportedSetupActionError(step.uses, index);
        }
        const prepared = normalizePreparedStep(
          handler.preflight(step, {stepIndex: index, selection, runtime}),
          step.uses,
        );
        requirementAccumulator.add(prepared.requirements);
        const setupCredentialEnvironmentNames = Object.freeze(
          Object.keys(prepared.requirements.credentials?.setup ?? {}).sort(
            compareCodeUnits,
          ),
        );
        preparedSteps.push(
          Object.freeze({
            index,
            uses: step.uses,
            prepared,
            setupCredentialEnvironmentNames,
          }),
        );
      }

      const requirements = requirementAccumulator.finish();
      let applied = false;
      const preparedSetup: PreparedSetup = {
        requirements,
        async apply(applyContext: SetupApplyContext): Promise<void> {
          if (applied) {
            throw new Error('Prepared setup has already been applied.');
          }
          applied = true;
          for (const step of preparedSteps) {
            applyContext.signal.throwIfAborted();
            try {
              await step.prepared.apply({
                ...applyContext,
                commands:
                  step.setupCredentialEnvironmentNames.length === 0
                    ? applyContext.commands.uncredentialed
                    : applyContext.commands.setup(
                        step.setupCredentialEnvironmentNames,
                      ),
                stepIndex: step.index,
                selection,
                runtime,
              });
            } catch (error) {
              if (applyContext.signal.aborted) applyContext.signal.throwIfAborted();
              if (error instanceof SetupActionError) throw error;
              throw new SetupActionError(step.uses, step.index, {cause: error});
            }
          }
        },
      };
      return Object.freeze(preparedSetup);
    },
  };
  return Object.freeze(executor);
}

function normalizePreparedStep(
  input: PreparedSetupStep,
  uses: string,
): PreparedSetupStep {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['requirements', 'apply']) ||
    typeof input.apply !== 'function'
  ) {
    throw new TypeError(`Setup handler ${uses} returned an invalid prepared step.`);
  }
  const requirements = normalizeStepRequirements(input.requirements, uses);
  return Object.freeze({requirements, apply: input.apply});
}

function normalizeStepRequirements(
  input: SetupStepRequirements,
  uses: string,
): SetupStepRequirements {
  if (!isPlainRecord(input)) {
    throw new TypeError(`Setup handler ${uses} returned invalid requirements.`);
  }
  const unknownKeys = ownStringKeys(
    input,
    `Setup handler ${uses} requirements`,
  ).filter((key) => key !== 'variables' && key !== 'credentials');
  if (unknownKeys.length > 0) {
    throw new TypeError(`Setup handler ${uses} returned unknown requirements.`);
  }

  const variablesInput = Object.hasOwn(input, 'variables')
    ? input.variables
    : {};
  if (!isPlainRecord(variablesInput)) {
    throw new TypeError(`Setup handler ${uses} returned invalid variables.`);
  }
  const variables: Record<string, string> = {};
  for (const name of ownStringKeys(variablesInput, 'Setup variables')) {
    const value = variablesInput[name];
    assertEnvironmentName(name);
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
      throw new TypeError(`Setup variable ${name} is invalid.`);
    }
    defineRecordValue(variables, name, value);
  }

  const credentialsInput = Object.hasOwn(input, 'credentials')
    ? input.credentials
    : {};
  if (!isPlainRecord(credentialsInput)) {
    throw new TypeError(`Setup handler ${uses} returned invalid credentials.`);
  }
  const unknownCredentialKeys = ownStringKeys(
    credentialsInput,
    `Setup handler ${uses} credentials`,
  ).filter(
    (key) => key !== 'setup' && key !== 'agent',
  );
  if (unknownCredentialKeys.length > 0) {
    throw new TypeError(`Setup handler ${uses} assigned an invalid credential scope.`);
  }
  const setup = normalizeCredentialRequirements(
    Object.hasOwn(credentialsInput, 'setup') ? credentialsInput.setup : {},
    uses,
  );
  const agent = normalizeCredentialRequirements(
    Object.hasOwn(credentialsInput, 'agent') ? credentialsInput.agent : {},
    uses,
  );

  return freezeRequirements({variables, setup, agent});
}

function normalizeCredentialRequirements(
  input: unknown,
  uses: string,
): SetupCredentialRequirements {
  if (!isPlainRecord(input)) {
    throw new TypeError(
      `Setup handler ${uses} returned invalid credential requirements.`,
    );
  }
  const output: Record<string, CredentialRequirement> = {};
  for (const name of ownStringKeys(input, 'Setup credential requirements')) {
    const binding = input[name];
    assertEnvironmentName(name);
    if (
      !isPlainRecord(binding) ||
      !hasExactKeys(binding, ['reference']) ||
      typeof binding.reference !== 'string' ||
      binding.reference.length === 0 ||
      binding.reference.includes('\0')
    ) {
      throw new TypeError(`Setup credential binding ${name} is invalid.`);
    }
    defineRecordValue(
      output,
      name,
      Object.freeze({reference: credentialReference(binding.reference)}),
    );
  }
  return Object.freeze(output);
}

function createRequirementAccumulator(): Readonly<{
  add(input: SetupStepRequirements): void;
  finish(): SetupStepRequirements;
}> {
  const variables: Record<string, string> = {};
  const setup: Record<string, CredentialRequirement> = {};
  const agent: Record<string, CredentialRequirement> = {};
  const credentials = new Map<string, string>();

  const addCredentials = (
    input: SetupCredentialRequirements | undefined,
    output: Record<string, CredentialRequirement>,
  ): void => {
    for (const [name, binding] of Object.entries(input ?? {})) {
      if (Object.hasOwn(variables, name)) {
        throw new TypeError(
          `Environment variable ${name} cannot be both plain and credential-backed.`,
        );
      }
      const previous = credentials.get(name);
      if (previous !== undefined && previous !== binding.reference) {
        throw new TypeError(`Credential binding ${name} has conflicting references.`);
      }
      credentials.set(name, binding.reference);
      if (!Object.hasOwn(output, name)) {
        defineRecordValue(
          output,
          name,
          Object.freeze({reference: binding.reference}),
        );
      }
    }
  };

  return Object.freeze({
    add(input) {
      for (const [name, value] of Object.entries(input.variables ?? {})) {
        if (credentials.has(name)) {
          throw new TypeError(
            `Environment variable ${name} cannot be both plain and credential-backed.`,
          );
        }
        if (Object.hasOwn(variables, name) && variables[name] !== value) {
          throw new TypeError(`Environment variable ${name} has conflicting values.`);
        }
        defineRecordValue(variables, name, value);
      }
      addCredentials(input.credentials?.setup, setup);
      addCredentials(input.credentials?.agent, agent);
    },
    finish() {
      return freezeRequirements({variables, setup, agent});
    },
  });
}

function freezeRequirements(input: {
  readonly variables: Record<string, string>;
  readonly setup: Record<string, CredentialRequirement>;
  readonly agent: Record<string, CredentialRequirement>;
}): SetupStepRequirements {
  const variables = Object.freeze(input.variables);
  const setup = Object.freeze(input.setup);
  const agent = Object.freeze(input.agent);
  return Object.freeze({
    ...(Object.keys(variables).length === 0 ? {} : {variables}),
    ...(Object.keys(setup).length === 0 && Object.keys(agent).length === 0
      ? {}
      : {
          credentials: Object.freeze({
            ...(Object.keys(setup).length === 0 ? {} : {setup}),
            ...(Object.keys(agent).length === 0 ? {} : {agent}),
          }),
        }),
  });
}

function defineRecordValue<T>(
  record: Record<string, T>,
  name: string,
  value: T,
): void {
  Object.defineProperty(record, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownStringKeys(
  value: Record<string, unknown>,
  label: string,
): string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`${label} contains a non-string field.`);
  }
  return keys as string[];
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  const expectedKeys = new Set(expected);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expectedKeys.has(key))
  );
}

function handlersForRegistry(
  registry: SetupActionRegistry,
): ReadonlyMap<string, SetupStepHandler> {
  return new Map(
    registry.actionIds.map((uses) => {
      const action = registry.action(uses);
      if (!action) throw new TypeError(`Missing registered setup action: ${uses}.`);
      return [
        uses,
        Object.freeze({uses, preflight: action.preflight}),
      ] as const;
    }),
  );
}
