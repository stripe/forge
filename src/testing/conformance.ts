import type { CommandRunner } from '../contracts/command.ts';
import type {
  RuntimeAdapter,
  RuntimePreparation,
} from '../contracts/runtime.ts';

export interface RuntimeAdapterConformanceOptions {
  readonly probePath?: string;
  readonly probeBody?: Uint8Array;
  /**
   * Explicit argv probes for the runtime's available tools. Setup projections
   * run before finalizeSetup(); agent projections run afterwards. Expected
   * output can check synthetic credential visibility without logging values.
   */
  readonly commandProbes?: readonly ({
    readonly argv: readonly string[];
    readonly expectedStdout?: string;
    readonly expectedStderr?: string;
    /** Defaults to zero; a nonzero value also probes unsuccessful exits. */
    readonly expectedExitCode?: number;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  } & (
    | { readonly scope: 'uncredentialed' | 'agent' }
    | {
        readonly scope: 'setup';
        readonly credentialEnvironmentNames: readonly string[];
      }
  ))[];
  /**
   * The agent command must emit readyLine while still running. The probe then
   * aborts it and requires rejection before deadlineMs (default 5 seconds).
   * This checks command cancellation, not operating-system descendant isolation.
   */
  readonly cancellationProbe?: {
    readonly argv: readonly string[];
    readonly readyLine: string;
    readonly deadlineMs?: number;
    readonly maxOutputBytes?: number;
    /** Defaults to command_aborted or the standard AbortError. */
    readonly isCancellationError?: (error: unknown) => boolean;
  };
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
 * failed assertion. Optional command probes use caller-supplied executables;
 * they do not prove process isolation or termination of detached descendants.
 */
export async function assertRuntimeAdapterConforms(
  adapter: RuntimeAdapter,
  input: RuntimePreparation,
  options: RuntimeAdapterConformanceOptions = {},
): Promise<RuntimeAdapterConformanceReport> {
  if (!adapter.id) {
    throw new TestingConformanceError(
      'Runtime adapters must expose a non-empty id.',
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
      input.requirements.stateDirectories.map(({ id }) => id),
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
    const probedCommands: Array<{
      commands: CommandRunner;
      probe: NonNullable<
        RuntimeAdapterConformanceOptions['commandProbes']
      >[number];
    }> = [];
    for (const requirement of input.requirements.stateDirectories) {
      await prepared.stateDirectories
        .get(requirement.id)!
        .writeFile('.forge-conformance/setup-state.bin', probeBody);
    }
    for (const probe of options.commandProbes ?? []) {
      if (probe.scope === 'agent') continue;
      const commands =
        probe.scope === 'setup'
          ? prepared.commands.setup(probe.credentialEnvironmentNames)
          : prepared.commands.uncredentialed;
      await assertCommandProbe(commands, probe, input.signal);
      probedCommands.push({ commands, probe });
    }
    await prepared.finalizeSetup();

    for (const commands of [prepared.commands.uncredentialed, setupCommands]) {
      await expectRejection(
        () => commands.run(['true']),
        'Setup command runner still accepted work after finalization.',
      );
    }
    for (const { commands, probe } of probedCommands) {
      await expectRejection(
        () => commands.run(probe.argv, { signal: input.signal }),
        `Probed ${probe.scope} command runner still accepted work after finalization.`,
      );
    }
    for (const requirement of input.requirements.stateDirectories) {
      const state = prepared.stateDirectories.get(requirement.id)!;
      if (requirement.sealAfterSetup) {
        await expectRejection(
          () => state.writeFile('.forge-conformance/late-state.bin', probeBody),
          `Setup-sealed state ${requirement.id} remained mutable after finalization.`,
        );
      } else {
        await state.writeFile(
          '.forge-conformance/interaction-state.bin',
          probeBody,
        );
      }
    }
    for (const probe of options.commandProbes ?? []) {
      if (probe.scope !== 'agent') continue;
      await assertCommandProbe(prepared.commands.agent, probe, input.signal);
      probedCommands.push({ commands: prepared.commands.agent, probe });
    }
    if (options.cancellationProbe) {
      await assertCommandCancellation(
        prepared.commands.agent,
        options.cancellationProbe,
        input.signal,
      );
    }

    const sealed = await prepared.quiesce();
    if (sealed.runtimeId !== prepared.runtimeId) {
      fail('Sealed runtimeId must equal the prepared runtimeId.');
    }
    assertLogicalPaths(sealed.paths);
    if (
      sealed.paths.home !== prepared.paths.home ||
      sealed.paths.workspace !== prepared.paths.workspace
    ) {
      fail('Runtime logical paths changed during quiescence.');
    }
    assertRequiredStateDirectories(
      input.requirements.stateDirectories.map(({ id }) => id),
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
    for (const [id, state] of prepared.stateDirectories) {
      await expectRejection(
        () => state.writeFile('.forge-conformance/late-state.bin', probeBody),
        `State directory ${id} remained mutable after quiescence.`,
      );
      const stateRead = await sealed.stateDirectories
        .get(id)!
        .readFile('.forge-conformance/setup-state.bin', {
          maxBytes: probeBody.byteLength,
        });
      if (!bytesEqual(stateRead, probeBody)) {
        fail(`Sealed state directory ${id} did not preserve setup bytes.`);
      }
    }
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
    for (const { commands, probe } of probedCommands) {
      await expectRejection(
        () => commands.run(probe.argv, { signal: input.signal }),
        `Probed ${probe.scope} command runner still accepted work after quiescence.`,
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
      { cause: error },
    );
  }
}

async function assertCommandProbe(
  commands: CommandRunner,
  probe: NonNullable<RuntimeAdapterConformanceOptions['commandProbes']>[number],
  signal: AbortSignal,
): Promise<void> {
  const result = await commands.run(probe.argv, {
    signal,
    timeoutMs: probe.timeoutMs ?? 5_000,
    maxOutputBytes: probe.maxOutputBytes ?? 64 * 1024,
  });
  if (
    result.exitCode !== (probe.expectedExitCode ?? 0) ||
    (probe.expectedStdout !== undefined &&
      result.stdout !== probe.expectedStdout) ||
    (probe.expectedStderr !== undefined &&
      result.stderr !== probe.expectedStderr)
  ) {
    // Probe output may deliberately contain synthetic credential values.
    fail(
      `Runtime command probe did not match its expected ${probe.scope} result.`,
    );
  }
}

async function assertCommandCancellation(
  commands: CommandRunner,
  probe: NonNullable<RuntimeAdapterConformanceOptions['cancellationProbe']>,
  signal: AbortSignal,
): Promise<void> {
  const deadlineMs = probe.deadlineMs ?? 5_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    fail('Cancellation probe deadlineMs must be a positive integer.');
  }
  if (!probe.readyLine || /[\r\n]/.test(probe.readyLine)) {
    fail('Cancellation probe readyLine must be one non-empty line.');
  }
  signal.throwIfAborted();
  const controller = new AbortController();
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const running = commands
      .run(probe.argv, {
        signal: AbortSignal.any([signal, controller.signal]),
        // The observation deadline must precede the requested command timeout,
        // so a command which ignores cancellation cannot pass by timing out.
        timeoutMs: Math.min(Number.MAX_SAFE_INTEGER, deadlineMs * 2),
        maxOutputBytes: probe.maxOutputBytes ?? 64 * 1024,
        onStdoutLine(line) {
          if (line === probe.readyLine && !ready) {
            ready = true;
            controller.abort();
          }
        },
      })
      .then(
        () => ({ kind: 'resolved' }) as const,
        (error: unknown) => ({ kind: 'rejected', error }) as const,
      );
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new TestingConformanceError(
            'Runtime cancellation probe did not settle before its deadline.',
          ),
        );
      }, deadlineMs);
    });
    const outcome = await Promise.race([running, deadline]);
    signal.throwIfAborted();
    if (!ready) fail('Runtime cancellation probe never reported readiness.');
    if (outcome.kind !== 'rejected') {
      fail('Runtime command resolved after cancellation.');
    }
    if (!(probe.isCancellationError ?? isCancellationError)(outcome.error)) {
      fail('Runtime command failed for a reason other than cancellation.');
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      ('code' in error && error.code === 'command_aborted'))
  );
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
