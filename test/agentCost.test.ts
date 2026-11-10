import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'vitest';
import { parseClaudeStream } from '../src/agents/claude-code/stream.ts';
import { parseCodexStream } from '../src/agents/codex/stream.ts';
import { parseOpenCodeStream } from '../src/agents/opencode/stream.ts';
import { executeEval } from '../src/execution/execute.ts';
import { agentPricingVersion } from '../src/pricing/index.ts';
import {
  createArtifactStore,
  verifyCompletedRun,
} from '../src/results/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../src/testing/index.ts';
import { openCodeEvents } from './support/opencode.ts';

const native = JSON.parse(
  readFileSync(
    new URL('./fixtures/agent-usage/native.json', import.meta.url),
    'utf8',
  ),
);
const encode = (events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join('\n');
const events = openCodeEvents({
  prompt: 'Complete the test task.',
  response: 'Done.',
});
for (const event of events)
  if (event.type === 'step_finish') event.part.tokens = native.opencode;
const turns = [
  {
    adapter: 'codex',
    provider: 'openai',
    model: 'gpt-6.1-sol',
    expected: 0.1376256,
    turn: parseCodexStream(
      encode([
        {
          type: 'thread.started',
          thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53',
        },
        { type: 'turn.started' },
        { type: 'turn.completed', usage: native.codex },
      ]),
    ),
  },
  {
    adapter: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    expected: 0.31722,
    turn: parseClaudeStream(
      JSON.stringify({
        type: 'result',
        session_id: 'usage-cost',
        result: 'Done.',
        usage: native.claude,
      }),
    ),
  },
  {
    adapter: 'opencode',
    provider: 'openai-compatible',
    model: 'openrouter-gemini-4-argon',
    expected: 0.307088,
    turn: parseOpenCodeStream(encode(events)),
  },
];
for (const { turn, expected, ...selection } of turns) {
  it(`commits and independently verifies ${selection.adapter} usage and estimated cost`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-agent-cost-'));
    try {
      // An independent synthetic reported cost proves the estimate never overwrites it.
      const agent = createScriptedAgentAdapter({
        id: selection.adapter,
        turns: [{ ...turn, costUsd: 99 }],
      });
      const completed = await executeEval({
        runId: 'cost-fixture',
        plan: createTestResolvedRunPlan({ agent: selection }),
        composition: {
          runtime: createFakeRuntimeAdapter().adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          credentialResolver: createStaticCredentialResolver(),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root }),
        },
      });
      const verified = await verifyCompletedRun(completed.location);
      const estimate = verified.result.agent.estimated_cost_usd;
      assert.ok(estimate != null && Math.abs(estimate - expected) < 1e-12);
      assert.equal(verified.result.agent.pricing_version, agentPricingVersion);
      assert.equal(verified.result.agent.cost_usd, 99);
      assert.deepEqual(verified.result.agent.usage, turn.usage);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
