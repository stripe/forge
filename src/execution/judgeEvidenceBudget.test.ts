import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { loadClaudeEvidence } from '../agents/claude-code/evidence.ts';
import { parseAtifTrajectory, serializeAtifTrajectory } from '../atif/index.ts';
import { criterionJudgePromptOverheadBytes } from '../evaluation/criterionJudge.ts';
import {
  buildCriterionJudgePrompt,
  createJudgeTranscriptProjection,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
} from '../evaluation/index.ts';
import { sha256Digest } from '../model/hashes.ts';
import { parseResolvedRunPlan } from '../model/index.ts';
import {
  createArtifactStore,
  type JudgeEvidenceV1,
  verifyCompletedRun,
} from '../results/index.ts';
import { serializeCanonicalJson } from '../serialization.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createMemoryWorkspace,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../testing/index.ts';
import { executeEval } from './execute.ts';

const SESSION = 'budget-session';
const TASK = 'Create the requested code.';
const ANSWER = 'Implemented the requested code.';
const WORKSPACE_TEXT =
  '\n## Workspace Files\n\n### answer.ts\n```\nexport const answer = 42;\n\n```\n';
const CRITERIA = ['The code works.', 'The code is complete.'];
const SUCCESS = JSON.stringify({
  results: [
    {
      index: 0,
      passed: true,
      explanation: 'The code satisfies the criterion.',
    },
  ],
});

function nativeSession(resultCharacters: number): string {
  const records: unknown[] = [
    {
      type: 'user',
      sessionId: SESSION,
      message: { content: TASK },
    },
  ];
  for (let index = 0; index < 12; index += 1) {
    records.push(
      {
        type: 'assistant',
        sessionId: SESSION,
        message: {
          content: [
            {
              type: 'tool_use',
              id: `read-${index}`,
              name: 'Read',
              input: { file_path: `file-${index}.ts` },
            },
          ],
        },
      },
      {
        type: 'user',
        sessionId: SESSION,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: `read-${index}`,
              content: 'x'.repeat(resultCharacters),
            },
          ],
        },
      },
    );
  }
  records.push({
    type: 'assistant',
    sessionId: SESSION,
    message: { content: ANSWER },
  });
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

async function runBudgetEval(
  root: string,
  options: {
    raw?: string;
    assistant?: string;
    exampleAnswer?: string;
    files?: Record<string, string>;
  },
) {
  const runtime = createFakeRuntimeAdapter({
    initialFiles: options.files ?? {
      'answer.ts': 'export const answer = 42;\n',
    },
  });
  const project = createMemoryWorkspace(
    options.raw === undefined ? {} : { [`${SESSION}.jsonl`]: options.raw },
  );
  const native =
    options.raw === undefined
      ? undefined
      : await loadClaudeEvidence({
          project: project.readonly,
          sessionId: SESSION,
          agentVersion: '2.1.273',
          model: 'test-model',
          signal: new AbortController().signal,
        });
  if (native !== undefined) assert.equal(native.kind, 'available');
  const agent = createScriptedAgentAdapter({
    turns: [
      {
        text: options.assistant ?? ANSWER,
        sessionId: SESSION,
        toolCalls: [],
      },
    ],
    ...(native === undefined ? {} : { evidence: native }),
  });
  const adapter = {
    ...agent.adapter,
    ...(options.raw === undefined
      ? {}
      : {
          collectNativeArtifact: async () => ({
            sessionId: SESSION,
            format: 'claude-code-jsonl',
            mediaType: 'application/x-ndjson',
            extension: 'jsonl',
            body: Buffer.from(options.raw!),
          }),
        }),
  };
  const provider = createScriptedCompletionProvider({
    responses: CRITERIA.map(() => SUCCESS),
  });
  const basePlan = createTestResolvedRunPlan({
    prompt: TASK,
    judgingCriteria: CRITERIA,
    judge: { provider: 'test-provider', model: 'judge' },
  });
  const plan =
    options.exampleAnswer === undefined
      ? basePlan
      : parseResolvedRunPlan({
          ...basePlan,
          case: { ...basePlan.case, example_answer: options.exampleAnswer },
          evaluation: {
            ...basePlan.evaluation,
            example_answer: options.exampleAnswer,
          },
        });
  const completed = await executeEval({
    runId: 'budget-eval',
    plan,
    composition: {
      runtime: runtime.adapter,
      agents: new Map([[adapter.id, adapter]]),
      completionProviders: new Map([[provider.provider.id, provider.provider]]),
      credentialResolver: createStaticCredentialResolver(),
      inputProvider: createMemoryRunInputProvider(),
      artifactStore: createArtifactStore({ root }),
    },
  });
  const judge = JSON.parse(
    await fs.readFile(
      path.join(completed.location, 'judge-evidence.json'),
      'utf8',
    ),
  ) as JudgeEvidenceV1;
  const trajectoryBytes = await fs.readFile(
    path.join(completed.location, 'trajectory.json'),
    'utf8',
  );
  assert.equal(completed.result.evaluation.status, 'passed');
  assert.equal(completed.result.evaluation.score, 1);
  assert.deepEqual(
    (await verifyCompletedRun(completed.location)).result,
    completed.result,
  );
  for (const { request } of provider.calls) {
    const prompt = request.systemPrompt ?? '';
    assert.ok(
      Buffer.byteLength(prompt, 'utf8') <= MAX_CRITERION_JUDGE_PROMPT_BYTES,
    );
    for (const entry of judge.workspace.entries) {
      assert.ok(prompt.includes(entry.content));
    }
  }
  return { completed, judge, trajectoryBytes, provider, native };
}

async function rebindJudge(
  location: string,
  change: (judge: {
    transcript: { steps: { message?: string }[]; omitted?: string };
  }) => void,
) {
  const judgePath = path.join(location, 'judge-evidence.json');
  const judge = JSON.parse(await fs.readFile(judgePath, 'utf8'));
  change(judge);
  const body = serializeCanonicalJson(judge);
  await fs.writeFile(judgePath, body);
  const resultPath = path.join(location, 'result.json');
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const descriptor = result.artifacts.find(
    (entry: { path: string }) => entry.path === 'judge-evidence.json',
  );
  descriptor.size_bytes = Buffer.byteLength(body, 'utf8');
  descriptor.sha256 = sha256Digest(Buffer.from(body));
  await fs.writeFile(resultPath, serializeCanonicalJson(result));
}

describe('executeEval judge evidence budget and local store round trips', () => {
  it('grades twelve 70,000-character Read results on driver evidence when workspace text needs the room', async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-budget-driver-'),
    );
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    // About 230 KB of workspace plus 840 KB of native results exceeds 1 MiB.
    const files = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [
        `answer-${i}.ts`,
        '界'.repeat(19_000),
      ]),
    );
    const raw = nativeSession(70_000);
    const { completed, judge, trajectoryBytes } = await runBudgetEval(root, {
      raw,
      files,
    });
    assert.equal(
      completed.result.evidence.provenance.source.kind,
      'driver_fallback',
    );
    assert.equal(completed.result.evidence.completeness, 'fallback');
    assert.ok(
      completed.result.evidence.warnings.some(({ message }) =>
        /Native evidence exceeded the judge budget/.test(message),
      ),
    );
    assert.equal(judge.transcript.omitted, undefined);
    assert.equal(judge.transcript.steps.length, 2);
    assert.equal(judge.transcript.steps[1]!.message, ANSWER);
    assert.equal(
      trajectoryBytes,
      serializeAtifTrajectory(JSON.parse(trajectoryBytes)),
    );
    assert.equal(
      await fs.readFile(
        path.join(completed.location, 'native/test-agent/session.jsonl'),
        'utf8',
      ),
      raw,
    );
    assert.equal(judge.workspace.entries.length, 4);
    for (const entry of judge.workspace.entries) {
      assert.equal(entry.content, files[entry.path]);
    }
    await rebindJudge(completed.location, (evidence) => {
      evidence.transcript.steps[1]!.message = 'tampered';
    });
    await assert.rejects(
      verifyCompletedRun(completed.location),
      /transcript steps do not match/,
    );
  });

  it('keeps an under-budget native session and judge request byte-for-byte unchanged', async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-budget-native-'),
    );
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const { completed, judge, trajectoryBytes, native, provider } =
      await runBudgetEval(root, { raw: nativeSession(100) });
    assert.ok(native?.kind === 'available');
    assert.equal(
      completed.result.evidence.provenance.source.kind,
      'native_log',
    );
    assert.deepEqual(completed.result.evidence.warnings, []);
    const trajectory = parseAtifTrajectory(native.trajectory);
    assert.equal(trajectoryBytes, serializeAtifTrajectory(trajectory));
    const projection = createJudgeTranscriptProjection(trajectory);
    assert.equal(
      serializeCanonicalJson(judge.transcript.steps),
      projection.transcriptJson,
    );
    assert.equal(judge.transcript.omitted, undefined);
    // Golden bytes captured by running this fixture against origin/main (ab999e5).
    assert.equal(
      sha256Digest(Buffer.from(trajectoryBytes)),
      'sha256:d088735614d7e031b8f27950a0b131e9a3674c766509758255410c4661e35680',
    );
    assert.equal(
      sha256Digest(Buffer.from(serializeCanonicalJson(judge))),
      'sha256:4e02952c4061c5c6b3bb5ae3479b251b16ef9a7f5213d0dc6a1e839609fff58e',
    );
    assert.deepEqual(
      provider.calls.map(({ request }) =>
        sha256Digest(Buffer.from(request.systemPrompt ?? '')),
      ),
      [
        'sha256:84d5602ab6e85f506074b9ee05d3f8272f5e6ee0bb21c7ea2072fe6fad30e9a8',
        'sha256:11544247d3eddf4fdce512cd0e9a676f357a6666a9aed5eeafc1500e789c7a8e',
      ],
    );
    for (const [index, { request }] of provider.calls.entries()) {
      assert.equal(
        request.systemPrompt,
        buildCriterionJudgePrompt(
          { transcript: projection, workspaceText: WORKSPACE_TEXT },
          CRITERIA[index]!,
        ),
      );
    }
    await rebindJudge(completed.location, (evidence) => {
      evidence.transcript.steps = [];
      evidence.transcript.omitted = 'judge_budget_exceeded';
    });
    await assert.rejects(
      verifyCompletedRun(completed.location),
      /omission is not justified/,
    );
  });

  it('retains native evidence above the old cap when the complete prompt fits', async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-budget-larger-native-'),
    );
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const { completed, judge } = await runBudgetEval(root, {
      raw: nativeSession(70_000),
    });
    assert.equal(
      completed.result.evidence.provenance.source.kind,
      'native_log',
    );
    assert.ok(
      Buffer.byteLength(
        serializeCanonicalJson(judge.transcript.steps),
        'utf8',
      ) >
        768 * 1024,
    );
  });

  for (const raw of [undefined, nativeSession(100_000)]) {
    it(`grades on code alone with over-budget driver evidence (native=${raw !== undefined})`, async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-budget-code-'),
      );
      t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
      const { completed, judge, trajectoryBytes, provider } =
        await runBudgetEval(root, {
          ...(raw === undefined ? {} : { raw }),
          assistant: 'y'.repeat(1_100_000),
        });
      assert.equal(
        completed.result.evidence.provenance.source.kind,
        'driver_fallback',
      );
      assert.deepEqual(judge.transcript.steps, []);
      assert.equal(judge.transcript.omitted, 'judge_budget_exceeded');
      assert.equal(
        JSON.parse(trajectoryBytes).steps[1].message.length,
        1_100_000,
      );
      for (const { request } of provider.calls) {
        assert.ok(!(request.systemPrompt ?? '').includes('y'.repeat(100)));
      }
      await rebindJudge(completed.location, (evidence) => {
        delete evidence.transcript.omitted;
      });
      await assert.rejects(
        verifyCompletedRun(completed.location),
        /transcript steps do not match/,
      );
    });
  }

  const driverTranscript = createJudgeTranscriptProjection({
    schema_version: 'ATIF-v1.8',
    agent: { name: 'test-agent', version: '1' },
    steps: [
      { step_id: 1, source: 'user', message: TASK },
      { step_id: 2, source: 'agent', message: ANSWER },
    ],
  });
  const driverBytes = Buffer.byteLength(
    driverTranscript.transcriptJson,
    'utf8',
  );
  for (const remainingBytes of [driverBytes, driverBytes - 1, 3]) {
    it(`uses the real whole-prompt boundary with ${remainingBytes} transcript bytes available`, async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-budget-boundary-'),
      );
      t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
      const overheadWithOneExampleByte = criterionJudgePromptOverheadBytes({
        criteria: CRITERIA,
        exampleAnswer: 'e',
        workspaceText: WORKSPACE_TEXT,
      });
      const exampleAnswer = 'e'.repeat(
        MAX_CRITERION_JUDGE_PROMPT_BYTES -
          overheadWithOneExampleByte -
          remainingBytes +
          1,
      );
      const { judge, provider } = await runBudgetEval(root, { exampleAnswer });
      const omitted = remainingBytes < driverBytes;
      assert.equal(
        judge.transcript.omitted,
        omitted ? 'judge_budget_exceeded' : undefined,
      );
      assert.equal(judge.transcript.steps.length, omitted ? 0 : 2);
      const largestPromptBytes = Math.max(
        ...provider.calls.map(({ request }) =>
          Buffer.byteLength(request.systemPrompt ?? '', 'utf8'),
        ),
      );
      assert.equal(
        largestPromptBytes,
        MAX_CRITERION_JUDGE_PROMPT_BYTES -
          remainingBytes +
          (omitted ? 3 : driverBytes),
      );
    });
  }

  it('verifies code-only evidence with recorded workspace truncation warnings', async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-budget-warning-'),
    );
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const { judge } = await runBudgetEval(root, {
      assistant: 'y'.repeat(1_100_000),
      files: { 'answer.ts': 'x'.repeat(20_001) },
    });
    assert.equal(judge.transcript.omitted, 'judge_budget_exceeded');
    assert.ok(
      judge.workspace.warnings.some(
        ({ code }) => code === 'workspace_file_truncated',
      ),
    );
  });

  it('rejects forged omission for under-budget driver evidence with rebound hashes', async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'forge-budget-forged-'),
    );
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const { completed } = await runBudgetEval(root, {});
    await rebindJudge(completed.location, (evidence) => {
      evidence.transcript.steps = [];
      evidence.transcript.omitted = 'judge_budget_exceeded';
    });
    await assert.rejects(
      verifyCompletedRun(completed.location),
      /omission is not justified/,
    );
  });
});
