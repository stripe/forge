import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import {
  createOpenCodeAdapter,
  OPENCODE_STATE_ID,
} from '../src/agents/opencode/index.ts';
import { parseAtifTrajectory } from '../src/atif/index.ts';
import { EMPTY_JUDGE_TRANSCRIPT } from '../src/evaluation/judgeTranscript.ts';
import { renderRecordedJudgeWorkspaceEvidence } from '../src/evaluation/judgeWorkspace.ts';
import {
  buildCriterionJudgePrompt,
  createArtifactStore,
  createJudgeTranscriptProjection,
  executeEval,
  type JudgeEvidenceV1,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
  parseResolvedRunPlan,
  verifyCompletedRun,
} from '../src/index.ts';
import { serializeCanonicalJson } from '../src/serialization.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../src/testing/index.ts';
import {
  OPEN_CODE_MODEL,
  OPEN_CODE_MODEL_PROFILE,
  OPEN_CODE_SESSION,
  openCodeEvents,
  openCodeExport,
} from './support/opencode.ts';

const SECRET = 'test-opencode-judge-budget-secret';
const TASK = 'Create answer.ts.';
const CRITERIA = ['The code works.', 'The code is complete. 界🙂'];
const EXAMPLE = '界'.repeat(10_000);
const SUCCESS = JSON.stringify({
  results: [{ index: 0, passed: true, explanation: 'Synthetic judgment.' }],
});

describe('OpenCode whole-prompt judge budget integration', () => {
  for (const scenario of [
    {
      name: 'keeps small native evidence',
      capture: 'complete',
      toolOutput: 100,
      largeWorkspace: true,
      largeReply: false,
      selection: 'native',
    },
    {
      name: 'keeps native evidence above the former transcript cap when the whole prompt fits',
      capture: 'complete',
      toolOutput: 840_000,
      largeWorkspace: false,
      largeReply: false,
      selection: 'native',
    },
    {
      name: 'uses driver turns when native results plus workspace exceed the whole prompt budget',
      capture: 'complete',
      toolOutput: 840_000,
      largeWorkspace: true,
      largeReply: false,
      selection: 'driver',
    },
    {
      name: 'grades code only when both native and driver projections exceed the budget',
      capture: 'complete',
      toolOutput: 100,
      largeWorkspace: true,
      largeReply: true,
      selection: 'omitted',
    },
    {
      name: 'budgets driver turns after an export fails',
      capture: 'failed',
      toolOutput: 100,
      largeWorkspace: true,
      largeReply: false,
      selection: 'driver',
    },
    {
      name: 'grades code only after a failed export leaves oversized driver turns',
      capture: 'failed',
      toolOutput: 100,
      largeWorkspace: true,
      largeReply: true,
      selection: 'omitted',
    },
    {
      name: 'budgets driver turns after exact OpenCode coverage fails',
      capture: 'mismatch',
      toolOutput: 100,
      largeWorkspace: true,
      largeReply: false,
      selection: 'driver',
    },
    {
      name: 'grades code only after coverage failure leaves oversized driver turns',
      capture: 'mismatch',
      toolOutput: 100,
      largeWorkspace: true,
      largeReply: true,
      selection: 'omitted',
    },
  ] as const) {
    it(scenario.name, async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-opencode-judge-budget-'),
      );
      t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
      const turn = {
        prompt: TASK,
        response: scenario.largeReply
          ? '界'.repeat(300_000)
          : `Completed: ${SECRET}`,
      };
      const exported = openCodeExport([turn]);
      const toolPart = exported.messages[1]!.parts.find(
        (part) => part.type === 'tool',
      )!;
      Object.assign(toolPart.state as object, {
        output: `${SECRET}:${'x'.repeat(scenario.toolOutput)}`,
      });
      const events = openCodeEvents(turn);
      events.find((event) => event.part.type === 'tool')!.part = toolPart;
      const stream = events.map((event) => JSON.stringify(event)).join('\n');
      if (scenario.capture === 'mismatch') {
        exported.messages[2]!.parts.find(
          (part) => part.type === 'text',
        )!.text = 'A different native reply.';
      }
      const raw = JSON.stringify(exported);
      // 228 KB of workspace plus 840 KB of native tool output exceeds 1 MiB.
      // A 900 KB UTF-8 reply also makes the driver overflow with that workspace.
      const files = scenario.largeWorkspace
        ? Object.fromEntries(
            Array.from({ length: 4 }, (_, index) => [
              `answer-${index}.ts`,
              '界'.repeat(19_000),
            ]),
          )
        : { 'answer.ts': 'export const answer = 42;\n' };
      const agent = createOpenCodeAdapter({
        baseUrl: 'https://gateway.example/v1',
      });
      const runtime = createFakeRuntimeAdapter({
        initialFiles: files,
        async command(call) {
          const stdout =
            call.scope === 'uncredentialed'
              ? '1.19.0'
              : call.argv[1] === 'export'
                ? raw
                : stream;
          if (call.scope === 'agent' && call.argv[1] !== 'export') {
            const state = runtime.runs[0]!.stateDirectories.get(
              OPENCODE_STATE_ID,
            )!.readonly;
            assert.equal(
              Buffer.from(await state.readFile('prompt.txt')).toString(),
              TASK,
            );
          }
          return {
            stdout,
            stderr: '',
            exitCode:
              call.argv[1] === 'export' && scenario.capture === 'failed'
                ? 1
                : 0,
            durationMs: 1,
          };
        },
      });
      const provider = createScriptedCompletionProvider({
        id: 'judge',
        responses: CRITERIA.map(() => SUCCESS),
      });
      const basePlan = createTestResolvedRunPlan({
        prompt: TASK,
        agent: {
          adapter: 'opencode',
          provider: 'openai-compatible',
          model: OPEN_CODE_MODEL,
          model_profile: OPEN_CODE_MODEL_PROFILE,
        },
        judgingCriteria: CRITERIA,
        judge: { provider: 'judge', model: 'scripted' },
      });
      const plan = parseResolvedRunPlan({
        ...basePlan,
        case: { ...basePlan.case, example_answer: EXAMPLE },
        evaluation: { ...basePlan.evaluation, example_answer: EXAMPLE },
      });
      const completed = await executeEval({
        runId: 'opencode-budget',
        plan,
        composition: {
          runtime: runtime.adapter,
          agents: new Map([[agent.id, agent]]),
          completionProviders: new Map([
            [provider.provider.id, provider.provider],
          ]),
          credentialResolver: createStaticCredentialResolver({
            'opencode.api-key': SECRET,
          }),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root }),
        },
      });
      const verified = await verifyCompletedRun(completed.location);
      assert.deepEqual(verified.result, completed.result);
      assert.equal(completed.result.evaluation.status, 'passed');
      assert.equal(
        completed.result.evaluation.judging_criteria.length,
        CRITERIA.length,
      );
      assert.equal(completed.result.agent.session_id, OPEN_CODE_SESSION);
      const judge = JSON.parse(
        await fs.readFile(
          path.join(completed.location, 'judge-evidence.json'),
          'utf8',
        ),
      ) as JudgeEvidenceV1;
      const trajectory = parseAtifTrajectory(
        JSON.parse(
          await fs.readFile(
            path.join(completed.location, 'trajectory.json'),
            'utf8',
          ),
        ),
      );
      const projection = createJudgeTranscriptProjection(trajectory);
      const omitted = scenario.selection === 'omitted';
      assert.equal(
        judge.transcript.omitted,
        omitted ? 'judge_budget_exceeded' : undefined,
      );
      assert.equal(
        serializeCanonicalJson(judge.transcript.steps),
        omitted ? '[]\n' : projection.transcriptJson,
      );
      assert.equal(
        completed.result.evidence.provenance.source.kind,
        scenario.selection === 'native' ? 'native_log' : 'driver_fallback',
      );
      assert.equal(
        completed.result.evidence.completeness,
        scenario.selection === 'native' ? 'complete' : 'fallback',
      );
      const warnings = completed.result.evidence.warnings;
      if (scenario.capture !== 'complete') {
        assert.ok(
          warnings.some(
            ({ code }) =>
              code ===
              (scenario.capture === 'failed'
                ? 'source_unavailable'
                : 'source_incomplete'),
          ),
        );
      } else if (scenario.selection !== 'native') {
        assert.ok(
          warnings.some(
            ({ code, message }) =>
              code === 'value_omitted' &&
              /Native evidence exceeded the judge budget/.test(message),
          ),
        );
      }
      assert.equal(
        warnings.some(
          ({ code, message }) =>
            code === 'value_omitted' && /workspace evidence only/.test(message),
        ),
        omitted,
      );
      assert.equal(judge.workspace.complete, true);
      assert.deepEqual(
        Object.fromEntries(
          judge.workspace.entries.map((entry) => [entry.path, entry.content]),
        ),
        files,
      );
      const workspaceText = renderRecordedJudgeWorkspaceEvidence(
        judge.workspace,
      );
      if (omitted) {
        assert.throws(
          () =>
            buildCriterionJudgePrompt(
              { transcript: projection, workspaceText, exampleAnswer: EXAMPLE },
              CRITERIA[1]!,
            ),
          /prompt exceeds/,
        );
      }
      if (
        scenario.selection === 'native' &&
        scenario.toolOutput === 840_000
      ) {
        assert.ok(Buffer.byteLength(projection.transcriptJson) > 786_432);
      }
      assert.equal(provider.calls.length, CRITERIA.length);
      for (const { request } of provider.calls) {
        const prompt = request.systemPrompt!;
        assert.ok(Buffer.byteLength(prompt) <= MAX_CRITERION_JUDGE_PROMPT_BYTES);
        assert.ok(
          CRITERIA.some(
            (criterion) =>
              prompt ===
              buildCriterionJudgePrompt(
                {
                  transcript: omitted ? EMPTY_JUDGE_TRANSCRIPT : projection,
                  workspaceText,
                  exampleAnswer: EXAMPLE,
                },
                criterion,
              ),
          ),
        );
        assert.ok(!prompt.includes(SECRET));
      }
      const native = completed.result.supplemental_artifacts.find(
        (artifact) => artifact.path === 'native/opencode/session.json',
      );
      if (scenario.capture === 'failed') {
        assert.equal(native, undefined);
      } else {
        assert.equal(native?.sensitivity, 'restricted');
        const nativePath = path.join(completed.location, native!.path);
        assert.equal(await fs.readFile(nativePath, 'utf8'), raw);
        assert.equal((await fs.stat(nativePath)).mode & 0o777, 0o600);
      }
    });
  }
});
