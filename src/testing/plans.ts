import {parseResolvedRunPlan} from '../model/parse.js';
import type {
  AgentSelectionV1,
  ChecksV1,
  ForgeRuntimeV1,
  ModelRefV1,
  ResolvedRunPlanV1,
  SetupStepV1,
} from '../model/types.js';

const DATASET_DIGEST = `sha256:${'1'.repeat(64)}` as const;
const EXPERIMENT_DIGEST = `sha256:${'2'.repeat(64)}` as const;
const CASE_DIGEST = `sha256:${'3'.repeat(64)}` as const;

export interface TestResolvedRunPlanOptions {
  readonly forgeVersion?: string;
  readonly caseId?: string;
  readonly prompt?: string;
  readonly mode?: 'multi_turn' | 'one_shot';
  readonly context?: string;
  readonly initialPrompt?: string;
  readonly maxTurns?: number;
  readonly successGuidelines?: readonly string[];
  readonly rolePlayer?: ModelRefV1;
  readonly judge?: ModelRefV1;
  readonly agent?: AgentSelectionV1;
  readonly caseSetup?: readonly SetupStepV1[];
  readonly treatment?: string;
  readonly treatmentSetup?: readonly SetupStepV1[];
  readonly checks?: ChecksV1;
  readonly runtime?: ForgeRuntimeV1;
}

/** Create a strict, minimal one-shot plan for public contract tests. */
export function createTestResolvedRunPlan(
  options: TestResolvedRunPlanOptions = {},
): ResolvedRunPlanV1 {
  const caseId = options.caseId ?? 'testing/example';
  const prompt = options.prompt ?? 'Complete the test task.';
  const mode = options.mode ?? 'one_shot';
  const treatment = options.treatment ?? 'baseline';
  const agent = options.agent ?? {
    adapter: 'test-agent',
    provider: 'test-provider',
    model: 'test-model',
  };
  const caseSetup = [...(options.caseSetup ?? [])];
  const treatmentSetup = [...(options.treatmentSetup ?? [])];
  const setup = [...caseSetup, ...treatmentSetup];
  const checks = options.checks;
  const successGuidelines = [...(options.successGuidelines ?? [])];
  const initialPrompt = options.initialPrompt ?? (mode === 'one_shot' ? prompt : undefined);
  const maxTurns = mode === 'one_shot' ? 1 : (options.maxTurns ?? 10);

  return parseResolvedRunPlan({
    schema_version: 1,
    selection: {
      case_id: caseId,
      treatment,
      agent: {...agent},
      repetition: 0,
    },
    provenance: {
      dataset: {
        id: 'forge-testing',
        version: '1.0.0',
        manifest_sha256: DATASET_DIGEST,
      },
      experiment: {
        id: 'testing/experiment',
        version: '1.0.0',
        sha256: EXPERIMENT_DIGEST,
      },
      case: {
        id: caseId,
        path: `cases/${caseId}/eval.yaml`,
        sha256: CASE_DIGEST,
      },
      forge: {version: options.forgeVersion ?? '0.1.0'},
    },
    case: {
      schema_version: 1,
      id: caseId,
      ...(mode === 'one_shot' ? {initial_prompt: initialPrompt!} : {task: prompt}),
      ...(mode === 'multi_turn' && initialPrompt !== undefined
        ? {initial_prompt: initialPrompt}
        : {}),
      ...(options.context === undefined ? {} : {context: options.context}),
      execution_mode: mode,
      ...(mode === 'multi_turn' ? {max_turns: maxTurns} : {}),
      setup: caseSetup,
      success_guidelines: successGuidelines,
      ...(checks === undefined ? {} : {checks}),
    },
    treatment: {id: treatment, setup: treatmentSetup},
    setup,
    interaction: {
      mode,
      ...(mode === 'one_shot'
        ? {
            initial_prompt: initialPrompt!,
            initial_prompt_source: 'case.initial_prompt' as const,
            effective_prompt: initialPrompt!,
          }
        : {
            task: prompt,
            ...(options.context === undefined ? {} : {context: options.context}),
            ...(initialPrompt === undefined ? {} : {initial_prompt: initialPrompt}),
            initial_prompt_source:
              initialPrompt === undefined
                ? ('case.task' as const)
                : ('case.initial_prompt' as const),
            effective_prompt: initialPrompt ?? prompt,
          }),
      max_turns: maxTurns,
    },
    evaluation: {
      success_guidelines: successGuidelines,
      ...(checks === undefined ? {} : {checks}),
      ...(options.judge === undefined ? {} : {judge: {...options.judge}}),
    },
    ...(options.rolePlayer === undefined
      ? {}
      : {role_player: {...options.rolePlayer}}),
    agent: {...agent},
    runtime: options.runtime ?? {
      adapter: 'docker',
      image: {kind: 'forge'},
      platform: 'linux/amd64',
      resources: {
        memory_bytes: 4 * 1024 * 1024 * 1024,
        cpu_count: 2,
        process_count: 512,
      },
    },
    limits: {run_timeout_ms: 30_000},
  });
}
