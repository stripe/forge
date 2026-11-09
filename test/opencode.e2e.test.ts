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
  createForgeEngine,
  executeEval,
  preflightEval,
  verifyCompletedRun,
} from '../src/index.js';
import {
  defineSetupActionBundle,
  pluginSetupHandler,
} from '../src/setup/index.ts';
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
  for (const uses of ['forge/plugin', 'fixture/install-plugin']) {
    it(`activates and verifies a custom-ID bundle installed through ${uses}`, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-opencode-plugin-'),
      );
      try {
        const agent = createOpenCodeAdapter({
          id: 'custom-opencode',
          baseUrl: 'https://gateway.example/v1',
        });
        const sourceCommit = 'a'.repeat(40);
        const bundlePath = 'providers/claude/plugin';
        const runtime = createFakeRuntimeAdapter({
          stateFiles: {
            [OPENCODE_STATE_ID]: {
              [`stripe-source/${bundlePath}/.claude-plugin/plugin.json`]:
                JSON.stringify({ name: 'stripe', version: '1.2.3' }),
              [`stripe-source/${bundlePath}/.mcp.json`]: JSON.stringify({
                mcpServers: {
                  stripe: { type: 'http', url: 'https://mcp.stripe.com' },
                },
              }),
              [`stripe-source/${bundlePath}/skills/test/SKILL.md`]: 'Use Stripe.',
            },
          },
          async command(call) {
            assert.deepEqual(
              call.credentialEnvironmentNames,
              call.scope === 'agent'
                ? ['OPENCODE_API_KEY', 'STRIPE_API_KEY']
                : [],
            );
            if (call.argv[1] === '--version')
              return { stdout: '1.19.0', stderr: '', exitCode: 0, durationMs: 1 };
            if (call.argv.includes('git')) {
              const stdout = call.argv.includes('show')
                ? JSON.stringify({
                    name: 'claude-plugins-official',
                    plugins: [{
                      name: 'stripe',
                      source: {
                        source: 'git-subdir',
                        url: 'https://github.com/stripe/ai.git',
                        path: bundlePath, sha: sourceCommit,
                      },
                    }],
                  })
                : call.argv.includes('rev-parse') ? sourceCommit : '';
              return { stdout, stderr: '', exitCode: 0, durationMs: 1 };
            }
            const state = runtime.runs[0]!.stateDirectories.get(
              OPENCODE_STATE_ID,
            )!.readonly;
            const config = JSON.parse(
              Buffer.from(await state.readFile('config.json')).toString(),
            );
            assert.equal(config.model, `forge/${OPEN_CODE_MODEL}`);
            assert.equal(config.mcp.stripe.enabled, true);
            assert.equal(
              config.mcp.stripe.headers.Authorization,
              'Bearer {env:STRIPE_API_KEY}',
            );
            assert.deepEqual(config.skills.paths, [
              '/home/forge/.opencode-forge/plugins/stripe/bundle/skills',
            ]);
            const turn = { prompt: 'Do it', response: 'Done' };
            return {
              stdout:
                call.argv[1] === 'export'
                  ? JSON.stringify(openCodeExport([turn]))
                  : openCodeStream(turn),
              stderr: '',
              exitCode: 0,
              durationMs: 1,
            };
          },
        });
        const custom = defineSetupActionBundle({
          manifest: {
            namespace: 'fixture',
            version: '1.0.0',
            sha256: `sha256:${'d'.repeat(64)}`,
          },
          actions: [{
            uses: 'fixture/install-plugin',
            parseWith(input) {
              assert.deepEqual(input, {});
              return {};
            },
            preflight(_step, context) {
              return pluginSetupHandler.preflight(
                { uses: 'forge/plugin', with: { plugin: 'stripe' } },
                context,
              );
            },
          }],
        });
        const engine = createForgeEngine({ setupActionBundles: [custom] });
        const base = createTestResolvedRunPlan({
          prompt: 'Do it',
          treatment: 'stripe-plugin',
          agent: {
            adapter: agent.id,
            provider: 'openai-compatible',
            model: OPEN_CODE_MODEL,
            model_profile: OPEN_CODE_MODEL_PROFILE,
          },
        });
        const setup = [{
          uses,
          with: uses === 'forge/plugin' ? { plugin: 'stripe' } : {},
        }];
        const plan = engine.parseResolvedRunPlan({
          ...base,
          treatment: { ...base.treatment, setup },
          setup,
          provenance: {
            ...base.provenance,
            forge: {
              ...base.provenance.forge,
              ...(uses === 'forge/plugin'
                ? {}
                : { action_bundles: [custom.manifest] }),
            },
          },
        });
        const composition = {
          runtime: runtime.adapter,
          agents: new Map([[agent.id, agent]]),
          credentialResolver: createStaticCredentialResolver({
            'opencode.api-key': SECRET,
            'env:STRIPE_API_KEY': 'synthetic-stripe-key',
          }),
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createArtifactStore({ root }),
        };
        engine.preflightEval({ plan, composition });
        assert.equal(runtime.runs.length, 0);
        const completed = await engine.executeEval({
          runId: 'custom-plugin', plan, composition,
        });
        await engine.verifyCompletedRun(completed.location);
        const saved = JSON.parse(
          await fs.readFile(path.join(completed.location, 'setup.json'), 'utf8'),
        );
        assert.equal(saved.steps[0].uses, uses);
        assert.equal(saved.steps[0].resolution.installation, 'bundle');
        assert.equal(saved.steps[0].resolution.adapter, agent.id);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  for (const mode of ['one_shot', 'multi_turn'] as const) {
    it(`commits and independently verifies ${mode} native evidence, redaction, and restricted bytes`, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'forge-opencode-e2e-'),
      );
      try {
        const turns: OpenCodeFixtureTurn[] = [];
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
            if (call.argv[1] === 'export') {
              assert.equal(call.argv[2], OPEN_CODE_SESSION);
              return {
                stdout: JSON.stringify(openCodeExport(turns)),
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
              response: `Completed ${turns.length + 1}: ${SECRET}`,
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
                { description: 'Complete both parts', status: 'remaining' },
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
        assert.equal(verified.result.evidence.completeness, 'complete');
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
        assert.equal(native?.sensitivity, 'restricted');
        const nativePath = path.join(completed.location, native!.path);
        assert.equal(
          await fs.readFile(nativePath, 'utf8'),
          JSON.stringify(openCodeExport(turns)),
        );
        assert.equal((await fs.stat(nativePath)).mode & 0o777, 0o600);
        for (const artifact of verified.result.artifacts)
          assert.ok(
            !(
              await fs.readFile(
                path.join(completed.location, artifact.path),
                'utf8',
              )
            ).includes(SECRET),
          );
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
