import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, type TestContext } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

describe('documentation snippet check', () => {
  it('checks syntax without resolving imports, checking types, or executing unmarked snippets', async (context) => {
    const result = await checkMarkdown(
      context,
      [
        '```javascript',
        "import { example } from 'example-package';",
        "throw new Error('not marked for execution');",
        '```',
        '```typescript',
        'const value: number = "syntax only";',
        '```',
        '```ts fragment',
        'const incomplete =',
        '```',
      ].join('\n'),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /checked 3 files and 2 structured snippets/);
  });

  it.for(['js', 'ts'])(
    'rejects malformed %s snippets',
    async (language, context) => {
      const result = await checkMarkdown(
        context,
        ['# Example', `\`\`\`${language}`, 'const value = ;', '```'].join('\n'),
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        new RegExp(`docs: README.md:2: invalid ${language} snippet:`),
      );
      assert.equal(result.stdout, '');
    },
  );

  it('reports execution failures for snippets marked check', async (context) => {
    const result = await checkMarkdown(
      context,
      ['```js check', "throw new Error('example failed');", '```'].join('\n'),
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /executable snippet failed before line 3:/);
    assert.match(result.stderr, /example failed/);
  });
});

async function checkMarkdown(context: TestContext, markdown: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-docs-check-'));
  context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.symlink(
    path.join(repositoryRoot, 'node_modules'),
    path.join(root, 'node_modules'),
    'junction',
  );
  await fs.copyFile(
    path.join(repositoryRoot, 'scripts', 'check-docs.mjs'),
    path.join(root, 'scripts', 'check-docs.mjs'),
  );
  await fs.writeFile(path.join(root, 'README.md'), markdown);
  await fs.writeFile(path.join(root, 'AGENTS.md'), '');
  await fs.writeFile(
    path.join(root, 'docs', 'architecture.md'),
    '## Public entry points\n\n`@stripe/forge`\n',
  );
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@stripe/forge',
      exports: { '.': './dist/index.js' },
      files: ['README.md', 'docs'],
    }),
  );
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'check-docs.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}
