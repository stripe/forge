import assert from 'node:assert/strict';
import { it } from 'vitest';
import { resolveCliRuntime } from './cliRuntime.ts';
import { agentSelectionKey } from './model/matrix.ts';
import { parseExperimentConfig, parseRunSelection } from './model/parse.ts';
import type {
  ExperimentMatrixV1,
  LoadedExperimentConfigV1,
} from './model/types.ts';

it('records explicit Claude compatibility in agent selection for resume consistency', () => {
  const experiment = experimentWithMatrix({
    agents: [
      { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
      { adapter: 'codex', provider: 'openai', model: 'test' },
    ],
    cases: ['cases/example.case.yaml'],
    treatments: ['baseline'],
    repetitions: 1,
    retries: 0,
  });
  const result = resolveCliRuntime(experiment, {
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  });
  assert.deepEqual(
    'agents' in result.config.matrix &&
      result.config.matrix.agents?.map(
        (agent) => agent.disable_experimental_betas,
      ),
    [true, undefined],
  );
  assert.deepEqual(
    resolveCliRuntime(result, { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0' }),
    experiment,
  );
});

it('rejects compatibility on Codex and distinguishes Claude selections', () => {
  const agent = {
    adapter: 'claude-code',
    provider: 'anthropic',
    model: 'test',
  };
  const selection = {
    case_id: 'case',
    treatment: 'baseline',
    repetition: 0,
    agent: { ...agent, disable_experimental_betas: true },
  };
  assert.equal(
    parseRunSelection(selection).agent.disable_experimental_betas,
    true,
  );
  assert.notEqual(
    agentSelectionKey(agent),
    agentSelectionKey({ ...agent, disable_experimental_betas: true }),
  );
  assert.throws(
    () =>
      parseRunSelection({
        ...selection,
        agent: { ...selection.agent, adapter: 'codex' },
      }),
    /only by Claude/,
  );
});

for (const grouped of [false, true])
  for (const value of ['0', '1'])
    it(`rejects effective matrix collisions with grouped=${grouped} and beta override=${value}`, () => {
      const group = {
        cases: ['cases/example.case.yaml'],
        treatments: ['baseline'],
        agents: [
          { adapter: 'claude-code', provider: 'anthropic', model: 'test' },
        ],
      };
      const compatibleAgent = {
        ...group.agents[0]!,
        disable_experimental_betas: true as const,
      };
      const experiment = experimentWithMatrix(
        grouped
          ? {
              groups: [group, { ...group, agents: [compatibleAgent] }],
              repetitions: 1,
              retries: 0,
            }
          : {
              ...group,
              agents: [...group.agents, compatibleAgent],
              repetitions: 1,
              retries: 0,
            },
      );
      assert.throws(
        () =>
          resolveCliRuntime(experiment, {
            CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: value,
          }),
        /agents values must be unique|duplicate resolved selections/,
      );
    });

function experimentWithMatrix(
  matrix: ExperimentMatrixV1,
): LoadedExperimentConfigV1 {
  return {
    path: '/experiment.yaml',
    root: '/',
    raw: '',
    config: parseExperimentConfig({
      id: 'testing/compatibility',
      version: '1.0.0',
      dataset: {
        id: 'testing',
        version: '1.0.0',
      },
      runtime: {
        adapter: 'docker',
        image: { kind: 'forge' },
        platform: 'linux/amd64',
      },
      matrix,
    }),
  };
}
