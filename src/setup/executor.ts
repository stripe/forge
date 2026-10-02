import * as path from 'node:path';

import {
  assertEnvironmentName,
  credentialReference,
  type CredentialRequirement,
} from '../contracts/credentials.js';
import {isSafeActionIdentifier} from '../model/paths.js';
import type {
  AgentSelectionV1,
  ResolvedRunPlanV2,
  SetupStepV1,
} from '../model/types.js';
import type {AgentPluginInstaller} from '../contracts/plugin.js';
import type {
  MutableWorkspace,
  RuntimeStateDirectoryRequirement,
} from '../contracts/runtime.js';
import {
  defaultSetupActionRegistry,
  type SetupActionRegistry,
} from './registry.js';
import {normalizeSetupStepResolution} from './resolution.js';
import {
  SetupActionError,
  UnsupportedSetupActionError,
  type AppliedSetupStep,
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
        runtime: ResolvedRunPlanV2['runtime'];
        pluginInstaller?: AgentPluginInstaller;
      }>,
    ) {
      const selection = freezeClone(context.selection);
      const runtime = freezeClone(context.runtime);
      const preparedSteps: Array<{
        readonly index: number;
        readonly uses: string;
        readonly prepared: PreparedSetupStep;
        readonly setupCredentialEnvironmentNames: readonly string[];
        readonly stateDirectoryIds: readonly string[];
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
          handler.preflight(step, {
            stepIndex: index,
            selection,
            runtime,
            ...(context.pluginInstaller === undefined
              ? {}
              : {pluginInstaller: context.pluginInstaller}),
          }),
          step.uses,
        );
        requirementAccumulator.add(prepared.requirements);
        const setupCredentialEnvironmentNames = Object.freeze(
          Object.keys(prepared.requirements.credentials?.setup ?? {}).sort(
            compareCodeUnits,
          ),
        );
        const stateDirectoryIds = Object.freeze(
          (prepared.requirements.stateDirectories ?? []).map(({id}) => id),
        );
        preparedSteps.push(
          Object.freeze({
            index,
            uses: step.uses,
            prepared,
            setupCredentialEnvironmentNames,
            stateDirectoryIds,
          }),
        );
      }

      const requirements = requirementAccumulator.finish();
      let applied = false;
      const preparedSetup: PreparedSetup = {
        requirements,
        async apply(applyContext: SetupApplyContext) {
          if (applied) {
            throw new Error('Prepared setup has already been applied.');
          }
          applied = true;
          const appliedSteps: AppliedSetupStep[] = [];
          for (const step of preparedSteps) {
            applyContext.signal.throwIfAborted();
            try {
              const resolution = normalizeSetupStepResolution(
                await step.prepared.apply({
                  ...applyContext,
                  stateDirectories: selectStateDirectories(
                    applyContext.stateDirectories,
                    step.stateDirectoryIds,
                  ),
                  commands:
                    step.setupCredentialEnvironmentNames.length === 0
                      ? applyContext.commands.uncredentialed
                      : applyContext.commands.setup(
                          step.setupCredentialEnvironmentNames,
                        ),
                  stepIndex: step.index,
                  selection,
                  runtime,
                }),
                step.uses,
              );
              appliedSteps.push(
                Object.freeze({
                  index: step.index,
                  uses: step.uses,
                  ...(resolution === undefined ? {} : {resolution}),
                }),
              );
            } catch (error) {
              if (applyContext.signal.aborted) applyContext.signal.throwIfAborted();
              if (error instanceof SetupActionError) throw error;
              throw new SetupActionError(step.uses, step.index, {cause: error});
            }
          }
          return Object.freeze({steps: Object.freeze(appliedSteps)});
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
  ).filter(
    (key) =>
      key !== 'executables' &&
      key !== 'stateDirectories' &&
      key !== 'variables' &&
      key !== 'credentials',
  );
  if (unknownKeys.length > 0) {
    throw new TypeError(`Setup handler ${uses} returned unknown requirements.`);
  }

  const executables = normalizeExecutableRequirements(
    Object.hasOwn(input, 'executables') ? input.executables : [],
    uses,
  );
  const stateDirectories = normalizeStateDirectoryRequirements(
    Object.hasOwn(input, 'stateDirectories') ? input.stateDirectories : [],
    uses,
  );

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

  return freezeRequirements({executables, stateDirectories, variables, setup, agent});
}

function normalizeExecutableRequirements(
  input: unknown,
  uses: string,
): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`Setup handler ${uses} returned invalid executables.`);
  }
  const seen = new Set<string>();
  const output = input.map((executable) => {
    if (
      typeof executable !== 'string' ||
      executable.length === 0 ||
      executable.length > 1_024 ||
      executable.includes('\0') ||
      seen.has(executable)
    ) {
      throw new TypeError(`Setup handler ${uses} returned invalid executables.`);
    }
    seen.add(executable);
    return executable;
  });
  return Object.freeze(output.sort(compareCodeUnits));
}

function normalizeStateDirectoryRequirements(
  input: unknown,
  uses: string,
): readonly RuntimeStateDirectoryRequirement[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`Setup handler ${uses} returned invalid state directories.`);
  }
  const ids = new Set<string>();
  const paths: string[] = [];
  const output = input.map((requirement) => {
    if (!isPlainRecord(requirement)) {
      throw new TypeError(`Setup handler ${uses} returned an invalid state directory.`);
    }
    const keys = ownStringKeys(requirement, 'Setup state directory');
    if (
      keys.some(
        (key) =>
          key !== 'id' && key !== 'containerPath' && key !== 'sealAfterSetup',
      ) ||
      !Object.hasOwn(requirement, 'id') ||
      !Object.hasOwn(requirement, 'containerPath') ||
      (Object.hasOwn(requirement, 'sealAfterSetup') &&
        typeof requirement.sealAfterSetup !== 'boolean') ||
      typeof requirement.id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(requirement.id) ||
      typeof requirement.containerPath !== 'string' ||
      !requirement.containerPath.startsWith('/') ||
      requirement.containerPath.includes('\0') ||
      path.posix.normalize(requirement.containerPath) !== requirement.containerPath ||
      ids.has(requirement.id) ||
      paths.some((existing) =>
        pathsOverlap(existing, requirement.containerPath as string),
      )
    ) {
      throw new TypeError(`Setup handler ${uses} returned an invalid state directory.`);
    }
    const id = requirement.id as string;
    const containerPath = requirement.containerPath as string;
    const sealAfterSetup = requirement.sealAfterSetup as boolean | undefined;
    ids.add(id);
    paths.push(containerPath);
    return Object.freeze({
      id,
      containerPath,
      ...(sealAfterSetup === undefined
        ? {}
        : {sealAfterSetup}),
    });
  });
  return Object.freeze(output.sort((left, right) => compareCodeUnits(left.id, right.id)));
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
  const executables = new Set<string>();
  const stateDirectories = new Map<string, RuntimeStateDirectoryRequirement>();
  const statePaths = new Map<string, string>();
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
      for (const executable of input.executables ?? []) executables.add(executable);
      for (const requirement of input.stateDirectories ?? []) {
        const existing = stateDirectories.get(requirement.id);
        if (
          existing !== undefined &&
          (existing.containerPath !== requirement.containerPath ||
            (existing.sealAfterSetup ?? false) !==
              (requirement.sealAfterSetup ?? false))
        ) {
          throw new TypeError(
            `Runtime state directory ${requirement.id} has conflicting requirements.`,
          );
        }
        for (const [existingPath, existingId] of statePaths) {
          if (
            existingId !== requirement.id &&
            pathsOverlap(existingPath, requirement.containerPath)
          ) {
            throw new TypeError(
              `Runtime state path ${requirement.containerPath} has conflicting requirements.`,
            );
          }
        }
        if (existing === undefined) {
          stateDirectories.set(requirement.id, requirement);
          statePaths.set(requirement.containerPath, requirement.id);
        }
      }
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
      return freezeRequirements({
        executables: [...executables].sort(compareCodeUnits),
        stateDirectories: [...stateDirectories.values()].sort((left, right) =>
          compareCodeUnits(left.id, right.id),
        ),
        variables,
        setup,
        agent,
      });
    },
  });
}

function freezeRequirements(input: {
  readonly executables: readonly string[];
  readonly stateDirectories: readonly RuntimeStateDirectoryRequirement[];
  readonly variables: Record<string, string>;
  readonly setup: Record<string, CredentialRequirement>;
  readonly agent: Record<string, CredentialRequirement>;
}): SetupStepRequirements {
  const executables = Object.freeze([...input.executables]);
  const stateDirectories = Object.freeze([...input.stateDirectories]);
  const variables = Object.freeze(input.variables);
  const setup = Object.freeze(input.setup);
  const agent = Object.freeze(input.agent);
  return Object.freeze({
    ...(executables.length === 0 ? {} : {executables}),
    ...(stateDirectories.length === 0 ? {} : {stateDirectories}),
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

function selectStateDirectories(
  available: ReadonlyMap<string, MutableWorkspace>,
  selectedIds: readonly string[],
): ReadonlyMap<string, MutableWorkspace> {
  const selected = new Map<string, MutableWorkspace>();
  for (const id of selectedIds) {
    const workspace = available.get(id);
    if (!workspace) {
      throw new TypeError(`Prepared runtime omitted setup state directory ${id}.`);
    }
    selected.set(id, workspace);
  }
  return new ReadonlyMapView(selected);
}

class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly size: number;

  constructor(private readonly source: ReadonlyMap<Key, Value>) {
    this.size = source.size;
    Object.freeze(this);
  }

  entries(): MapIterator<[Key, Value]> {
    return this.source.entries();
  }

  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.source) callbackfn.call(thisArg, value, key, this);
  }

  get(key: Key): Value | undefined {
    return this.source.get(key);
  }

  has(key: Key): boolean {
    return this.source.has(key);
  }

  keys(): MapIterator<Key> {
    return this.source.keys();
  }

  values(): MapIterator<Value> {
    return this.source.values();
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'ReadonlyMap';
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  );
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
