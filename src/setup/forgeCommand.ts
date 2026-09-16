import {isSafeWorkspaceRelativePath} from '../model/paths.js';
import type {CommandSetupStepV1, SetupStepV1} from '../model/types.js';
import type {SetupActionHandler, SetupContext} from './types.js';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const commandSetupHandler: SetupActionHandler =
  Object.freeze({
    uses: 'forge/command@1',
    async execute(step: SetupStepV1, context: SetupContext) {
      if (step.uses !== 'forge/command@1') {
        throw new TypeError(`forge/command@1 cannot handle ${JSON.stringify(step.uses)}.`);
      }
      const commandStep = step as CommandSetupStepV1;
      assertArgv(commandStep.with.argv);
      if (
        commandStep.with.cwd !== undefined &&
        !isSafeWorkspaceRelativePath(commandStep.with.cwd, {allowRoot: true})
      ) {
        throw new TypeError(`Invalid command working directory: ${commandStep.with.cwd}`);
      }
      if (
        commandStep.with.timeout_ms !== undefined &&
        (!Number.isSafeInteger(commandStep.with.timeout_ms) ||
          commandStep.with.timeout_ms <= 0)
      ) {
        throw new TypeError('Command timeout_ms must be a positive integer.');
      }

      const result = await context.commands.run(commandStep.with.argv, {
        ...(commandStep.with.cwd === undefined ? {} : {cwd: commandStep.with.cwd}),
        ...(commandStep.with.timeout_ms === undefined
          ? {}
          : {timeoutMs: commandStep.with.timeout_ms}),
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        signal: context.signal,
      });
      if (result.exitCode !== 0) {
        // Output may include credentials. The lifecycle can retain redacted
        // diagnostics through an observer without attaching it to this error.
        throw new Error(`Setup command exited with status ${result.exitCode}.`);
      }
    },
  });

function assertArgv(argv: readonly string[]): void {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
  ) {
    throw new TypeError('Command argv must contain non-NUL strings.');
  }
}
