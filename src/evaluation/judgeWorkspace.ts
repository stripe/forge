import {
  type ReadonlyWorkspace,
  type WorkspaceEntry,
  WorkspaceEntryLimitError,
} from '../contracts/runtime.ts';
export const MAX_JUDGE_WORKSPACE_ENTRIES = 10_000;
export const MAX_JUDGE_WORKSPACE_DEPTH = 32;
export const MAX_JUDGE_WORKSPACE_COLLECTION_MS = 2_000;
export const MAX_JUDGE_WORKSPACE_READ_BYTES = 512_000;
export const MAX_JUDGE_WORKSPACE_FILE_CHARACTERS = 20_000;
export const MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS = 80_000;

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.claude',
  '.agents',
  '.codex',
  '.cursor',
  '.venv',
  'venv',
  'node_modules',
  'vendor',
  '__pycache__',
  '.cache',
  '.mypy_cache',
  '.next',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  'dist',
  'build',
  'coverage',
  'out',
  'target',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.pdf',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.sqlite-shm',
  '.sqlite-wal',
  '.tar',
  '.gz',
  '.tgz',
  '.zip',
  '.bz2',
  '.xz',
  '.zst',
  '.7z',
  '.rar',
  '.pyc',
  '.wasm',
  '.exe',
  '.so',
  '.dll',
]);

const SKIP_FILE_NAMES = new Set([
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
]);

const WORKSPACE_SECTION_PREFIX = '\n## Workspace Files\n\n';

export type JudgeWorkspaceWarningCode =
  | 'workspace_binary_omitted'
  | 'workspace_depth_limit_reached'
  | 'workspace_entry_limit_reached'
  | 'workspace_file_truncated'
  | 'workspace_listing_unavailable'
  | 'workspace_output_limit_reached'
  | 'workspace_read_limit_reached'
  | 'workspace_read_unavailable'
  | 'workspace_time_limit_reached';

export interface JudgeWorkspaceWarningV1 {
  readonly code: JudgeWorkspaceWarningCode;
  readonly message: string;
  readonly path?: string;
}

export interface JudgeWorkspaceEvidenceEntryV1 {
  readonly path: string;
  /** Size reported by the sealed workspace, or the bytes read when absent. */
  readonly size_bytes: number;
  readonly bytes_read: number;
  /** Exact text made available to the judge for this entry. */
  readonly content: string;
  readonly truncated: boolean;
}

/** JSON-safe evidence which can be persisted beside the judge result. */
export interface JudgeWorkspaceEvidenceV1 {
  readonly entries: readonly JudgeWorkspaceEvidenceEntryV1[];
  /** False when any warning or bound leaves evidence incomplete. */
  readonly complete: boolean;
  /** Any collection or rendering bound was hit, including per-file text limits. */
  readonly truncated: boolean;
  readonly bytes_read: number;
  readonly warnings: readonly JudgeWorkspaceWarningV1[];
}

export interface CollectedJudgeWorkspaceEvidence {
  readonly evidence: JudgeWorkspaceEvidenceV1;
  /** Exact prompt fragment rendered from evidence.entries and warnings. */
  readonly renderedText: string;
}

export interface JudgeWorkspaceCollectionOptions {
  /** A caller may tighten, but never loosen, the hard collection limits. */
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly maxDurationMs?: number;
  readonly maxReadBytes?: number;
  readonly maxCharactersPerFile?: number;
  readonly maxTotalCharacters?: number;
  readonly signal?: AbortSignal;
}

interface ResolvedLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxDurationMs: number;
  readonly maxReadBytes: number;
  readonly maxCharactersPerFile: number;
  readonly maxTotalCharacters: number;
}

class CollectionStop extends Error {
  constructor(
    readonly code: Exclude<
      JudgeWorkspaceWarningCode,
      | 'workspace_file_truncated'
      | 'workspace_binary_omitted'
      | 'workspace_listing_unavailable'
      | 'workspace_read_unavailable'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'CollectionStop';
  }
}

/**
 * Collect bounded judge evidence from a runtime which has already quiesced.
 * ReadonlyWorkspace owns safe traversal; this layer additionally excludes
 * noisy paths and binds the exact text sent to the completion provider.
 */
export async function collectJudgeWorkspaceEvidence(
  workspace: ReadonlyWorkspace,
  options: JudgeWorkspaceCollectionOptions = {},
): Promise<CollectedJudgeWorkspaceEvidence> {
  const limits = resolveLimits(options);
  const deadline = Date.now() + limits.maxDurationMs;
  const entries: JudgeWorkspaceEvidenceEntryV1[] = [];
  const warnings: JudgeWorkspaceWarningV1[] = [];
  let bytesRead = 0;
  let renderedCharacters = 0;
  let truncated = false;

  const stop = (reason: CollectionStop): void => {
    truncated = true;
    warnings.push({ code: reason.code, message: reason.message });
  };

  if (limits.maxDurationMs === 0) {
    stop(timeLimit(limits.maxDurationMs));
    return collected(
      entries,
      warnings,
      bytesRead,
      truncated,
      limits.maxTotalCharacters,
    );
  }
  if (limits.maxEntries === 0) {
    stop(entryLimit(limits.maxEntries));
    return collected(
      entries,
      warnings,
      bytesRead,
      truncated,
      limits.maxTotalCharacters,
    );
  }

  options.signal?.throwIfAborted();
  let listed: readonly WorkspaceEntry[];
  try {
    listed = await withinDeadline(
      workspace.listFiles({
        under: '.',
        maxEntries: limits.maxEntries,
        excludeDirectoryNames: Object.freeze([...SKIP_DIRECTORIES]),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      deadline,
      limits.maxDurationMs,
      options.signal,
    );
  } catch (error) {
    if (isCallerAbort(options.signal)) throw abortReason(options.signal);
    if (error instanceof WorkspaceEntryLimitError) {
      listed = error.entries;
      stop(entryLimit(Math.min(error.maxEntries, limits.maxEntries)));
    } else {
      if (error instanceof CollectionStop) {
        stop(error);
      } else if (isLimitError(error)) {
        stop(entryLimit(limits.maxEntries));
        warnings.push({
          code: 'workspace_listing_unavailable',
          message:
            'The runtime supplied no partial listing after reporting an entry limit; workspace text is unavailable.',
        });
      } else {
        warnings.push({
          code: 'workspace_listing_unavailable',
          message: 'The sealed workspace could not be listed safely.',
        });
      }
      return collected(
        entries,
        warnings,
        bytesRead,
        truncated,
        limits.maxTotalCharacters,
      );
    }
  }

  const ordered = [...listed].sort((left, right) =>
    compareCodeUnits(left.path, right.path),
  );
  if (ordered.length > limits.maxEntries) {
    stop(entryLimit(limits.maxEntries));
    ordered.length = limits.maxEntries;
  }
  const symlinkRoots = ordered
    .filter(({ kind }) => kind === 'symlink')
    .map(({ path }) => path);

  for (const entry of ordered) {
    options.signal?.throwIfAborted();
    try {
      assertBeforeDeadline(deadline, limits.maxDurationMs);
      if (!isEligibleFile(entry, symlinkRoots)) continue;

      if (BINARY_EXTENSIONS.has(extension(entry.path))) {
        warnings.push(binaryOmission(entry, 'binary filename format'));
        continue;
      }

      const depth = entry.path.split('/').length - 1;
      if (depth > limits.maxDepth) {
        throw new CollectionStop(
          'workspace_depth_limit_reached',
          `Workspace depth limit of ${limits.maxDepth} reached.`,
        );
      }

      const remainingReadBytes = limits.maxReadBytes - bytesRead;
      if (
        remainingReadBytes <= 0 ||
        (entry.size !== undefined && entry.size > remainingReadBytes)
      ) {
        throw readLimit(limits.maxReadBytes);
      }

      let body: Uint8Array;
      try {
        body = await withinDeadline(
          workspace.readFile(entry.path, { maxBytes: remainingReadBytes }),
          deadline,
          limits.maxDurationMs,
          options.signal,
        );
      } catch (error) {
        if (isCallerAbort(options.signal)) throw abortReason(options.signal);
        if (error instanceof CollectionStop) throw error;
        if (isLimitError(error)) throw readLimit(limits.maxReadBytes);
        warnings.push({
          code: 'workspace_read_unavailable',
          message: 'A sealed workspace file could not be read safely.',
          path: entry.path,
        });
        continue;
      }
      if (body.byteLength > remainingReadBytes) {
        throw readLimit(limits.maxReadBytes);
      }
      bytesRead += body.byteLength;

      const decoded = decodeWorkspaceText(body);
      if (decoded === null) {
        warnings.push(binaryOmission(entry, 'non-text bytes', body.byteLength));
        continue;
      }
      const content = decoded.slice(0, limits.maxCharactersPerFile);
      const fileTruncated = content.length < decoded.length;
      const evidenceEntry: JudgeWorkspaceEvidenceEntryV1 = {
        path: entry.path,
        size_bytes: entry.size ?? body.byteLength,
        bytes_read: body.byteLength,
        content,
        truncated: fileTruncated,
      };
      const chunk = renderEntry(evidenceEntry);
      if (renderedCharacters + chunk.length > limits.maxTotalCharacters) {
        throw new CollectionStop(
          'workspace_output_limit_reached',
          `Workspace output limit of ${limits.maxTotalCharacters} characters reached.`,
        );
      }
      entries.push(Object.freeze(evidenceEntry));
      renderedCharacters += chunk.length;
      if (fileTruncated) {
        truncated = true;
        warnings.push({
          code: 'workspace_file_truncated',
          message: `Workspace file text was truncated to ${limits.maxCharactersPerFile} characters.`,
          path: entry.path,
        });
      }
    } catch (error) {
      if (isCallerAbort(options.signal)) throw abortReason(options.signal);
      if (error instanceof CollectionStop) {
        stop(error);
        break;
      }
      throw error;
    }
  }

  return collected(
    entries,
    warnings,
    bytesRead,
    truncated,
    limits.maxTotalCharacters,
  );
}

function collected(
  entries: readonly JudgeWorkspaceEvidenceEntryV1[],
  warnings: readonly JudgeWorkspaceWarningV1[],
  bytesRead: number,
  truncated: boolean,
  maxTotalCharacters = MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS,
): CollectedJudgeWorkspaceEvidence {
  const unboundedEvidence: JudgeWorkspaceEvidenceV1 = Object.freeze({
    entries: Object.freeze([...entries]),
    complete: warnings.length === 0,
    truncated,
    bytes_read: bytesRead,
    warnings: Object.freeze([...warnings]),
  });
  const evidence = boundJudgeWorkspaceEvidence(
    unboundedEvidence,
    maxTotalCharacters,
  );
  return Object.freeze({
    evidence,
    renderedText: renderJudgeWorkspaceEvidence(evidence),
  });
}

/**
 * Rebound evidence after transformations such as credential redaction.
 * The returned audit object renders to at most the requested hard limit and
 * records an output-limit warning whenever one fits. For a caller-tightened
 * limit too small even for that warning, `complete: false` and `truncated:
 * true` remain the explicit cutoff signal while the rendered section is empty.
 *
 * This is intentionally an internal module export rather than a package-root
 * API. Execution uses it after redaction so the audited text and the exact text
 * sent to a completion provider remain identical.
 */
export function boundJudgeWorkspaceEvidence(
  evidence: JudgeWorkspaceEvidenceV1,
  maxTotalCharacters = MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS,
): JudgeWorkspaceEvidenceV1 {
  const limit = tightened(
    maxTotalCharacters,
    MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS,
  );
  const normalizedEntries: JudgeWorkspaceEvidenceEntryV1[] = [];
  const normalizationWarnings: JudgeWorkspaceWarningV1[] = [];
  const alreadyTruncatedPaths = new Set(
    evidence.warnings.flatMap((warning) =>
      warning.code === 'workspace_file_truncated' && warning.path !== undefined
        ? [warning.path]
        : [],
    ),
  );
  let contentWasTruncated = false;
  for (const entry of evidence.entries) {
    if (entry.content.length <= MAX_JUDGE_WORKSPACE_FILE_CHARACTERS) {
      normalizedEntries.push(entry);
      continue;
    }
    contentWasTruncated = true;
    normalizedEntries.push(
      Object.freeze({
        ...entry,
        content: entry.content.slice(0, MAX_JUDGE_WORKSPACE_FILE_CHARACTERS),
        truncated: true,
      }),
    );
    if (!alreadyTruncatedPaths.has(entry.path)) {
      normalizationWarnings.push(
        Object.freeze({
          code: 'workspace_file_truncated' as const,
          message: `Workspace file text was truncated to ${MAX_JUDGE_WORKSPACE_FILE_CHARACTERS} characters.`,
          path: entry.path,
        }),
      );
    }
  }
  const normalizedWarnings = [...evidence.warnings, ...normalizationWarnings];
  const normalized = freezeEvidence({
    ...evidence,
    entries: normalizedEntries,
    warnings: normalizedWarnings,
    complete: evidence.complete && !contentWasTruncated,
    truncated: evidence.truncated || contentWasTruncated,
  });
  if (renderedEvidenceLength(normalized) <= limit) return normalized;

  const outputWarning: JudgeWorkspaceWarningV1 = Object.freeze({
    code: 'workspace_output_limit_reached',
    message: `Workspace output limit of ${limit} characters reached.`,
  });
  const retainedWarnings: JudgeWorkspaceWarningV1[] = [];
  const retainedEntries: JudgeWorkspaceEvidenceEntryV1[] = [];
  let retainedLength =
    WORKSPACE_SECTION_PREFIX.length + renderWarning(outputWarning).length;
  if (retainedLength > limit) {
    return freezeEvidence({
      ...normalized,
      entries: [],
      warnings: [],
      complete: false,
      truncated: true,
    });
  }

  // Preserve explicit collection warnings first. They explain missing or
  // partial evidence and stay audit-visible even when file contents compete
  // for the remaining prompt budget.
  for (const warning of normalized.warnings) {
    if (warning.code === 'workspace_output_limit_reached') continue;
    const addedLength = 1 + renderWarning(warning).length;
    if (retainedLength + addedLength > limit) break;
    retainedWarnings.push(warning);
    retainedLength += addedLength;
  }
  for (const entry of normalized.entries) {
    const addedLength = 1 + renderEntry(entry).length;
    if (retainedLength + addedLength > limit) break;
    retainedEntries.push(entry);
    retainedLength += addedLength;
  }

  return freezeEvidence({
    ...normalized,
    entries: retainedEntries,
    warnings: [...retainedWarnings, outputWarning],
    complete: false,
    truncated: true,
  });
}

/** Warning fields the renderer reads; the code selects "omitted" or "truncated". */
type RenderedJudgeWorkspaceWarning = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

/**
 * Render the exact bounded evidence fragment supplied to the judge. Only entry
 * paths and contents and warnings are read, so the saved judge-evidence.json
 * workspace section reproduces the rendered text.
 */
export function renderJudgeWorkspaceEvidence(evidence: {
  readonly entries: readonly Pick<
    JudgeWorkspaceEvidenceEntryV1,
    'path' | 'content'
  >[];
  readonly warnings: readonly RenderedJudgeWorkspaceWarning[];
}): string {
  if (evidence.entries.length === 0 && evidence.warnings.length === 0)
    return '';
  return `${WORKSPACE_SECTION_PREFIX}${[
    ...evidence.entries.map(renderEntry),
    ...evidence.warnings.map(renderWarning),
  ].join('\n')}`;
}

function renderEntry(
  entry: Pick<JudgeWorkspaceEvidenceEntryV1, 'path' | 'content'>,
): string {
  const longestRun = Math.max(
    0,
    ...[...entry.content.matchAll(/`+/g)].map(([run]) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `### ${entry.path}\n${fence}\n${entry.content}\n${fence}\n`;
}

function renderWarning(warning: RenderedJudgeWorkspaceWarning): string {
  const disposition =
    warning.code === 'workspace_binary_omitted' ? 'omitted' : 'truncated';
  return `(${disposition} — ${
    warning.path === undefined
      ? warning.message
      : `${warning.path}: ${warning.message}`
  })`;
}

function renderedEvidenceLength(evidence: {
  readonly entries: readonly Pick<
    JudgeWorkspaceEvidenceEntryV1,
    'path' | 'content'
  >[];
  readonly warnings: readonly RenderedJudgeWorkspaceWarning[];
}): number {
  const fragments = [
    ...evidence.entries.map(renderEntry),
    ...evidence.warnings.map(renderWarning),
  ];
  if (fragments.length === 0) return 0;
  return (
    WORKSPACE_SECTION_PREFIX.length +
    fragments.reduce((total, fragment) => total + fragment.length, 0) +
    fragments.length -
    1
  );
}

function freezeEvidence(
  evidence: JudgeWorkspaceEvidenceV1,
): JudgeWorkspaceEvidenceV1 {
  return Object.freeze({
    ...evidence,
    entries: Object.freeze([...evidence.entries]),
    warnings: Object.freeze([...evidence.warnings]),
  });
}

function isEligibleFile(
  entry: WorkspaceEntry,
  symlinkRoots: readonly string[],
): boolean {
  if (entry.kind !== 'file') return false;
  const segments = entry.path.split('/');
  if (segments.some((segment) => SKIP_DIRECTORIES.has(segment))) return false;
  if (
    symlinkRoots.some(
      (root) => entry.path === root || entry.path.startsWith(`${root}/`),
    )
  ) {
    return false;
  }
  const fileName = segments.at(-1)?.toLowerCase() ?? '';
  return !SKIP_FILE_NAMES.has(fileName) && extension(entry.path) !== '.lock';
}

/** Reject binary bytes rather than replacing or stripping them in judge evidence. */
function decodeWorkspaceText(body: Uint8Array): string | null {
  if (
    body.some(
      (byte) =>
        byte < 9 ||
        (byte > 10 && byte < 13) ||
        (byte > 13 && byte < 32) ||
        byte === 127,
    )
  )
    return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      body,
    );
  } catch {
    return null;
  }
}

function binaryOmission(
  entry: WorkspaceEntry,
  reason: string,
  bytesRead?: number,
): JudgeWorkspaceWarningV1 {
  const size = entry.size ?? bytesRead;
  return {
    code: 'workspace_binary_omitted',
    path: entry.path,
    message: `Binary workspace file omitted (${reason}${size === undefined ? '' : `; ${size} bytes`}). Its contents were not judged.`,
  };
}

function extension(relativePath: string): string {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

function resolveLimits(
  options: JudgeWorkspaceCollectionOptions,
): ResolvedLimits {
  return {
    maxEntries: tightened(options.maxEntries, MAX_JUDGE_WORKSPACE_ENTRIES),
    maxDepth: tightened(options.maxDepth, MAX_JUDGE_WORKSPACE_DEPTH),
    maxDurationMs: tightened(
      options.maxDurationMs,
      MAX_JUDGE_WORKSPACE_COLLECTION_MS,
    ),
    maxReadBytes: tightened(
      options.maxReadBytes,
      MAX_JUDGE_WORKSPACE_READ_BYTES,
    ),
    maxCharactersPerFile: tightened(
      options.maxCharactersPerFile,
      MAX_JUDGE_WORKSPACE_FILE_CHARACTERS,
    ),
    maxTotalCharacters: tightened(
      options.maxTotalCharacters,
      MAX_JUDGE_WORKSPACE_TOTAL_CHARACTERS,
    ),
  };
}

function tightened(requested: number | undefined, hardLimit: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return hardLimit;
  return Math.min(hardLimit, Math.max(0, Math.floor(requested)));
}

function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  durationMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  signal?.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timeLimit(durationMs));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(timeLimit(durationMs))),
      remaining,
    );
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal?.aborted) onAbort();
  });
}

function assertBeforeDeadline(deadline: number, durationMs: number): void {
  if (Date.now() >= deadline) throw timeLimit(durationMs);
}

function entryLimit(limit: number): CollectionStop {
  return new CollectionStop(
    'workspace_entry_limit_reached',
    `Workspace listing was truncated at the entry limit of ${limit}; only files reached before the cutoff were considered.`,
  );
}

function readLimit(limit: number): CollectionStop {
  return new CollectionStop(
    'workspace_read_limit_reached',
    `Workspace read limit of ${limit} bytes reached.`,
  );
}

function timeLimit(limit: number): CollectionStop {
  return new CollectionStop(
    'workspace_time_limit_reached',
    `Workspace collection time limit of ${limit}ms reached.`,
  );
}

function isLimitError(error: unknown): boolean {
  return error instanceof Error && /exceed|limit/i.test(error.message);
}

function isCallerAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason ??
    new DOMException('The operation was aborted.', 'AbortError')
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
