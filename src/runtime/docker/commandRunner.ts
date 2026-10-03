import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../contracts/command.js';
import {CommandExecutionError} from '../../contracts/command.js';
import type {
  CredentialScope,
  ResolvedEnvironment,
} from '../../contracts/credentials.js';
import {isSafeWorkspaceRelativePath} from '../../model/paths.js';
import type {HostCommandRunner} from '../processCommandRunner.js';

interface DockerCommandControllerOptions {
  readonly dockerExecutable: string;
  readonly containerName: string;
  readonly environment: ResolvedEnvironment;
  readonly environmentFileRoot: string;
  readonly hostCommands: HostCommandRunner;
  readonly defaultTimeoutMs: number;
  readonly maximumTimeoutMs: number;
  readonly maximumOutputBytes: number;
}

/** Coordinates scoped docker-exec runners and the quiescence barrier. */
export class DockerCommandController {
  private closed = false;
  private setupFinalized = false;
  private readonly active = new Set<Promise<unknown>>();

  constructor(private readonly options: DockerCommandControllerOptions) {}

  withoutCredentials(): CommandRunner {
    return Object.freeze({
      run: async (argv: readonly string[], options?: CommandOptions) =>
        this.run(undefined, undefined, argv, options),
    });
  }

  forScope(
    scope: CredentialScope,
    credentialEnvironmentNames: readonly string[],
  ): CommandRunner {
    const allowedCredentialEnvironmentNames =
      normalizeCredentialEnvironmentNames(
        this.options.environment,
        scope,
        credentialEnvironmentNames,
      );
    return Object.freeze({
      run: async (argv: readonly string[], options?: CommandOptions) =>
        this.run(scope, allowedCredentialEnvironmentNames, argv, options),
    });
  }

  /** Runtime-owned, credential-free probes after setup command authority closes. */
  finalizedWithoutCredentials(): CommandRunner {
    return Object.freeze({
      run: async (argv: readonly string[], options?: CommandOptions) => {
        if (!this.setupFinalized) {
          throw new CommandExecutionError(
            'Runtime setup has not been finalized.',
            'command_runner_closed',
          );
        }
        return this.run(undefined, undefined, argv, options, true);
      },
    });
  }

  async closeAndWait(): Promise<void> {
    this.closed = true;
    const settled = await Promise.allSettled([...this.active]);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Active runtime commands failed while quiescing.');
    }
  }

  /** Close preparation/setup projections while retaining the agent projection. */
  async finalizeSetupAndWait(): Promise<void> {
    if (this.closed) {
      throw new CommandExecutionError(
        'Runtime command runner has been quiesced.',
        'command_runner_closed',
      );
    }
    if (this.setupFinalized) {
      throw new CommandExecutionError(
        'Runtime setup has already been finalized.',
        'command_runner_closed',
      );
    }
    this.setupFinalized = true;
    const settled = await Promise.allSettled([...this.active]);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Active runtime commands failed while finalizing setup.',
      );
    }
  }

  private run(
    scope: CredentialScope | undefined,
    allowedCredentialEnvironmentNames: ReadonlySet<string> | undefined,
    argv: readonly string[],
    options: CommandOptions = {},
    allowAfterSetup = false,
  ): Promise<CommandResult> {
    if (this.closed) {
      throw new CommandExecutionError(
        'Runtime command runner has been quiesced.',
        'command_runner_closed',
      );
    }
    if (this.setupFinalized && scope !== 'agent' && !allowAfterSetup) {
      throw new CommandExecutionError(
        'Runtime setup command runner has been finalized.',
        'command_runner_closed',
      );
    }
    assertArgv(argv);
    const cwd = options.cwd ?? '.';
    if (!isSafeWorkspaceRelativePath(cwd, {allowRoot: true})) {
      throw new TypeError(`Invalid workspace command directory: ${cwd}`);
    }
    const timeoutMs = clampPositive(
      options.timeoutMs ?? this.options.defaultTimeoutMs,
      this.options.maximumTimeoutMs,
      'timeoutMs',
    );
    const maxOutputBytes = clampPositive(
      options.maxOutputBytes ?? this.options.maximumOutputBytes,
      this.options.maximumOutputBytes,
      'maxOutputBytes',
    );

    const environment: Record<string, string> = Object.assign(
      Object.create(null) as Record<string, string>,
      this.options.environment.variables,
    );
    for (const [name, binding] of Object.entries(
      this.options.environment.credentials,
    )) {
      if (
        scope !== undefined &&
        allowedCredentialEnvironmentNames?.has(name) &&
        binding.scopes.includes(scope)
      ) {
        environment[name] = binding.value;
      }
    }
    const environmentNames = Object.keys(environment).sort();
    const running = this.runWithScopedEnvironment({
      argv,
      cwd,
      environment,
      environmentNames,
      maxOutputBytes,
      options,
      timeoutMs,
    });
    this.active.add(running);
    void running.then(
      () => this.active.delete(running),
      () => this.active.delete(running),
    );
    return running;
  }

  private async runWithScopedEnvironment(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly environmentNames: readonly string[];
    readonly maxOutputBytes: number;
    readonly options: CommandOptions;
    readonly timeoutMs: number;
  }): Promise<CommandResult> {
    const environmentFile = path.join(
      this.options.environmentFileRoot,
      `environment-${randomUUID()}`,
    );
    for (const [name, value] of Object.entries(input.environment)) {
      if (value.includes('\n') || value.includes('\r')) {
        throw new TypeError(
          `Docker-scoped environment variable ${name} cannot contain a newline.`,
        );
      }
    }
    try {
      const body = input.environmentNames
        .map((name) => `${name}=${input.environment[name] ?? ''}`)
        .join('\n');
      await fs.writeFile(environmentFile, body, {flag: 'wx', mode: 0o600});
      const dockerArgv = [
        this.options.dockerExecutable,
        'exec',
        '--workdir',
        input.cwd === '.' ? '/workspace' : `/workspace/${input.cwd}`,
        ...(input.environmentNames.length === 0
          ? []
          : ['--env-file', environmentFile]),
        this.options.containerName,
        ...input.argv,
      ];
      return await this.options.hostCommands.run(dockerArgv, {
        maxOutputBytes: input.maxOutputBytes,
        ...(input.options.onStdoutLine === undefined
          ? {}
          : {onStdoutLine: input.options.onStdoutLine}),
        ...(input.options.signal === undefined
          ? {}
          : {signal: input.options.signal}),
        timeoutMs: input.timeoutMs,
      });
    } finally {
      await fs.rm(environmentFile, {force: true}).catch(() => undefined);
    }
  }
}

function normalizeCredentialEnvironmentNames(
  environment: ResolvedEnvironment,
  scope: CredentialScope,
  input: readonly string[],
): ReadonlySet<string> {
  if (!Array.isArray(input)) {
    throw new TypeError('Credential environment names must be an array.');
  }
  const names = new Set<string>();
  for (const name of input) {
    if (typeof name !== 'string' || names.has(name)) {
      throw new TypeError('Credential environment names must be unique strings.');
    }
    const binding = Object.hasOwn(environment.credentials, name)
      ? environment.credentials[name]
      : undefined;
    if (!binding?.scopes.includes(scope)) {
      throw new TypeError(
        `Credential environment variable ${JSON.stringify(name)} is not available in ${scope} scope.`,
      );
    }
    names.add(name);
  }
  return names;
}

function assertArgv(argv: readonly string[]): void {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
  ) {
    throw new TypeError('Command argv must contain non-NUL strings.');
  }
}

function clampPositive(requested: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return Math.min(requested, maximum);
}
