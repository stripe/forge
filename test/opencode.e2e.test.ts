import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import {
  createOpenCodeAdapter,
  OPENCODE_STATE_ID,
} from '../src/agents/opencode/index.js';
import {
  createArtifactStore,
  executeEval,
  preflightEval,
  verifyCompletedRun,
} from '../src/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../src/testing/index.js';
import {
  OPEN_CODE_MODEL,
  OPEN_CODE_MODEL_PROFILE,
  OPEN_CODE_SESSION,
  type OpenCodeFixtureTurn,
  openCodeExport,
  openCodeStream,
} from './support/opencode.js';

const SECRET = 'test-opencode-secret-only-agent';
describe('OpenCode engine integration', () => {
  for (const [mode, captureBytes] of [
    ['one_shot', undefined],
    ['multi_turn', undefined],
    ['one_shot', 4096],
    ['one_shot', 0],
  ] as const) {
    const truncated = captureBytes !== undefined;
    it(`commits and independently verifies ${mode} ${truncated ? `${captureBytes}-byte truncated` : 'native'} evidence and redaction`, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-opencode-e2e-'),
      );
      try {
        const turns: OpenCodeFixtureTurn[] = [];
        let exports = 0;
        const agent = createOpenCodeAdapter({
          baseUrl: 'https://gateway.example/v1',
        });
        const runtime = createFakeRuntimeAdapter({
          async command(call) {
            if (call.scope === 'uncredentialed') {
              assert.deepEqual(call.argv, ['opencode', '--version']);
              assert.deepEqual(call.credentialEnvironmentNames, []);
              return {
                stdout: '1.19.0',
                stderr: '',
                exitCode: 0,
                durationMs: 1,
              };
            }
            assert.equal(call.scope, 'agent');
            assert.deepEqual(call.credentialEnvironmentNames, [
              'OPENCODE_API_KEY',
            ]);
            if (call.argv.includes('export')) {
              exports++;
              assert.equal(call.argv.at(-1), OPEN_CODE_SESSION);
              const body = JSON.stringify(openCodeExport(turns));
              // A piped CLI loses data at exit; a regular stdout file keeps it.
              const piped = body.slice(0, 4096);
              if (call.argv[0] === 'node')
                await runtime.runs[0]!.stateDirectories.get(
                  OPENCODE_STATE_ID,
                )!.mutable.writeFile(
                  'session.json',
                  Buffer.from(truncated ? body.slice(0, captureBytes) : body),
                );
              return {
                stdout: piped,
                stderr: '',
                exitCode: 0,
                durationMs: 1,
              };
            }
            const state =
              runtime.runs[0]!.stateDirectories.get(
                OPENCODE_STATE_ID,
              )!.readonly;
            assert.equal((await state.readFile('session.json')).length, 0);
            if (turns.length > 0)
              assert.deepEqual(call.argv.slice(-2), [
                '--session',
                OPEN_CODE_SESSION,
              ]);
            const prompt = Buffer.from(
              await state.readFile('prompt.txt'),
            ).toString();
            const turn = {
              prompt,
              response: `Completed ${turns.length + 1}: ${SECRET} ${'x'.repeat(80 * 1024)}`,
            };
            turns.push(turn);
            await runtime.runs[0]!.workspace.mutable.writeFile(
              'answer.txt',
              Buffer.from('complete'),
            );
            return {
              stdout: openCodeStream(turn, turns.length - 1),
              stderr: '',
              exitCode: 0,
              durationMs: 1,
            };
          },
        });
        const completion = createScriptedCompletionProvider({
          id: 'harness',
          responses: [
            JSON.stringify({
              user_needs: [
                {
                  description: 'Complete both parts',
                  acceptance: 'Both requested parts are complete.',
                },
              ],
              message: 'Do part one',
            }),
            JSON.stringify({
              remaining_need_ids: ['need_1'],
              message: 'Do part two',
            }),
            JSON.stringify({ remaining_need_ids: [], message: '' }),
          ],
        });
        const plan = createTestResolvedRunPlan({
          mode,
          prompt: 'Create answer.txt',
          agent: {
            adapter: 'opencode',
            provider: 'openai-compatible',
            model: OPEN_CODE_MODEL,
            model_profile: OPEN_CODE_MODEL_PROFILE,
          },
          ...(mode === 'multi_turn'
            ? {
                maxTurns: 3,
                rolePlayer: { provider: 'harness', model: 'scripted' },
              }
            : {}),
          checks: { files_created: ['answer.txt'] },
        });
        const resolved: string[] = [];
        const composition = {
          runtime: runtime.adapter,
          agents: new Map([[agent.id, agent]]),
          completionProviders: new Map([
            [completion.provider.id, completion.provider],
          ]),
          credentialResolver: createStaticCredentialResolver(
            { 'opencode.api-key': SECRET },
            {
              onResolve: (reference) => {
                resolved.push(reference);
              },
            },
          ),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root }),
        };
        preflightEval({ plan, composition });
        assert.equal(runtime.runs.length, 0);
        assert.deepEqual(resolved, []);
        const completed = await executeEval({
          runId: `opencode-${mode}`,
          plan,
          composition,
        });
        const verified = await verifyCompletedRun(completed.location);
        assert.equal(verified.result.evaluation.status, 'passed');
        assert.equal(
          verified.result.evidence.completeness,
          truncated ? 'fallback' : 'complete',
        );
        assert.equal(verified.result.agent.session_id, OPEN_CODE_SESSION);
        assert.deepEqual(
          verified.result.selection.agent.model_profile,
          OPEN_CODE_MODEL_PROFILE,
        );
        assert.equal(turns.length, mode === 'multi_turn' ? 2 : 1);
        assert.deepEqual(resolved, ['opencode.api-key']);
        const native = verified.result.supplemental_artifacts.find(
          (item) => item.path === 'native/opencode/session.json',
        );
        for (const artifact of verified.result.artifacts)
          assert.ok(
            !(
              await fs.readFile(
                path.join(completed.location, artifact.path),
                'utf8',
              )
            ).includes(SECRET),
          );
        if (truncated) {
          assert.equal(exports, 2);
          assert.equal(native, undefined);
          assert.deepEqual(
            verified.result.evidence.warnings.map(({ code }) => code),
            ['source_truncated', 'fallback_used'],
          );
          assert.equal(
            verified.result.evidence.warnings[0]!.message,
            `The OpenCode session export ended before its JSON was complete (${captureBytes} bytes).`,
          );
          return;
        }
        assert.equal(native?.sensitivity, 'restricted');
        const nativePath = path.join(completed.location, native!.path);
        assert.equal(
          await fs.readFile(nativePath, 'utf8'),
          JSON.stringify(openCodeExport(turns)),
        );
        assert.equal((await fs.stat(nativePath)).mode & 0o777, 0o600);
        assert.ok(
          runtime.runs[0]!.events.indexOf('quiesce') <
            runtime.runs[0]!.events.indexOf('dispose'),
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
