import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

import {isSafeVersion} from './model/paths.js';

const packageMetadata = createRequire(import.meta.url)('@stripe/forge/package.json') as {
  version?: unknown;
};

if (typeof packageMetadata.version !== 'string' || !isSafeVersion(packageMetadata.version)) {
  throw new TypeError('The Forge package must declare a safe version.');
}

/** Exact version of the installed package, including development snapshots. */
export const FORGE_VERSION: string = packageMetadata.version;

/** Source provenance is diagnostic; release compatibility uses version alone. */
export interface ForgeBuildIdentity {
  readonly version: string;
  readonly commit_sha?: string;
  readonly dirty?: boolean;
}

const DEVELOPMENT_VERSION = /^\d+\.\d+\.\d+-dev\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Strictly validate and snapshot a persisted Forge producer identity. */
export function parseForgeBuildIdentity(input: unknown): ForgeBuildIdentity {
  if (
    input === null ||
    typeof input !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).some((key) =>
      key !== 'version' && key !== 'commit_sha' && key !== 'dirty') ||
    !Object.hasOwn(input, 'version')
  ) {
    throw new TypeError('Forge build identity must contain version and optional commit_sha and dirty fields.');
  }
  const value = input as Record<string, unknown>;
  assertSafeVersion(value.version);
  if (Object.hasOwn(value, 'commit_sha') &&
      (typeof value.commit_sha !== 'string' || !COMMIT_SHA.test(value.commit_sha))) {
    throw new TypeError('Forge build identity commit_sha must be a full lowercase Git commit SHA.');
  }
  if (Object.hasOwn(value, 'dirty') && typeof value.dirty !== 'boolean') {
    throw new TypeError('Forge build identity dirty must be a boolean.');
  }
  return Object.freeze({
    version: value.version,
    ...(Object.hasOwn(value, 'commit_sha') ? {commit_sha: value.commit_sha as string} : {}),
    ...(Object.hasOwn(value, 'dirty') ? {dirty: value.dirty as boolean} : {}),
  });
}

/** Official releases match exactly; development snapshots use current shapes. */
export function assertCompatibleForgeVersion(producerVersion: string): void {
  assertSafeVersion(producerVersion);
  if (
    producerVersion !== FORGE_VERSION &&
    !(DEVELOPMENT_VERSION.test(producerVersion) && DEVELOPMENT_VERSION.test(FORGE_VERSION))
  ) {
    throw new TypeError(
      `Forge ${producerVersion} is incompatible with installed Forge ${FORGE_VERSION}; official releases require an exact version match.`,
    );
  }
}

/** Captured by the package build, never from the consuming process's Git checkout. */
export const FORGE_BUILD_IDENTITY: ForgeBuildIdentity = loadBuildIdentity();

function loadBuildIdentity(): ForgeBuildIdentity {
  let contents: string;
  try {
    contents = readFileSync(new URL('./build-info.json', import.meta.url), 'utf8');
  } catch (error) {
    // Source/test builds can omit metadata. The installed package still supplies
    // its release identity; an absent Git checkout adds no invented provenance.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return parseForgeBuildIdentity({version: FORGE_VERSION});
    }
    throw error;
  }
  const identity = parseForgeBuildIdentity(JSON.parse(contents));
  if (identity.version !== FORGE_VERSION) {
    throw new TypeError('Forge build metadata does not match the installed package version.');
  }
  return identity;
}

function assertSafeVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || !isSafeVersion(version)) {
    throw new TypeError('Forge build identity requires a safe version.');
  }
}
