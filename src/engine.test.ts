import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../test/support/expect.js';

import {credentialReference} from './contracts/credentials.js';
import type {ForgeComposition} from './contracts/composition.js';
import {createForgeEngine, defaultForgeEngine} from './engine.js';
import type {
  JsonObject,
  LoadedDatasetV1,
  LoadedExperimentConfigV1,
  RunSelection,
  SetupActionBundleReferenceV1,
} from './model/types.js';
import {
  resolvedRunPlanSha256,
  serializeResolvedRunPlan,
} from './planning/index.js';
import {createArtifactStore, verifyCompletedRun} from './results/index.js';
import {
  createFakeRuntimeAdapter,
  createMemoryArtifactStore,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createStaticCredentialResolver,
} from './testing/index.js';
import {
  defineSetupActionBundle,
  type SetupActionBundle,
  type SetupActionDefinition,
} from './setup/registry.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SECOND_DIGEST = `sha256:${'d'.repeat(64)}` as const;
const CASE_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const EXPERIMENT_DIGEST = `sha256:${'c'.repeat(64)}` as const;
const BUNDLE_REFERENCE: SetupActionBundleReferenceV1 = {
  namespace: 'acme-evals',
  version: '2026.9.0',
  sha256: DIGEST,
};
const SECOND_BUNDLE_REFERENCE: SetupActionBundleReferenceV1 = {
  namespace: 'zeta-evals',
  version: '1.2.0',
  sha256: SECOND_DIGEST,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {recursive: true, force: true}),
    ),
  );
});

describe('ForgeEngine setup action bundles', () => {
  it('keeps extension names absent from and unavailable to the default engine', () => {
    expect(defaultForgeEngine.setupActionIds).toEqual([
      'forge/command',
      'forge/plugin',
      'forge/write',
    ]);
    expect(() =>
      defaultForgeEngine.parseSetupStep({
        uses: 'acme-evals/skill',
        with: {name: 'example'},
      }),
    ).toThrow(/unknown setup action/);
  });

  it('validates, normalizes, clones, and freezes extension payloads', () => {
    const input = {name: ' example-skill '};
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const parsed = engine.parseSetupStep({
      uses: 'acme-evals/skill',
      with: input,
    });

    expect(parsed).toEqual({
      uses: 'acme-evals/skill',
      with: {name: 'example-skill'},
    });
    expect(parsed.with).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.with)).toBe(true);
    input.name = 'changed';
    expect(parsed.with.name).toBe('example-skill');
  });

  it('rejects an action normalizer which does not reach a fixed point', () => {
    const unstable = skillAction();
    unstable.parseWith = (input) => {
      if (
        input === null ||
        typeof input !== 'object' ||
        typeof (input as {name?: unknown}).name !== 'string'
      ) {
        throw new TypeError('skill input is invalid');
      }
      return {name: `skills/${(input as {name: string}).name}`};
    };
    const engine = createForgeEngine({
      setupActionBundles: [
        defineSetupActionBundle({
          manifest: BUNDLE_REFERENCE,
          actions: [unstable],
        }),
      ],
    });

    expect(() =>
      engine.parseSetupStep({
        uses: 'acme-evals/skill',
        with: {name: 'example-skill'},
      }),
    ).toThrow(/did not produce a stable canonical with payload/);
  });

  it('rejects an action parser which cannot accept its canonical output', () => {
    const authoredOnly = skillAction();
    authoredOnly.parseWith = (input) => {
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'name') ||
        typeof (input as {name?: unknown}).name !== 'string'
      ) {
        throw new TypeError('skill input is invalid');
      }
      const name = (input as {name: string}).name;
      return {name, destination: `.agent/skills/${name}`};
    };
    const engine = createForgeEngine({
      setupActionBundles: [
        defineSetupActionBundle({
          manifest: BUNDLE_REFERENCE,
          actions: [authoredOnly],
        }),
      ],
    });

    expect(() =>
      engine.parseSetupStep({
        uses: 'acme-evals/skill',
        with: {name: 'example-skill'},
      }),
    ).toThrow(/did not produce a stable canonical with payload/);
  });

  it('pins only the extension bundle used by the selected plan', () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const inputs = planningInputs(engine);
    const extensionPlan = engine.resolveRunPlan({
      ...inputs,
      selection: selection('with-skill'),
    });
    const baselinePlan = engine.resolveRunPlan({
      ...inputs,
      selection: selection('baseline'),
    });

    expect(extensionPlan.provenance.forge.action_bundles).toEqual([
      BUNDLE_REFERENCE,
    ]);
    expect(baselinePlan.provenance.forge.action_bundles).toBeUndefined();
    expect(() => defaultForgeEngine.parseResolvedRunPlan(extensionPlan)).toThrow(
      /unknown setup action/,
    );
    expect(engine.parseResolvedRunPlan(extensionPlan)).toEqual(extensionPlan);
  });

  it('binds case-owned extension actions to the experiment pin at planning', () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const inputs = planningInputs(engine);
    const loadedCase = inputs.dataset.cases.get('testing/action-bundle')!;
    const dataset: LoadedDatasetV1 = {
      ...inputs.dataset,
      cases: new Map([
        [
          loadedCase.definition.id,
          {
            ...loadedCase,
            definition: {
              ...loadedCase.definition,
              setup: [
                engine.parseSetupStep({
                  uses: 'acme-evals/skill',
                  with: {name: 'case-skill'},
                }),
              ],
            },
          },
        ],
      ]),
    };

    const plan = engine.resolveRunPlan({
      dataset,
      experiment: inputs.experiment,
      selection: selection('baseline'),
    });

    expect(plan.setup).toEqual([
      {uses: 'acme-evals/skill', with: {name: 'case-skill'}},
    ]);
    expect(plan.provenance.forge.action_bundles).toEqual([
      BUNDLE_REFERENCE,
    ]);
  });

  it('rejects unknown actions in preconstructed planning inputs', () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const inputs = planningInputs(engine);
    const experiment = structuredClone(inputs.experiment);
    experiment.config.treatments['with-skill']!.setup = [
      {uses: 'other-evals/skill', with: {name: 'example-skill'}},
    ];

    expect(() =>
      engine.resolveRunPlan({
        dataset: inputs.dataset,
        experiment,
        selection: selection('with-skill'),
      }),
    ).toThrow(/Selected setup actions do not match/);
  });

  it('rejects noncanonical actions in preconstructed planning inputs', () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const inputs = planningInputs(engine);
    const experiment = structuredClone(inputs.experiment);
    experiment.config.treatments['with-skill']!.setup[0]!.with.name =
      ' example-skill ';

    expect(() =>
      engine.resolveRunPlan({
        dataset: inputs.dataset,
        experiment,
        selection: selection('with-skill'),
      }),
    ).toThrow(/with payload is not canonical/);
  });

  it('rejects absent or mismatched experiment bundle pins', () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const {forge: _forge, ...missingPin} = experimentValue();
    expect(() => engine.parseExperimentConfig(missingPin)).toThrow(
      /bundle references do not match/,
    );

    const mismatched = experimentValue();
    mismatched.forge.action_bundles[0]!.sha256 =
      `sha256:${'d'.repeat(64)}`;
    expect(() => engine.parseExperimentConfig(mismatched)).toThrow(
      /bundle references do not match/,
    );
  });

  it('rejects malformed and duplicate bundle declarations', () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const empty = experimentValue();
    empty.forge.action_bundles = [];
    expect(() => engine.parseExperimentConfig(empty)).toThrow();

    const duplicate = experimentValue();
    duplicate.forge.action_bundles.push({...BUNDLE_REFERENCE});
    expect(() => engine.parseExperimentConfig(duplicate)).toThrow(/unique/);

    const malformed = experimentValue();
    malformed.forge.action_bundles[0] = {
      ...BUNDLE_REFERENCE,
      version: 'not a version with spaces',
    };
    expect(() => engine.parseExperimentConfig(malformed)).toThrow();
  });

  it('emits and requires canonical bundle-reference order in resolved plans', () => {
    const engine = createForgeEngine({
      setupActionBundles: [secondBundle(), testBundle()],
    });
    const base = experimentValue();
    const value = {
      ...base,
      forge: {
        ...base.forge,
        action_bundles: [
          {...SECOND_BUNDLE_REFERENCE},
          {...BUNDLE_REFERENCE},
        ],
      },
      treatments: {
        ...base.treatments,
        'with-two-actions': {
          setup: [
            {uses: 'zeta-evals/tool', with: {name: 'tool'}},
            {uses: 'acme-evals/skill', with: {name: 'example-skill'}},
          ],
        },
      },
      matrix: {...base.matrix, treatments: ['with-two-actions']},
    };
    const plan = engine.resolveRunPlan({
      ...planningInputs(engine, value),
      selection: selection('with-two-actions'),
    });

    expect(plan.provenance.forge.action_bundles).toEqual([
      BUNDLE_REFERENCE,
      SECOND_BUNDLE_REFERENCE,
    ]);

    const reordered = structuredClone(plan);
    reordered.provenance.forge.action_bundles!.reverse();
    expect(() => engine.parseResolvedRunPlan(reordered)).toThrow(
      /exact canonical set/,
    );
  });

  it('rejects a noncanonical action payload in a resolved plan', () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const plan = engine.resolveRunPlan({
      ...planningInputs(engine),
      selection: selection('with-skill'),
    });
    const noncanonical = structuredClone(plan);
    noncanonical.treatment.setup[0]!.with.name = ' example-skill ';
    noncanonical.setup[0]!.with.name = ' example-skill ';

    expect(() => engine.parseResolvedRunPlan(noncanonical)).toThrow(
      /with payload is not canonical/,
    );
  });

  it('executes a registered action with its exact setup credential projection', async () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const plan = engine.resolveRunPlan({
      ...planningInputs(engine),
      selection: selection('with-skill'),
    });
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter();
    const artifacts = createMemoryArtifactStore();
    const composition: ForgeComposition = {
      runtime: runtime.adapter,
      agents: new Map([[agent.adapter.id, agent.adapter]]),
      credentialResolver: createStaticCredentialResolver({
        'acme-evals.setup-token': 'setup-secret',
      }),
      inputProvider: createMemoryRunInputProvider(),
      artifactStore: artifacts.store,
    };

    const completed = await engine.executeEval({
      runId: 'action-bundle-run',
      plan,
      composition,
    });

    expect(completed.result.forge.action_bundles).toEqual([
      BUNDLE_REFERENCE,
    ]);
    expect(runtime.runs[0]?.commands).toEqual([
      expect.objectContaining({
        scope: 'setup',
        credentialEnvironmentNames: ['ACME_SETUP_TOKEN'],
        argv: ['install-skill', 'example-skill'],
      }),
    ]);
  });

  it('uses the same action registry when verifying a completed local result', async () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const plan = engine.resolveRunPlan({
      ...planningInputs(engine),
      selection: selection('with-skill'),
    });
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-engine-test-'));
    temporaryDirectories.push(root);
    const completed = await engine.executeEval({
      runId: 'action-bundle-local-result',
      plan,
      composition: {
        runtime: runtime.adapter,
        agents: new Map([[agent.adapter.id, agent.adapter]]),
        credentialResolver: createStaticCredentialResolver({
          'acme-evals.setup-token': 'setup-secret',
        }),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: createArtifactStore({root}),
      },
    });

    const persistedPlan = await fs.readFile(
      path.join(completed.location, 'plan.json'),
      'utf8',
    );
    expect(persistedPlan).toBe(serializeResolvedRunPlan(plan));
    expect(completed.result.plan_sha256).toBe(resolvedRunPlanSha256(plan));

    await expect(engine.verifyCompletedRun(completed.location)).resolves.toMatchObject({
      runId: 'action-bundle-local-result',
    });
    await expect(verifyCompletedRun(completed.location)).rejects.toThrow(
      /Completed plan.json does not match its schema/,
    );
  });

  it('rejects bundle drift before credential resolution or runtime allocation', async () => {
    const engine = createForgeEngine({setupActionBundles: [testBundle()]});
    const plan = engine.resolveRunPlan({
      ...planningInputs(engine),
      selection: selection('with-skill'),
    });
    const drifted = structuredClone(plan);
    drifted.provenance.forge.action_bundles![0]!.sha256 = SECOND_DIGEST;
    const runtime = createFakeRuntimeAdapter();
    const agent = createScriptedAgentAdapter();
    let credentialResolutions = 0;

    await expect(
      engine.executeEval({
        runId: 'action-bundle-drift',
        plan: drifted,
        composition: {
          runtime: runtime.adapter,
          agents: new Map([[agent.adapter.id, agent.adapter]]),
          credentialResolver: {
            async resolve() {
              credentialResolutions += 1;
              return 'must-not-resolve';
            },
          },
          inputProvider: createMemoryRunInputProvider(),
          artifactStore: createMemoryArtifactStore().store,
        },
      }),
    ).rejects.toMatchObject({code: 'invalid_plan', phase: 'preflight'});
    expect(credentialResolutions).toBe(0);
    expect(runtime.runs).toEqual([]);
  });

  it('snapshots bundle definitions and rejects unsafe ownership', () => {
    const mutableAction = skillAction();
    const bundle = {
      manifest: {...BUNDLE_REFERENCE},
      actions: [mutableAction],
    } satisfies SetupActionBundle;
    const engine = createForgeEngine({setupActionBundles: [bundle]});
    bundle.manifest.version = 'changed';
    bundle.actions = [];
    mutableAction.parseWith = () => ({name: 'changed'});

    expect(engine.setupActionBundles).toEqual([BUNDLE_REFERENCE]);
    expect(
      engine.parseSetupStep({
        uses: 'acme-evals/skill',
        with: {name: 'original'},
      }).with.name,
    ).toBe('original');

    expect(() =>
      defineSetupActionBundle({
        manifest: {...BUNDLE_REFERENCE, namespace: 'forge'},
        actions: [
          {...skillAction(), uses: 'forge/private'},
        ],
      }),
    ).toThrow(/reserved namespace/);
    expect(() =>
      defineSetupActionBundle({
        manifest: BUNDLE_REFERENCE,
        actions: [{...skillAction(), uses: 'other/skill'}],
      }),
    ).toThrow(/outside bundle namespace/);
    expect(() =>
      defineSetupActionBundle({
        manifest: BUNDLE_REFERENCE,
        actions: [{...skillAction(), uses: 'acme-evals/skill@1'}],
      }),
    ).toThrow(/invalid/);
  });

  it('rejects duplicate bundle namespaces and action IDs', () => {
    expect(() =>
      createForgeEngine({setupActionBundles: [testBundle(), testBundle()]}),
    ).toThrow(/Duplicate setup action bundle namespace/);
    expect(() =>
      defineSetupActionBundle({
        manifest: BUNDLE_REFERENCE,
        actions: [skillAction(), skillAction()],
      }),
    ).toThrow(/Duplicate setup action/);
  });

  it('rejects non-JSON action parser output at the model boundary', () => {
    const malformed = skillAction();
    malformed.parseWith = () => new Date() as unknown as SkillWith;
    const engine = createForgeEngine({
      setupActionBundles: [
        defineSetupActionBundle({
          manifest: BUNDLE_REFERENCE,
          actions: [malformed],
        }),
      ],
    });

    expect(() =>
      engine.parseSetupStep({
        uses: 'acme-evals/skill',
        with: {name: 'example'},
      }),
    ).toThrow(/plain JSON objects/);
  });

  it('bounds action input before parsing and bounds normalized output', () => {
    const inputAction = skillAction();
    const parseInput = inputAction.parseWith;
    let parseCalls = 0;
    inputAction.parseWith = (input) => {
      parseCalls += 1;
      return parseInput(input);
    };
    const inputEngine = createForgeEngine({
      setupActionBundles: [
        defineSetupActionBundle({
          manifest: BUNDLE_REFERENCE,
          actions: [inputAction],
        }),
      ],
    });
    expect(() =>
      inputEngine.parseSetupStep({
        uses: 'acme-evals/skill',
        with: {name: 'x'.repeat(1024 * 1024)},
      }),
    ).toThrow(/byte limit/);
    expect(parseCalls).toBe(0);

    const outputAction = skillAction();
    outputAction.parseWith = () => ({name: 'x'.repeat(1024 * 1024)});
    const outputEngine = createForgeEngine({
      setupActionBundles: [
        defineSetupActionBundle({
          manifest: BUNDLE_REFERENCE,
          actions: [outputAction],
        }),
      ],
    });
    expect(() =>
      outputEngine.parseSetupStep({
        uses: 'acme-evals/skill',
        with: {name: 'small'},
      }),
    ).toThrow(/byte limit/);
  });
});

function testBundle(): SetupActionBundle {
  return defineSetupActionBundle({
    manifest: BUNDLE_REFERENCE,
    actions: [skillAction()],
  });
}

function secondBundle(): SetupActionBundle {
  return defineSetupActionBundle({
    manifest: SECOND_BUNDLE_REFERENCE,
    actions: [toolAction()],
  });
}

interface SkillWith extends JsonObject {
  name: string;
}

function skillAction(): SetupActionDefinition<SkillWith> {
  return {
    uses: 'acme-evals/skill',
    parseWith(input) {
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'name') ||
        typeof (input as {name?: unknown}).name !== 'string'
      ) {
        throw new TypeError('skill input is invalid');
      }
      const name = (input as {name: string}).name.trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new TypeError('skill name is invalid');
      }
      return {name};
    },
    preflight(step) {
      const name = step.with.name;
      return {
        requirements: {
          credentials: {
            setup: {
              ACME_SETUP_TOKEN: {
                reference: credentialReference('acme-evals.setup-token'),
              },
            },
          },
        },
        async apply(context) {
          await context.commands.run(['install-skill', name]);
        },
      };
    },
  };
}

function toolAction(): SetupActionDefinition<SkillWith> {
  return {
    uses: 'zeta-evals/tool',
    parseWith(input) {
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'name') ||
        typeof (input as {name?: unknown}).name !== 'string'
      ) {
        throw new TypeError('tool input is invalid');
      }
      return {name: (input as {name: string}).name};
    },
    preflight() {
      return {requirements: {}, async apply() {}};
    },
  };
}

function planningInputs(
  engine: ReturnType<typeof createForgeEngine>,
  experiment: unknown = experimentValue(),
): {
  dataset: LoadedDatasetV1;
  experiment: LoadedExperimentConfigV1;
} {
  const definition = engine.parseEvalCase({
    schema_version: 1,
    id: 'testing/action-bundle',
    initial_prompt: 'Complete the task.',
    execution_mode: 'one_shot',
    setup: [],
    success_guidelines: [],
  });
  const config = engine.parseExperimentConfig(experiment);
  return {
    dataset: {
      root: '/dataset',
      manifestPath: '/dataset/manifest.json',
      manifestRaw: '{}',
      manifestSha256: DIGEST,
      manifest: {
        schema_version: 1,
        dataset: {id: 'testing', version: '1.0.0'},
        cases: [
          {
            id: definition.id,
            path: 'cases/testing/action-bundle.yaml',
          },
        ],
        files: [
          {
            path: 'cases/testing/action-bundle.yaml',
            size: 1,
            sha256: CASE_DIGEST.slice('sha256:'.length),
          },
        ],
      },
      cases: new Map([
        [
          definition.id,
          {
            definition,
            path: '/dataset/cases/testing/action-bundle.yaml',
            sha256: CASE_DIGEST,
          },
        ],
      ]),
    },
    experiment: {
      path: '/experiment.yaml',
      root: '/',
      raw: 'experiment',
      sha256: EXPERIMENT_DIGEST,
      config,
    },
  };
}

function experimentValue() {
  return {
    schema_version: 1 as const,
    id: 'testing/action-bundles',
    version: '1.0.0',
    dataset: {
      id: 'testing',
      version: '1.0.0',
      manifest_sha256: DIGEST,
    },
    forge: {
      action_bundles: [{...BUNDLE_REFERENCE}],
    },
    runtime: {
      adapter: 'docker' as const,
      image: {kind: 'forge' as const},
      platform: 'linux/amd64' as const,
      resources: {
        memory_bytes: 1024,
        cpu_count: 1,
        process_count: 8,
      },
    },
    models: {},
    treatments: {
      'with-skill': {
        setup: [
          {
            uses: 'acme-evals/skill',
            with: {name: 'example-skill'},
          },
        ],
      },
    },
    matrix: {
      cases: ['testing/action-bundle'],
      treatments: ['baseline', 'with-skill'],
      agents: [
        {
          adapter: 'test-agent',
          provider: 'test-provider',
          model: 'test-model',
        },
      ],
      repetitions: 1,
      retries: 0,
    },
    limits: {run_timeout_ms: 30_000},
  };
}

function selection(treatment: string): RunSelection {
  return {
    case_id: 'testing/action-bundle',
    treatment,
    agent: {
      adapter: 'test-agent',
      provider: 'test-provider',
      model: 'test-model',
    },
    repetition: 0,
  };
}
