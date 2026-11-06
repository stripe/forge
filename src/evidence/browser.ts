import { z } from 'zod';
import type { RunArtifact } from '../contracts/artifacts.ts';
import type { SealedRuntime } from '../contracts/runtime.ts';
import { sha256Digest } from '../model/hashes.ts';
import { isSafeWorkspaceRelativePath } from '../model/paths.ts';
import type { ResolvedRunPlanV1 } from '../model/types.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import { BROWSER_STATE_ID } from '../setup/forgeBrowser.ts';

export const MAX_BROWSER_CAPTURES = 32;
export const MAX_BROWSER_CAPTURE_BYTES = 2 * 1024 * 1024;
export const MAX_BROWSER_TOTAL_BYTES = 16 * 1024 * 1024;
export const BROWSER_MANIFEST_PATH = 'browser/manifest.json';

export const browserManifestSchema = z
  .object({
    run_id: z.string().min(1).max(255),
    session_id: z.string().min(1).max(255).nullable(),
    provider: z.literal('local'),
    controller: z.literal('playwright-mcp'),
    omitted_captures: z.number().int().nonnegative().max(1024),
    captures: z
      .array(
        z
          .object({
            path: z.string().regex(/^browser\/capture-\d{3}\.(png|jpeg)$/),
            source_path: z
              .string()
              .min(1)
              .max(4096)
              .refine(
                (value) =>
                  value.startsWith('captures/') &&
                  isSafeWorkspaceRelativePath(value),
              ),
            media_type: z.enum(['image/png', 'image/jpeg']),
            size_bytes: z
              .number()
              .int()
              .positive()
              .max(MAX_BROWSER_CAPTURE_BYTES),
            sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(MAX_BROWSER_CAPTURES),
  })
  .strict();

/** Retain bounded browser pixels only after the runtime's mutation barrier. */
export async function collectBrowserArtifacts(input: {
  plan: ResolvedRunPlanV1;
  runtime: SealedRuntime;
  runId: string;
  sessionId: string | null;
  signal: AbortSignal;
}): Promise<RunArtifact[]> {
  if (!input.plan.browser) return [];
  const state = input.runtime.stateDirectories.get(BROWSER_STATE_ID);
  if (!state) throw new TypeError('Sealed browser state is unavailable.');
  const entries = await state.listFiles({
    under: 'captures',
    maxEntries: 1024,
    signal: input.signal,
  });
  const artifacts: RunArtifact[] = [];
  const captures: z.infer<typeof browserManifestSchema>['captures'] = [];
  let total = 0;
  let omitted = 0;
  for (const entry of entries) {
    input.signal.throwIfAborted();
    if (!/\.(png|jpe?g)$/i.test(entry.path)) continue;
    if (entry.kind !== 'file')
      throw new TypeError('Browser captures must be regular files.');
    if (
      captures.length >= MAX_BROWSER_CAPTURES ||
      entry.size === undefined ||
      entry.size > MAX_BROWSER_CAPTURE_BYTES ||
      total + entry.size > MAX_BROWSER_TOTAL_BYTES
    ) {
      omitted++;
      continue;
    }
    const body = await state.readFile(entry.path, {
      maxBytes: MAX_BROWSER_CAPTURE_BYTES,
    });
    if (
      !(body instanceof Uint8Array) ||
      body.byteLength > MAX_BROWSER_CAPTURE_BYTES ||
      total + body.byteLength > MAX_BROWSER_TOTAL_BYTES
    ) {
      throw new TypeError('Browser capture read exceeded its declared bounds.');
    }
    const png =
      body.length >= 8 &&
      Buffer.from(body.subarray(0, 8)).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    const jpeg =
      body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255;
    if (!png && !jpeg)
      throw new TypeError(
        'Browser capture does not have a supported image signature.',
      );
    const extension = png ? 'png' : 'jpeg';
    const path = `browser/capture-${String(captures.length).padStart(3, '0')}.${extension}`;
    const mediaType = png ? 'image/png' : 'image/jpeg';
    total += body.byteLength;
    captures.push({
      path,
      source_path: entry.path,
      media_type: mediaType,
      size_bytes: body.byteLength,
      sha256: sha256Digest(body),
    });
    // Pixels can contain secrets; they are restricted and excluded from judging.
    artifacts.push({ path, body, mediaType, sensitivity: 'restricted' });
  }
  const manifest = browserManifestSchema.parse({
    run_id: input.runId,
    session_id: input.sessionId,
    ...input.plan.browser.integration,
    omitted_captures: omitted,
    captures,
  });
  artifacts.push({
    path: BROWSER_MANIFEST_PATH,
    body: Buffer.from(serializeCanonicalJson(manifest)),
    mediaType: 'application/json',
    sensitivity: 'restricted',
  });
  return artifacts;
}
