import { createHash } from 'node:crypto';

export interface DockerImageBuildInput {
  readonly id: string;
  /** Trusted Dockerfile text. Forge supplies FORGE_UID as a build argument. */
  readonly dockerfile: string;
  readonly files?: Readonly<Record<string, string>>;
  /** Exact versions; configure the corresponding agent adapters to match. */
  readonly tools: Readonly<{
    claudeCode: string;
    codex: string;
    opencode: string;
  }>;
}

export interface DockerImageBuild extends DockerImageBuildInput {
  readonly sha256: `sha256:${string}`;
  readonly files: Readonly<Record<string, string>>;
}

/** Snapshot explicit host build inputs. This does not inspect or build an image. */
export function defineDockerImageBuild(
  input: DockerImageBuildInput,
): DockerImageBuild {
  const { id, dockerfile } = input;
  const suppliedFiles = input.files ?? {};
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
    throw new TypeError('Image build id must be a safe identifier.');
  if (
    typeof dockerfile !== 'string' ||
    !dockerfile.trim() ||
    dockerfile.includes('\0')
  )
    throw new TypeError('Image build requires nonempty Dockerfile text.');
  const files: Record<string, string> = {};
  for (const name of Object.keys(suppliedFiles).sort()) {
    if (
      name === 'Dockerfile' ||
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new TypeError('Image build contains an unsafe build context path.');
    const components = name.split('/');
    for (let length = 1; length < components.length; length += 1) {
      const parent = components.slice(0, length).join('/');
      if (parent === 'Dockerfile' || Object.hasOwn(suppliedFiles, parent))
        throw new TypeError('Image build context paths conflict with a file.');
    }
    const body = suppliedFiles[name];
    if (typeof body !== 'string' || body.includes('\0'))
      throw new TypeError('Image build files must be UTF-8 text.');
    Object.defineProperty(files, name, { value: body, enumerable: true });
  }
  if (
    !input.tools ||
    Object.keys(input.tools).sort().join(',') !== 'claudeCode,codex,opencode'
  )
    throw new TypeError(
      'Image build must declare all supported agent tool versions.',
    );
  const tools = {
    claudeCode: input.tools.claudeCode,
    codex: input.tools.codex,
    opencode: input.tools.opencode,
  };
  for (const version of Object.values(tools))
    if (
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
      version.length > 128
    )
      throw new TypeError('Image build tool versions must be exact releases.');
  const canonical = JSON.stringify({
    id,
    dockerfile,
    files,
    tools,
  });
  if (
    Object.keys(files).length > 128 ||
    Buffer.byteLength(canonical) > 4 * 1024 * 1024
  )
    throw new TypeError('Image build exceeds its build context bounds.');
  return Object.freeze({
    id,
    dockerfile,
    files: Object.freeze(files),
    tools: Object.freeze(tools),
    sha256: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
  });
}
