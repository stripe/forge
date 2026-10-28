import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../cli.ts';
import type { AgentAdapter } from '../../contracts/agent.ts';
import { createDirectoryRunInputProvider } from '../../contracts/inputs.ts';
import { createArtifactStore } from '../../results/index.ts';
import {
  createFakeRuntimeAdapter,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
} from '../../testing/index.ts';

const FIXTURE_ROOT = path.join(process.cwd(), 'test', 'fixtures', 'multi-turn');
const DELIVERABLE = 'Forge is ready for multi-turn evaluation.\n';

export const ORIGINAL_JUDGMENT = JSON.stringify({
  results: [
    {
      index: 0,
      passed: true,
      explanation: 'The conversation supplied the exact status sentence.',
    },
  ],
});

/**
 * Execute the multi-turn fixture once through the public CLI with scripted
 * agent, Ava, and judge, leaving a real committed experiment run on disk.
 */
export async function runJudgedFixture(root: string) {
  const runtime = createFakeRuntimeAdapter();
  const agent = createScriptedAgentAdapter({
    id: 'claude-code',
    turns: [
      {
        text: 'What exact status sentence should the release summary contain?',
        sessionId: 'regrade-session',
        toolCalls: [],
      },
      {
        text: 'Created release-summary.txt with the status sentence you supplied.',
        sessionId: 'regrade-session',
        toolCalls: [],
      },
    ],
  });
  const writingAgent: AgentAdapter = {
    ...agent.adapter,
    async openSession(context) {
      const session = await agent.adapter.openSession(context);
      let turn = 0;
      return {
        ...session,
        async send(message, sendOptions) {
          if (turn++ === 1) {
            // A binary file exercises the judge workspace warnings, which a
            // regrade must render exactly as the original judge saw them.
            await context.runtime.workspace.writeFile(
              'state.sqlite',
              Buffer.from('SQLite format 3\0private database bytes'),
            );
            await context.runtime.workspace.writeFile(
              'release-summary.txt',
              Buffer.from(DELIVERABLE),
            );
          }
          return session.send(message, sendOptions);
        },
      };
    },
  };
  const completion = createScriptedCompletionProvider({
    id: 'anthropic',
    responses: [
      JSON.stringify({
        user_needs: [
          {
            description: 'Create the release summary',
            acceptance: 'The file contains the supplied status sentence.',
            status: 'remaining',
          },
        ],
      }),
      JSON.stringify({
        remaining_need_ids: ['need_1'],
        message: `Use this exact status sentence: ${DELIVERABLE.trim()}`,
      }),
      JSON.stringify({ remaining_need_ids: [], message: '' }),
      ORIGINAL_JUDGMENT,
    ],
  });
  let stdout = '';
  let stderr = '';
  const code = await runCli(
    [
      'run',
      '--experiment',
      path.join(FIXTURE_ROOT, 'experiment.yaml'),
      '--output',
      path.join(root, 'results'),
      '--run-id',
      'regrade-source',
    ],
    {
      compositionFactory: async ({ datasetRoot, resultsRoot }) => ({
        runtime: runtime.adapter,
        agents: new Map([[writingAgent.id, writingAgent]]),
        completionProviders: new Map([
          [completion.provider.id, completion.provider],
        ]),
        credentialResolver: createStaticCredentialResolver(),
        inputProvider: await createDirectoryRunInputProvider(datasetRoot),
        artifactStore: createArtifactStore({ root: resultsRoot }),
      }),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  );
  if (code !== 0) throw new Error(`Fixture run failed: ${stderr}`);
  const experiment = JSON.parse(stdout) as { location: string };
  const judgeCalls = completion.calls.filter(
    (call) => call.request.purpose === 'judge',
  );
  return {
    experimentLocation: experiment.location,
    runLocation: path.join(experiment.location, 'runs', 'regrade-source'),
    originalJudgeRequests: judgeCalls.map((call) => call.request),
  };
}

export async function temporaryRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
