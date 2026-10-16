import { createHash } from 'node:crypto';

import type { Sha256Digest, Sha256Hex } from './types.ts';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isSha256Hex(value: string): value is Sha256Hex {
  return SHA256_HEX.test(value);
}

export function isSha256Digest(value: string): value is Sha256Digest {
  return SHA256_DIGEST.test(value);
}

export function sha256Hex(value: string | Uint8Array): Sha256Hex {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${sha256Hex(value)}`;
}

export function prefixedSha256(value: Sha256Hex): Sha256Digest {
  return `sha256:${value}`;
}
