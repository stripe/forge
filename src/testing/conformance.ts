import type {
  RuntimeAdapter,
  RuntimePreparation,
} from '../contracts/runtime.js';

export interface RuntimeAdapterConformanceOptions {
  readonly probePath?: string;
  readonly probeBody?: Uint8Array;
}

export interface RuntimeAdapterConformanceReport {
  readonly runtimeId: string;
  readonly stateDirectoryIds: readonly string[];
}

export class TestingConformanceError extends Error {
  readonly code = 'testing_conformance_failure' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TestingConformanceError';
  }
}

/**
 * Exercise the lifecycle guarantees every RuntimeAdapter owes executeEval.
 *
 * The probe acquires and disposes a real runtime, so callers should use a
 * dedicated run ID and test workspace. Cleanup is attempted even after a
 * failed assertion.
 */
export async function assertRuntimeAdapterConforms(
  adapter: RuntimeAdapter,
  input: RuntimePreparation,
  options: RuntimeAdapterConformanceOptions = {},
): Promise<RuntimeAdapterConformanceReport> {
  if (!adapter.id || !adapter.version) {
    throw new TestingConformanceError(
      'Runtime adapters must expose non-empty id and version strings.',
    );
  }
  const probePath = options.probePath ?? '.forge-conformance/probe.bin';
  const probeBody = options.probeBody?.slice() ?? new Uint8Array([1, 2, 3]);
  let prepared: Awaited<ReturnType<RuntimeAdapter['prepare']>> | undefined;

  try {
    prepared = await adapter.prepare(input);
    if (prepared.runtimeId !== input.runId) {
      fail('Prepared runtimeId must equal the requested runId.');
    }
    assertLogicalPaths(prepared.paths);
    assertRequiredStateDirectories(
      input.requirements.stateDirectories.map(({id}) => id),
      prepared.stateDirectories,
      'prepared runtime',
    );

    await prepared.workspace.writeFile(probePath, probeBody);
    const mutableRead = await prepared.workspace.readFile(probePath, {
      maxBytes: probeBody.byteLength,
    });
    if (!bytesEqual(mutableRead, probeBody)) {
      fail('Prepared workspace did not preserve probe bytes.');
    }
    const setupCommands = prepared.commands.setup([]);

    const sealed = await prepared.quiesce();
    if (sealed.runtimeId !== prepared.runtimeId) {
      fail('Sealed runtimeId must equal the prepared runtimeId.');
    }
    assertLogicalPaths(sealed.paths);
    assertRequiredStateDirectories(
      input.requirements.stateDirectories.map(({id}) => id),
      sealed.stateDirectories,
      'sealed runtime',
    );
    const sealedRead = await sealed.workspace.readFile(probePath, {
      maxBytes: probeBody.byteLength,
    });
    if (!bytesEqual(sealedRead, probeBody)) {
      fail('Sealed workspace did not preserve probe bytes.');
    }

    await expectRejection(
      () => prepared!.workspace.writeFile(probePath, probeBody),
      'Prepared workspace still allowed mutation after quiescence.',
    );
    for (const [scope, commands] of [
      ['uncredentialed', prepared.commands.uncredentialed],
      ['setup', setupCommands],
      ['agent', prepared.commands.agent],
    ] as const) {
      await expectRejection(
        () => commands.run(['true']),
        `${scope} command runner still accepted work after quiescence.`,
      );
    }

    await prepared.dispose();
    await prepared.dispose();
    return Object.freeze({
      runtimeId: sealed.runtimeId,
      stateDirectoryIds: Object.freeze(
        [...sealed.stateDirectories.keys()].sort(compareCodeUnits),
      ),
    });
  } catch (error) {
    await prepared?.dispose().catch(() => undefined);
    if (error instanceof TestingConformanceError) throw error;
    throw new TestingConformanceError(
      'Runtime adapter conformance probe failed.',
      {cause: error},
    );
  }
}

function assertLogicalPaths(paths: {
  readonly workspace: string;
  readonly home: string;
}): void {
  if (!paths.workspace.startsWith('/') || !paths.home.startsWith('/')) {
    fail('Runtime logical workspace and home paths must be absolute.');
  }
}

function assertRequiredStateDirectories(
  required: readonly string[],
  actual: ReadonlyMap<string, unknown>,
  label: string,
): void {
  const uniqueRequired = new Set(required);
  if (
    uniqueRequired.size !== required.length ||
    actual.size !== uniqueRequired.size ||
    [...uniqueRequired].some((stateId) => !actual.has(stateId))
  ) {
    fail(`${label} did not expose exactly the requested state directories.`);
  }
}

async function expectRejection(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  fail(message);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function fail(message: string): never {
  throw new TestingConformanceError(message);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
