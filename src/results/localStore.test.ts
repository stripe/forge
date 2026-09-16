import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';

import {sha256Digest} from '../model/hashes.js';
import {canonicalJsonSha256} from '../serialization.js';
import {createArtifactStore, verifyCompletedRun} from './localStore.js';
import {parseRunResult} from './parse.js';
import {
  EVALUATION_SCHEMA_VERSION,
  RUN_RESULT_SCHEMA_VERSION,
  type ArtifactDescriptorV1,
  type RunResultV1,
} from './types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('local artifact store', () => {
  it('commits result.json last and verifies every claimed byte', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const store = createArtifactStore({root});
    const transaction = await store.begin('run-1');
    const body = Buffer.from('{}\n');
    await transaction.write({path: 'plan.json', body, mediaType: 'application/json'});
    const artifacts: ArtifactDescriptorV1[] = [{
      path: 'plan.json',
      media_type: 'application/json',
      size_bytes: body.byteLength,
      sha256: `sha256:${'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356'}`,
    }];
    const result = resultFor(artifacts);
    const committed = await transaction.commit(
      result as unknown as Readonly<Record<string, unknown>>,
    );
    await expect(verifyCompletedRun(committed.location)).resolves.toMatchObject({runId: 'run-1'});
  });

  it('rejects duplicate descriptors that omit a staged artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
    roots.push(root);
    const transaction = await createArtifactStore({root}).begin('run-1');
    const first = Buffer.from('{}\n');
    const second = Buffer.from('[]\n');
    await transaction.write({
      path: 'plan.json',
      body: first,
      mediaType: 'application/json',
    });
    await transaction.write({
      path: 'evaluation.json',
      body: second,
      mediaType: 'application/json',
    });
    const descriptor: ArtifactDescriptorV1 = {
      path: 'plan.json',
      media_type: 'application/json',
      size_bytes: first.byteLength,
      sha256: sha256Digest(first),
    };
    const duplicated = [descriptor, descriptor];

    await expect(
      transaction.commit(
        resultFor(duplicated) as unknown as Readonly<Record<string, unknown>>,
      ),
    ).rejects.toThrow('Duplicate claimed artifact');
  });

  it('rejects result schema v1 evidence without provenance', () => {
    const result = resultFor([]);
    const evidenceWithoutProvenance: Record<string, unknown> = {
      ...result.evidence,
    };
    delete evidenceWithoutProvenance.provenance;

    expect(() =>
      parseRunResult({...result, evidence: evidenceWithoutProvenance}),
    ).toThrow();
  });

  it('rejects unsupported result schema versions', () => {
    expect(() => parseRunResult({...resultFor([]), schema_version: 2})).toThrow();
  });

  it('rejects contradictory result-schema-v1 evidence provenance', () => {
    const result = resultFor([]);
    expect(() =>
      parseRunResult({
        ...result,
        evidence: {
          ...result.evidence,
          provenance: {
            ...result.evidence.provenance,
            adapter: {id: 'other-agent', version: '1'},
          },
        },
      }),
    ).toThrow('Evidence provenance does not match the recorded agent adapter');
  });
});

function resultFor(artifacts: ArtifactDescriptorV1[]): RunResultV1 {
  return {
    schema_version: RUN_RESULT_SCHEMA_VERSION,
    run_id: 'run-1',
    selection: {
      case_id: 'sample/case',
      treatment: 'baseline',
      agent: {adapter: 'claude-code', provider: 'anthropic', model: 'test'},
      repetition: 0,
    },
    plan_sha256: `sha256:${'0'.repeat(64)}`,
    forge: {version: '0.1.0'},
    runtime: {
      adapter: 'docker',
      runtime_id: 'run-1',
      platform: 'linux/amd64',
      metadata: {},
    },
    agent: {
      adapter: 'claude-code',
      adapter_version: '1',
      provider: 'anthropic',
      model: 'test',
      session_id: 'session',
      cost_usd: null,
    },
    evidence: {
      format: 'atif',
      schema_version: 'ATIF-v1.8',
      normalization_version: 1,
      provenance: {
        source: {
          kind: 'native_log',
          format: 'claude-code-jsonl',
          session_id: 'session',
        },
        adapter: {id: 'claude-code', version: '1'},
      },
      completeness: 'complete',
      warnings: [],
      redaction_count: 0,
    },
    evaluation: {
      schema_version: EVALUATION_SCHEMA_VERSION,
      score: 0,
      status: 'passed',
      guidelines_passed: 0,
      guidelines_total: 0,
      guidelines: [],
      checks: [],
    },
    started_at: '2026-09-15T00:00:00.000Z',
    completed_at: '2026-09-15T00:00:01.000Z',
    duration_ms: 1000,
    stop_reason: 'completed',
    artifact_set_sha256: canonicalJsonSha256(artifacts),
    artifacts,
    supplemental_artifacts: [],
    warnings: [],
  };
}
