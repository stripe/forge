import * as path from 'node:path';
import { isSafeWorkspaceRelativePath } from '../model/paths.ts';
import type { SetupStepV1, WriteSetupStepV1 } from '../model/types.ts';
import type {
  PreparedSetupStep,
  SetupExecutionContext,
  SetupStepHandler,
} from './types.ts';

const MAX_WRITE_BYTES = 64 * 1024 * 1024;
const NO_REQUIREMENTS = Object.freeze({});

export const writeSetupHandler: SetupStepHandler = Object.freeze({
  uses: 'forge/write',
  preflight(step: SetupStepV1): PreparedSetupStep {
    if (step.uses !== 'forge/write') {
      throw new TypeError(
        `forge/write cannot handle ${JSON.stringify(step.uses)}.`,
      );
    }
    // Runtime schema validation guarantees this wire shape before setup; the
    // handler remains defensive about its identity.
    const writeStep = step as WriteSetupStepV1;
    if (!isSafeWorkspaceRelativePath(writeStep.with.target)) {
      throw new TypeError(
        `Invalid workspace target: ${String(writeStep.with.target)}`,
      );
    }

    const target = writeStep.with.target;
    const source =
      'content' in writeStep.with.source
        ? Object.freeze({ content: writeStep.with.source.content })
        : Object.freeze({ dataset_path: writeStep.with.source.dataset_path });
    if ('content' in source) {
      const inlineBytes = Buffer.byteLength(source.content, 'utf8');
      if (inlineBytes > MAX_WRITE_BYTES) {
        throw new Error(
          `Inline setup content exceeds ${MAX_WRITE_BYTES} bytes.`,
        );
      }
    }

    return Object.freeze({
      requirements: NO_REQUIREMENTS,
      async apply(context: SetupExecutionContext) {
        let body: Uint8Array;
        if ('content' in source) {
          body = Buffer.from(source.content, 'utf8');
        } else {
          const sourcePath = source.dataset_path;
          const input = await context.inputs.inspect(sourcePath);
          if (input.kind === 'directory') {
            const entries = await context.inputs.listFiles(sourcePath, {
              signal: context.signal,
              maxEntries: 100_000,
            });
            if (entries.length === 0) {
              throw new Error(
                `Setup input directory contains no files: ${sourcePath}`,
              );
            }
            const totalBytes = entries.reduce<number>(
              (total, entry) => total + (entry.size ?? 0),
              0,
            );
            if (totalBytes > MAX_WRITE_BYTES) {
              throw new Error(
                `Setup input tree exceeds ${MAX_WRITE_BYTES} bytes.`,
              );
            }
            for (const entry of entries) {
              const relative = path.posix.relative(sourcePath, entry.path);
              const entryTarget = path.posix.join(target, relative);
              const entryBody = await context.inputs.read(entry.path, {
                signal: context.signal,
                maxBytes: MAX_WRITE_BYTES,
              });
              context.signal.throwIfAborted();
              await context.workspace.writeFile(entryTarget, entryBody);
            }
            return;
          }
          body = await context.inputs.read(sourcePath, {
            signal: context.signal,
            maxBytes: MAX_WRITE_BYTES,
          });
        }
        context.signal.throwIfAborted();
        await context.workspace.writeFile(target, body);
      },
    });
  },
});
