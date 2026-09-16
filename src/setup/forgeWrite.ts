import * as path from 'node:path';
import {isSafeWorkspaceRelativePath} from '../model/paths.js';
import type {SetupStepV1, WriteSetupStepV1} from '../model/types.js';
import type {SetupActionHandler, SetupContext} from './types.js';

const MAX_WRITE_BYTES = 64 * 1024 * 1024;

export const writeSetupHandler: SetupActionHandler =
  Object.freeze({
    uses: 'forge/write@1',
    async execute(step: SetupStepV1, context: SetupContext) {
      if (step.uses !== 'forge/write@1') {
        throw new TypeError(`forge/write@1 cannot handle ${JSON.stringify(step.uses)}.`);
      }
      // Extension actions intentionally overlap built-in discriminators in the
      // plain TypeScript model. Runtime schema validation guarantees this wire
      // shape before setup; the handler remains defensive about its identity.
      const writeStep = step as WriteSetupStepV1;
      if (!isSafeWorkspaceRelativePath(writeStep.with.target)) {
        throw new TypeError(`Invalid workspace target: ${String(writeStep.with.target)}`);
      }

      let body: Uint8Array;
      if ('content' in writeStep.with.source) {
        body = Buffer.from(writeStep.with.source.content, 'utf8');
        if (body.byteLength > MAX_WRITE_BYTES) {
          throw new Error(`Inline setup content exceeds ${MAX_WRITE_BYTES} bytes.`);
        }
      } else {
        const sourcePath = writeStep.with.source.dataset_path;
        const source = await context.inputs.inspect(sourcePath);
        if (source.kind === 'directory') {
          const entries = await context.inputs.listFiles(sourcePath, {
            signal: context.signal,
            maxEntries: 100_000,
          });
          const totalBytes = entries.reduce((total, entry) => total + (entry.size ?? 0), 0);
          if (totalBytes > MAX_WRITE_BYTES) {
            throw new Error(`Setup input tree exceeds ${MAX_WRITE_BYTES} bytes.`);
          }
          for (const entry of entries) {
            const relative = path.posix.relative(sourcePath, entry.path);
            const target = path.posix.join(writeStep.with.target, relative);
            const entryBody = await context.inputs.read(entry.path, {
              signal: context.signal,
              maxBytes: MAX_WRITE_BYTES,
            });
            await context.workspace.writeFile(target, entryBody);
          }
          return;
        }
        body = await context.inputs.read(sourcePath, {
          signal: context.signal,
          maxBytes: MAX_WRITE_BYTES,
        });
      }
      context.signal.throwIfAborted();
      await context.workspace.writeFile(writeStep.with.target, body);
    },
  });
