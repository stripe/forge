import { z } from 'zod';
import {
  isSafeDatasetRelativePath,
  isSafeWorkspaceRelativePath,
} from '../model/paths.ts';
import type { JsonObject } from '../model/types.ts';
import { commandSetupHandler } from './forgeCommand.ts';
import { credentialsSetupHandler } from './forgeCredentials.ts';
import { pluginSetupHandler } from './forgePlugin.ts';
import { webSearchSetupHandler } from './forgeWebSearch.ts';
import { writeSetupHandler } from './forgeWrite.ts';
import type { SetupActionDefinition } from './registry.ts';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_COMMAND_ARGUMENTS = 256;

const DatasetPathSchema = z
  .string()
  .refine(
    isSafeDatasetRelativePath,
    'must be a canonical dataset-relative POSIX path',
  );
const WorkspacePathSchema = z
  .string()
  .refine(
    isSafeWorkspaceRelativePath,
    'must be a canonical workspace-relative POSIX path',
  );
const WorkspaceDirectorySchema = z
  .string()
  .refine(
    (value) => isSafeWorkspaceRelativePath(value, { allowRoot: true }),
    'must be a canonical workspace-relative POSIX directory',
  );
const PositiveIntegerSchema = z.number().finite().int().safe().positive();

const WriteSetupWithSchema = z
  .object({
    target: WorkspacePathSchema,
    source: z.union([
      z.object({ content: z.string().refine(isBoundedText) }).strict(),
      z.object({ dataset_path: DatasetPathSchema }).strict(),
    ]),
  })
  .strict();

const CommandSetupWithSchema = z
  .object({
    argv: z
      .array(z.string().min(1).refine(isBoundedText))
      .min(1)
      .max(MAX_COMMAND_ARGUMENTS),
    cwd: WorkspaceDirectorySchema.optional(),
    timeout_ms: PositiveIntegerSchema.max(60 * 60 * 1000).optional(),
  })
  .strict();

const PluginSetupWithSchema = z
  .object({
    plugin: z.literal('stripe'),
  })
  .strict();

const CredentialsSetupWithSchema = z
  .object({
    env: z
      .array(
        z
          .string()
          .max(255)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      )
      .min(1)
      .max(128)
      .refine((names) => new Set(names).size === names.length, {
        message: 'credential environment names must be unique',
      }),
  })
  .strict();

const writeSetupAction: SetupActionDefinition = Object.freeze({
  ...writeSetupHandler,
  parseWith(input: unknown): JsonObject {
    return WriteSetupWithSchema.parse(input) as JsonObject;
  },
});

const commandSetupAction: SetupActionDefinition = Object.freeze({
  ...commandSetupHandler,
  parseWith(input: unknown): JsonObject {
    return CommandSetupWithSchema.parse(input) as JsonObject;
  },
});

const pluginSetupAction: SetupActionDefinition = Object.freeze({
  ...pluginSetupHandler,
  parseWith(input: unknown): JsonObject {
    return PluginSetupWithSchema.parse(input) as JsonObject;
  },
});

const credentialsSetupAction: SetupActionDefinition = Object.freeze({
  ...credentialsSetupHandler,
  parseWith(input: unknown): JsonObject {
    return CredentialsSetupWithSchema.parse(input) as JsonObject;
  },
});

export const builtInSetupActions: readonly SetupActionDefinition[] =
  Object.freeze([
    writeSetupAction,
    commandSetupAction,
    pluginSetupAction,
    credentialsSetupAction,
    Object.freeze({ ...webSearchSetupHandler, parseWith: (input: unknown) => z.object({}).strict().parse(input) }),
  ]);

function isBoundedText(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES && !value.includes('\0')
  );
}
