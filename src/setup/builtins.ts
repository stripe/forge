import {z} from 'zod';

import type {JsonObject} from '../model/types.js';
import {
  isSafeDatasetRelativePath,
  isSafeGitHubRepository,
  isSafeSimpleIdentifier,
  isSafeWorkspaceRelativePath,
} from '../model/paths.js';
import {commandSetupHandler} from './forgeCommand.js';
import {pluginSetupHandler} from './forgePlugin.js';
import {writeSetupHandler} from './forgeWrite.js';
import type {SetupActionDefinition} from './registry.js';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_COMMAND_ARGUMENTS = 256;
const MAX_PLUGIN_DISTRIBUTIONS = 100;

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
    (value) => isSafeWorkspaceRelativePath(value, {allowRoot: true}),
    'must be a canonical workspace-relative POSIX directory',
  );
const PositiveIntegerSchema = z.number().finite().int().safe().positive();

const WriteSetupWithSchema = z
  .object({
    target: WorkspacePathSchema,
    source: z.union([
      z.object({content: z.string().refine(isBoundedText)}).strict(),
      z.object({dataset_path: DatasetPathSchema}).strict(),
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

const GitHubRepositorySchema = z
  .string()
  .max(512)
  .refine(isSafeGitHubRepository, 'must be a GitHub owner/repository');
const PluginIdSchema = z
  .string()
  .refine(isQualifiedPluginId, 'must be plugin@marketplace using safe identifiers');

const PluginDistributionSchema = z
  .object({
    plugin: PluginIdSchema,
    marketplace: GitHubRepositorySchema,
  })
  .strict();

const PluginSetupWithSchema = z
  .object({
    agents: z.record(z.string(), PluginDistributionSchema).superRefine(
      (agents, context) => {
        const names = Object.keys(agents);
        if (names.length === 0 || names.length > MAX_PLUGIN_DISTRIBUTIONS) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'must contain a bounded non-empty agent map',
          });
        }
        for (const name of names) {
          if (!isSafeSimpleIdentifier(name)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [name],
              message: 'agent key must be a safe adapter identifier',
            });
          }
        }
      },
    ),
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

export const builtInSetupActions: readonly SetupActionDefinition[] =
  Object.freeze([writeSetupAction, commandSetupAction, pluginSetupAction]);

function isBoundedText(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES &&
    !value.includes('\0')
  );
}

function isQualifiedPluginId(value: string): boolean {
  const separator = value.indexOf('@');
  return (
    separator > 0 &&
    separator === value.lastIndexOf('@') &&
    isSafeSimpleIdentifier(value.slice(0, separator)) &&
    isSafeSimpleIdentifier(value.slice(separator + 1))
  );
}
