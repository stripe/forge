import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
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

it('commits and verifies bounded fallback results and oversized judge evidence after redaction', async () => {
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
        JSON.stringify({
          results: [
            {
              index: 0,
              passed: true,
              explanation: 'The retained result is visible.',
            },
          ],
        }),
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
    assert.equal(
      evidence.transcript.warnings?.[0]?.code,
      'transcript_truncated',
    );
    assert.equal(evidence.transcript.steps[0]?.source, 'omission');
    assert.match(
      JSON.stringify(completion.calls.map(({ request }) => request)),
      /Forge truncated the judge transcript/,
    );
    const { warnings: _, ...withoutWarning } = evidence.transcript;
    assert.throws(() =>
      parseJudgeEvidence(
        { ...evidence, transcript: withoutWarning },
        { forgeVersion: plan.provenance.forge.version },
      ),
    );
    assert.ok(
      (completed.result.evidence as { redaction_count: number })
        .redaction_count >= 2,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
