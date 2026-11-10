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

it.each([
  { nativeOverflow: false, driverOverflow: false },
  { nativeOverflow: true, driverOverflow: false },
  { nativeOverflow: false, driverOverflow: true },
  { nativeOverflow: true, driverOverflow: true },
])(
  'retains bounded results through judge fallback (native overflow=$nativeOverflow, driver overflow=$driverOverflow)',
  async ({ nativeOverflow, driverOverflow }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-transcript-'));
    const secret = 'synthetic-private-token';
    try {
      const plan = createTestResolvedRunPlan({
        judgingCriteria: ['The observed result reports success.'],
        judge: { provider: 'test-provider', model: 'judge' },
      });
      const assistant = `START ${'x'.repeat(driverOverflow ? 1_100_000 : 900_000)} END`;
      const agent = createScriptedAgentAdapter({
        ...(nativeOverflow
          ? {
              evidence: {
                kind: 'available' as const,
                source: {
                  kind: 'atif' as const,
                  format: 'atif' as const,
                  schemaVersion: 'ATIF-v1.8',
                  sessionId: 'selected',
                },
                trajectory: {
                  schema_version: 'ATIF-v1.8' as const,
                  session_id: 'selected',
                  agent: { name: 'test-agent', version: '1' },
                  steps: [
                    {
                      step_id: 1,
                      source: 'user' as const,
                      message: plan.interaction.effective_prompt,
                    },
                    {
                      step_id: 2,
                      source: 'agent' as const,
                      message: 'n'.repeat(1_100_000),
                    },
                  ],
                },
                warnings: [],
              },
            }
          : {}),
        turns: [
          {
            text: assistant,
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
          credentials: {
            token: { reference: credentialReference('test.key') },
          },
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
      assert.equal(evidence.transcript.warnings, undefined);
      const prompt = completion.calls[0]?.request.systemPrompt ?? '';
      assert.equal(step.message, assistant);
      if (driverOverflow) {
        assert.equal(evidence.transcript.omitted, 'judge_budget_exceeded');
        assert.deepEqual(evidence.transcript.steps, []);
        assert.ok(!prompt.includes('x'.repeat(100)));
      } else {
        assert.equal(evidence.transcript.omitted, undefined);
        assert.equal(evidence.transcript.steps.length, 2);
        const judgeStep = evidence.transcript.steps[1];
        assert.ok(judgeStep?.source === 'agent');
        assert.equal(judgeStep.message, assistant);
        assert.deepEqual(judgeStep.tool_calls, step.tool_calls);
        assert.equal(
          judgeStep.observation?.results[0]?.content,
          step.observation.results[0].content,
        );
        assert.equal(judgeStep.observation?.results[0]?.is_error, false);
        assert.ok(prompt.includes('x'.repeat(900_000)));
      }
      assert.ok(!prompt.includes('n'.repeat(100)));
      assert.ok(Buffer.byteLength(prompt, 'utf8') < 1_048_576);
      assert.equal(completed.result.evidence.completeness, 'fallback');
      assert.equal(
        completed.result.evidence.provenance.source.kind,
        'driver_fallback',
      );
      assert.equal(
        completed.result.evidence.warnings.some(({ message }) =>
          /Native evidence exceeded the judge budget/.test(message),
        ),
        nativeOverflow,
      );
      assert.equal(completed.result.evidence.redaction_count, 4);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
