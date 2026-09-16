import {describe, it} from 'node:test';

import {expect} from '../test/support/expect.js';

import {
  createArtifactStore,
  createSetupExecutor,
  credentialReference,
  evaluateRunEvidence,
  executeEval,
  parseResolvedRunPlan,
  resolveManifestCaseIdFromFile,
  resolveRunPlan,
  type AgentAdapter,
  type ForgeComposition,
  type RuntimeAdapter,
} from './index.js';

describe('@stripe/forge package root', () => {
  it('exports the engine, wire model, persistence, and extension contracts', () => {
    expect(executeEval).toBeTypeOf('function');
    expect(evaluateRunEvidence).toBeTypeOf('function');
    expect(resolveRunPlan).toBeTypeOf('function');
    expect(parseResolvedRunPlan).toBeTypeOf('function');
    expect(resolveManifestCaseIdFromFile).toBeTypeOf('function');
    expect(createArtifactStore).toBeTypeOf('function');
    expect(createSetupExecutor).toBeTypeOf('function');
    expect(credentialReference).toBeTypeOf('function');

    const acceptsPublicContracts = (
      _agent: AgentAdapter,
      _runtime: RuntimeAdapter,
      _composition: ForgeComposition,
    ): void => undefined;
    expect(acceptsPublicContracts).toBeTypeOf('function');
  });
});
