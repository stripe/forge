import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CriterionEvidenceWarningV1 } from '../results/types.ts';
import {
  boundCriterionEvidenceWarnings,
  criterionEvidenceWarnings,
  LONGEST_CAPTURE_STATUS_WARNINGS,
  renderTrajectoryCaptureStatus,
  UNKNOWN_EVIDENCE_WARNINGS,
} from './criterionEvidence.ts';

const warning: CriterionEvidenceWarningV1 = {
  source: 'trajectory',
  code: 'value_omitted',
  message: 'PRIVATE detail',
  path: 'line:1',
};
const trajectory = (code: string): CriterionEvidenceWarningV1[] => [
  { source: 'trajectory', code, message: 'm' },
];

describe('trajectory capture status', () => {
  it('renders fixed text without warning messages or paths', () => {
    const partial = renderTrajectoryCaptureStatus([warning]);
    assert.match(partial, /^Trajectory capture status: partial or fallback/);
    assert.doesNotMatch(partial, /PRIVATE|line:1/);
    assert.match(
      renderTrajectoryCaptureStatus(trajectory('source_unavailable')),
      /native evidence unavailable/,
    );
    assert.equal(
      renderTrajectoryCaptureStatus([]),
      'Trajectory capture status: complete.',
    );
    assert.match(
      renderTrajectoryCaptureStatus(undefined),
      /Trajectory capture status: unknown/,
    );
    assert.match(
      renderTrajectoryCaptureStatus(UNKNOWN_EVIDENCE_WARNINGS),
      /Trajectory capture status: unknown/,
    );
  });

  it('ignores workspace warnings in the trajectory line', () => {
    assert.equal(
      renderTrajectoryCaptureStatus([{ ...warning, source: 'workspace' }]),
      'Trajectory capture status: complete.',
    );
  });

  it('reserves the longest capture-status line for every evidence source', () => {
    const reserved = Buffer.byteLength(
      renderTrajectoryCaptureStatus(LONGEST_CAPTURE_STATUS_WARNINGS),
    );
    for (const warnings of [
      undefined,
      [],
      UNKNOWN_EVIDENCE_WARNINGS,
      trajectory('trajectory_incomplete'),
      trajectory('value_omitted'),
      trajectory('source_unavailable'),
    ])
      assert.ok(
        Buffer.byteLength(renderTrajectoryCaptureStatus(warnings)) <= reserved,
      );
  });
});

describe('criterion evidence warnings', () => {
  it('derives warnings from completeness and adapter warnings', () => {
    assert.deepEqual(
      criterionEvidenceWarnings({
        trajectory: { completeness: 'complete', warnings: [] },
        workspace: { complete: true, warnings: [] },
      }),
      [],
    );
    const derived = criterionEvidenceWarnings({
      trajectory: {
        completeness: 'fallback',
        warnings: [{ code: 'value_omitted', message: 'm', path: 'line:2' }],
      },
      workspace: {
        complete: false,
        warnings: [{ code: 'workspace_file_truncated', message: 'm' }],
      },
    });
    assert.deepEqual(
      derived.map(({ source, code }) => `${source}:${code}`),
      [
        'trajectory:trajectory_incomplete',
        'trajectory:value_omitted',
        'workspace:workspace_incomplete',
        'workspace:workspace_file_truncated',
      ],
    );
  });

  it('marks an unrecorded trajectory as unknown without claiming it is incomplete', () => {
    assert.deepEqual(
      criterionEvidenceWarnings({
        workspace: { complete: false, warnings: [] },
      }).map(({ source, code }) => `${source}:${code}`),
      ['trajectory:evidence_completeness_unknown', 'workspace:workspace_incomplete'],
    );
  });

  it('bounds the list with a stable explicit marker', () => {
    const warnings = Array.from({ length: 100 }, () => warning);
    const bounded = boundCriterionEvidenceWarnings(warnings);
    assert.equal(bounded.length, 64);
    assert.equal(bounded.at(-1)?.code, 'evidence_warnings_truncated');
    assert.deepEqual(boundCriterionEvidenceWarnings(bounded), bounded);
    const oversized = boundCriterionEvidenceWarnings([
      { ...warning, message: 'x'.repeat(64 * 1024) },
    ]);
    assert.equal(oversized[0]?.code, 'evidence_warnings_truncated');
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 16 * 1024);
  });
});
