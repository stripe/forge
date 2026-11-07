import { createHash } from 'node:crypto';

/** Trusted host code, not a YAML import or a Dockerfile discovered on disk. */
export interface DockerImageExtensionInput {
  readonly id: string;
  /** Start with ARG FORGE_BASE_IMAGE and FROM ${FORGE_BASE_IMAGE}. */
  readonly dockerfile: string;
  /** UTF-8 build context files; no host paths, credentials, or symlinks. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface DockerImageExtension {
  readonly id: string;
  readonly sha256: `sha256:${string}`;
  readonly dockerfile: string;
  readonly files: Readonly<Record<string, string>>;
}

/** Clone, validate, hash, and freeze an explicit extension before host work. */
export function defineDockerImageExtension(
  input: DockerImageExtensionInput,
): DockerImageExtension {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.id))
    throw new TypeError('Image extension id must be a safe identifier.');
  if (
    typeof input.dockerfile !== 'string' ||
    !/^ARG FORGE_BASE_IMAGE\r?\nFROM \$\{FORGE_BASE_IMAGE\}(?:\r?\n|$)/.test(
      input.dockerfile,
    ) ||
    (input.dockerfile
      .replace(/^[ \t]*(?:#.*)?\r?\n/gm, '')
      .replace(/\\[ \t]*\r?\n/g, '')
      .match(/^[ \t]*FROM\s/gim)?.length ?? 0) !== 1
  )
    throw new TypeError('Image extension must derive from FORGE_BASE_IMAGE.');
  const files: Record<string, string> = {};
  for (const name of Object.keys(input.files ?? {}).sort()) {
    if (
      name === 'Dockerfile' ||
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new TypeError(
        'Image extension contains an unsafe build context path.',
      );
    const body = input.files![name];
    if (typeof body !== 'string' || body.includes('\0'))
      throw new TypeError('Image extension files must be UTF-8 text.');
    Object.defineProperty(files, name, { value: body, enumerable: true });
  }
  const canonical = JSON.stringify({
    id: input.id,
    dockerfile: input.dockerfile,
    files,
  });
  if (
    Object.keys(files).length > 128 ||
    Buffer.byteLength(canonical) > 4 * 1024 * 1024
  )
    throw new TypeError('Image extension exceeds its build context bounds.');
  return Object.freeze({
    id: input.id,
    sha256: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    dockerfile: input.dockerfile,
    files: Object.freeze(files),
  });
}
