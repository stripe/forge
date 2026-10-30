import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { criterionJudgment } from './fixtures/criterionJudgment.ts';
import {
  createArtifactStore,
  credentialReference,
  executeEval,
  parseJudgeEvidence,
  verifyCompletedRun,
} from '../src/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../src/testing/index.ts';

const MAX_TOOL_RESULT_CODE_UNITS = 1_048_576;

it.each([
  {
    name: 'adapter output above the limit',
    secret: 'synthetic-private-token',
    content: `${'x'.repeat(MAX_TOOL_RESULT_CODE_UNITS - 45)}synthetic-private-token${'x'.repeat(100)}`,
  },
  {
    name: 'output that grows above the limit during redaction',
    secret: 'zz',
    content: 'zz'.repeat(MAX_TOOL_RESULT_CODE_UNITS / 2),
  },
])(
  'bounds $name after redaction without failing the run',
  async ({ secret, content }) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-result-bound-'),
    );
    try {
      const plan = createTestResolvedRunPlan();
      const agent = createScriptedAgentAdapter({
        requirements: {
          executables: [],
          stateDirectories: [],
          environment: {
            credentials: {
              TEST_TOKEN: { reference: credentialReference('test.key') },
            },
          },
        },
        turns: [
          {
            text: 'Done.',
            sessionId: 'selected',
            toolCalls: [
              {
                id: 'call',
                name: 'Read',
                result: { content, isError: false },
              },
            ],
          },
        ],
      });
      const completed = await executeEval({
        runId: 'bounded-result',
        plan,
        composition: {
          runtime: createFakeRuntimeAdapter().adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          credentialResolver: createStaticCredentialResolver({
            'test.key': secret,
          }),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root }),
        },
      });
      await verifyCompletedRun(completed.location);
      const audit = JSON.parse(
        await fs.readFile(
          path.join(completed.location, 'interaction.json'),
          'utf8',
        ),
      );
      const saved = audit.turns[0].tool_calls[0].result;
      assert.ok(saved.content.length <= MAX_TOOL_RESULT_CODE_UNITS);
      assert.equal(saved.truncated, true);
      assert.equal(saved.isError, false);
      assert.match(saved.content, /Forge truncated the tool result/);
      assert.match(saved.content, /\[REDACTED\]/);
      assert.equal(saved.content.includes(secret), false);
      assert.equal(saved.content.includes('synthetic-private-'), false);
      const trajectoryText = await fs.readFile(
        path.join(completed.location, 'trajectory.json'),
        'utf8',
      );
      assert.equal(trajectoryText.includes(secret), false);
      assert.equal(trajectoryText.includes('synthetic-private-'), false);
      assert.ok(
        (completed.result.evidence as { redaction_count: number })
          .redaction_count > 0,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it('commits and verifies bounded fallback results and judge evidence after redaction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-transcript-'));
  const secret = 'synthetic-private-token';
  try {
    const plan = createTestResolvedRunPlan({
      judgingCriteria: ['The observed result reports success.'],
      judge: { provider: 'test-provider', model: 'judge' },
    });
    const agent = createScriptedAgentAdapter({
      turns: [
        {
          text: `START ${'x'.repeat(900_000)} END`,
          sessionId: 'selected',
          toolCalls: [
            {
              id: 'call',
              name: 'Read',
              input: {
                query: `${'q'.repeat(3950)}${secret}${'q'.repeat(60)}${secret}${'q'.repeat(1000)}`,
              },
              result: {
                content: `${'r'.repeat(8110)}${secret}${'r'.repeat(20)}${secret}${'r'.repeat(1000)}`,
                isError: false,
              },
            },
          ],
        },
      ],
    });
    const completion = createScriptedCompletionProvider({
      requirements: {
        credentials: { token: { reference: credentialReference('test.key') } },
      },
      responses: [
        JSON.stringify(
          criterionJudgment(true, 'The retained result is visible.'),
        ),
      ],
    });
    const completed = await executeEval({
      runId: 'bounded-transcript',
      plan,
      composition: {
        runtime: createFakeRuntimeAdapter().adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        completionProviders: new Map([
          [completion.provider.id, completion.provider],
        ]),
        credentialResolver: createStaticCredentialResolver({
          'test.key': secret,
        }),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: createArtifactStore({ root }),
      },
    });
    await verifyCompletedRun(completed.location);
    const trajectoryText = await fs.readFile(
      path.join(completed.location, 'trajectory.json'),
      'utf8',
    );
    const trajectory = JSON.parse(trajectoryText);
    const step = trajectory.steps[1];
    assert.match(
      step.tool_calls[0].arguments.forge_truncated_arguments,
      /\[REDACTED\]/,
    );
    assert.match(step.observation.results[0].content, /\[REDACTED\]/);
    assert.match(step.observation.results[0].content, /Forge truncated/);
    assert.equal(step.observation.results[0].source_call_id, 'call');
    const auditText = await fs.readFile(
      path.join(completed.location, 'interaction.json'),
      'utf8',
    );
    assert.equal(
      JSON.parse(auditText).turns[0].tool_calls[0].result.isError,
      false,
    );
    for (const text of [
      trajectoryText,
      auditText,
      JSON.stringify(completion.calls.map(({ request }) => request)),
    ]) {
      assert.equal(text.includes(secret), false);
      assert.equal(text.includes('synthetic-private-'), false);
    }
    const evidence = parseJudgeEvidence(
      JSON.parse(
        await fs.readFile(
          path.join(completed.location, 'judge-evidence.json'),
          'utf8',
        ),
      ),
      { forgeVersion: plan.provenance.forge.version },
    );
    // The bounded fallback fits the whole-prompt budget, so the judge sees the
    // complete projection (verifyCompletedRun proved it equals trajectory.json).
    assert.equal(evidence.transcript.omitted, undefined);
    assert.ok(evidence.transcript.steps.length > 0);
    const judgeRequests = JSON.stringify(
      completion.calls.map(({ request }) => request),
    );
    assert.doesNotMatch(judgeRequests, /Forge truncated the judge transcript/);
    assert.match(judgeRequests, /START/);
    assert.match(judgeRequests, /END/);
    assert.ok(
      (completed.result.evidence as { redaction_count: number })
        .redaction_count >= 2,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
