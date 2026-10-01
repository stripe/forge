import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {describe, it} from 'node:test';

import {FORGE_VERSION} from './version.js';

describe('Forge package version', () => {
  it('uses the version of the current package', () => {
    const metadata = createRequire(import.meta.url)('@stripe/forge/package.json') as {
      version: string;
    };
    assert.equal(FORGE_VERSION, metadata.version);
  });
});
