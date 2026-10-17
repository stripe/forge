import path from 'node:path';

const MAX_PORTABLE_PATH_BYTES = 4096;
const MAX_PATH_SEGMENT_BYTES = 255;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

export function isSafeDatasetRelativePath(value: string): boolean {
  return isCanonicalRelativePosixPath(value, false);
}

export function isSafeCaseId(value: string): boolean {
  return isCanonicalRelativePosixPath(value, false);
}

/** Authored identities use lowercase, slash-separated kebab-case segments. */
export function isAuthoredCaseId(value: string): boolean {
  return (
    isSafeCaseId(value) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(value)
  );
}

/** Dataset case definitions have a recognizable name below cases/. */
export function isCaseDefinitionPath(value: string): boolean {
  if (!isSafeDatasetRelativePath(value) || !value.startsWith('cases/'))
    return false;
  const filename = path.posix.basename(value);
  return (
    filename === 'case.yaml' ||
    (filename.endsWith('.case.yaml') && filename.length > '.case.yaml'.length)
  );
}

export function isSafeWorkspaceRelativePath(
  value: string,
  options: { allowRoot?: boolean } = {},
): boolean {
  if (options.allowRoot === true && value === '.') return true;
  return isCanonicalRelativePosixPath(value, false);
}

export function isSafeActionIdentifier(value: string): boolean {
  if (value.length > 384 || CONTROL_CHARACTER.test(value)) return false;
  const match = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/.exec(value);
  if (!match) return false;
  return isSafeSimpleIdentifier(match[1]!) && isSafeSimpleIdentifier(match[2]!);
}

export function isSafeSimpleIdentifier(value: string): boolean {
  return (
    value.length <= 128 &&
    /^[a-z0-9][a-z0-9._-]*$/.test(value) &&
    !CONTROL_CHARACTER.test(value)
  );
}

export function isSafeVersion(value: string): boolean {
  return (
    value.length <= 128 &&
    /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(value) &&
    !CONTROL_CHARACTER.test(value)
  );
}

export type MarketplaceRef = string;

/** A moving branch or tag, never a pinned commit or CLI option. */
export function isSafeMarketplaceRef(value: string): value is MarketplaceRef {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith('-') &&
    value !== '@' &&
    !/[\s\u0000-\u001f\u007f#\\*?[\]^~:]/.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    value
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          !part.startsWith('.') &&
          !part.endsWith('.') &&
          !part.endsWith('.lock'),
      ) &&
    !/^[a-fA-F0-9]{40}$/.test(value)
  );
}

export function isValidMarketplaceRefValue(
  value: unknown,
): value is MarketplaceRef {
  return typeof value === 'string' && isSafeMarketplaceRef(value);
}

export function isSafeGitHubRepository(value: string): boolean {
  if (value.length > 512 || CONTROL_CHARACTER.test(value)) return false;
  const match =
    /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/.exec(
      value,
    );
  return match !== null && !match[2]!.toLowerCase().endsWith('.git');
}

export function isSafeMetadata(value: string, maxBytes = 1024): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isCanonicalRelativePosixPath(
  value: string,
  allowRoot: boolean,
): boolean {
  if (allowRoot && value === '.') return true;
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PORTABLE_PATH_BYTES ||
    CONTROL_CHARACTER.test(value) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    WINDOWS_DRIVE.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    return false;
  }

  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      Buffer.byteLength(segment, 'utf8') <= MAX_PATH_SEGMENT_BYTES,
  );
}
