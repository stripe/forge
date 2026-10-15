import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  OPEN_CODE_CONFIG,
  OPEN_CODE_MODEL,
} from '../../../test/support/opencode.js';
import { createMemoryWorkspace } from '../../testing/index.js';
import { readOpenCodeConfiguration } from './config.js';

const read = (extra: Record<string, unknown>) =>
  readOpenCodeConfiguration(
    createMemoryWorkspace({
      'opencode.json': JSON.stringify({ ...OPEN_CODE_CONFIG, ...extra }),
    }).readonly,
    OPEN_CODE_MODEL,
  );
describe('OpenCode authored configuration', () => {
  it('rejects auxiliary model overrides through every pinned native alias', async () => {
    for (const field of ['agent', 'agents', 'mode'])
      await assert.rejects(
        read({ [field]: { compaction: { model: 'forge/other' } } }),
        /model overrides/,
      );
  });
  it('rejects relative native references before a credentialed command can run', async () => {
    for (const extra of [
      { agent: { build: { prompt: '{file:instructions.md}' } } },
      { instructions: ['AGENTS.md'] },
      { skills: { paths: ['./skills'] } },
      { plugin: ['./plugin.ts'] },
      { plugins: [['../plugin.js', {}]] },
      { plugin: ['file:./plugin.js'] },
    ])
      await assert.rejects(read(extra), /relative config references/);
  });
  it('preserves explicit absolute references and native npm/URL configuration', async () => {
    const extra = {
      instructions: [
        '/workspace/AGENTS.md',
        'https://example.test/instructions.md',
      ],
      skills: { paths: ['/workspace/skills'] },
      agent: { build: { prompt: '{file:/workspace/prompt.md}' } },
      plugin: [
        '/workspace/plugin.ts',
        'file:///workspace/plugin2.ts',
        '@example/plugin@1.0.0',
      ],
    };
    const config = JSON.parse(await read(extra));
    for (const [key, value] of Object.entries(extra))
      assert.deepEqual(config[key], value);
  });
});
