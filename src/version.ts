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
