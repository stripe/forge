import { isSafeWorkspaceRelativePath } from '../model/paths.ts';
import type { CommandSetupStepV1, SetupStepV1 } from '../model/types.ts';
import type {
  PreparedSetupStep,
  SetupExecutionContext,
  SetupStepHandler,
} from './types.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const NO_REQUIREMENTS = Object.freeze({});

export const commandSetupHandler: SetupStepHandler = Object.freeze({
  uses: 'forge/command',
  preflight(step: SetupStepV1): PreparedSetupStep {
    if (step.uses !== 'forge/command') {
      throw new TypeError(
        `forge/command cannot handle ${JSON.stringify(step.uses)}.`,
      );
    }
    const commandStep = step as CommandSetupStepV1;
    assertArgv(commandStep.with.argv);
    if (
      commandStep.with.cwd !== undefined &&
      !isSafeWorkspaceRelativePath(commandStep.with.cwd, { allowRoot: true })
    ) {
      throw new TypeError(
        `Invalid command working directory: ${commandStep.with.cwd}`,
      );
    }
    if (
      commandStep.with.timeout_ms !== undefined &&
      (!Number.isSafeInteger(commandStep.with.timeout_ms) ||
        commandStep.with.timeout_ms <= 0)
    ) {
      throw new TypeError('Command timeout_ms must be a positive integer.');
    }

    const argv = Object.freeze([...commandStep.with.argv]);
    const cwd = commandStep.with.cwd;
    const timeoutMs = commandStep.with.timeout_ms;
    return Object.freeze({
      requirements: NO_REQUIREMENTS,
      async apply(context: SetupExecutionContext) {
        const result = await context.commands.run(argv, {
          ...(cwd === undefined ? {} : { cwd }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
          signal: context.signal,
        });
        if (result.exitCode !== 0) {
          // Output may include credentials. The lifecycle can retain redacted
          // diagnostics through an observer without attaching it to this error.
          throw new Error(
            `Setup command exited with status ${result.exitCode}.`,
          );
        }
      },
    });
  },
});

function assertArgv(argv: readonly string[]): void {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some(
      (argument) => typeof argument !== 'string' || argument.includes('\0'),
    )
  ) {
    throw new TypeError('Command argv must contain non-NUL strings.');
  }
}
