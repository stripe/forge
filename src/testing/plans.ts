import {parseResolvedRunPlan} from '../model/parse.js';
import type {
  AgentSelectionV1,
  ChecksV1,
  ResolvedRunPlanV1,
  SetupStepV1,
} from '../model/types.js';

const DATASET_DIGEST = `sha256:${'1'.repeat(64)}` as const;
const PROFILE_DIGEST = `sha256:${'2'.repeat(64)}` as const;
const CASE_DIGEST = `sha256:${'3'.repeat(64)}` as const;

export interface TestResolvedRunPlanOptions {
  readonly forgeVersion?: string;
  readonly caseId?: string;
  readonly prompt?: string;
  readonly agent?: AgentSelectionV1;
  readonly caseSetup?: readonly SetupStepV1[];
  readonly treatment?: string;
  readonly treatmentSetup?: readonly SetupStepV1[];
  readonly checks?: ChecksV1;
}

/** Create a strict, minimal one-shot plan for public contract tests. */
export function createTestResolvedRunPlan(
  options: TestResolvedRunPlanOptions = {},
): ResolvedRunPlanV1 {
  const caseId = options.caseId ?? 'testing/example';
  const prompt = options.prompt ?? 'Complete the test task.';
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
      profile: {
        id: 'testing/profile',
        version: '1.0.0',
        sha256: PROFILE_DIGEST,
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
      initial_prompt: prompt,
      execution_mode: 'one_shot',
      setup: caseSetup,
      success_guidelines: [],
      ...(checks === undefined ? {} : {checks}),
    },
    treatment: {id: treatment, setup: treatmentSetup},
    setup,
    interaction: {
      mode: 'one_shot',
      initial_prompt: prompt,
      initial_prompt_source: 'case.initial_prompt',
      effective_prompt: prompt,
      max_turns: 1,
    },
    evaluation: {
      success_guidelines: [],
      ...(checks === undefined ? {} : {checks}),
    },
    agent: {...agent},
    runtime: {
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
