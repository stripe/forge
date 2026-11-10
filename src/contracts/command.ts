/** Output captured from a command which successfully started. */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly capture?: CommandCapture;
}

/** Bounded raw output for adapter-local extraction; never ordinary diagnostic text. */
export interface CommandCapture {
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode?: number;
  readonly signal?: string;
}

/** Controls shared by every command runtime. */
export interface CommandOptions {
  /** Workspace-relative directory. Omit it to use the workspace root. */
  readonly cwd?: string;
  /** Cancellation must terminate the command and all of its descendants. */
  readonly signal?: AbortSignal;
  /** Requested bound. Implementations may clamp it to a stricter maximum. */
  readonly timeoutMs?: number;
  /** Requested combined capture bound. Implementations may clamp it. */
  readonly maxOutputBytes?: number;
  /** Complete stdout lines, without their newline terminators. */
  readonly onStdoutLine?: (line: string) => void;
  /** Decoded stderr chunks, within the combined output bound. */
  readonly onStderrChunk?: (chunk: string) => void;
}

/**
 * Executes an argv vector without adding shell interpretation.
 *
 * Startup, cancellation, timeout and output-limit failures reject. A command
 * which starts and exits unsuccessfully resolves with a non-zero exit code.
 */
export interface CommandRunner {
  run(
    argv: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
}

export class CommandExecutionError extends Error {
  readonly capture: CommandCapture | undefined;
  constructor(
    message: string,
    readonly code:
      | 'command_aborted'
      | 'command_output_limit'
      | 'command_start_failed'
      | 'command_timeout'
      | 'command_runner_closed',
    options?: ErrorOptions & { readonly capture?: CommandCapture },
  ) {
    super(message, options);
    this.name = 'CommandExecutionError';
    this.capture = options?.capture;
    Object.defineProperty(this, 'capture', { enumerable: false });
  }
}
