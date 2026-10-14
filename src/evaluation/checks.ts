import {runInNewContext} from 'node:vm';

import type {AtifTrajectoryV1_8} from '../atif/index.js';
import type {ReadonlyWorkspace} from '../contracts/runtime.js';
import type {ChecksV1, ResolvedRunPlanV1} from '../model/types.js';
import {
  type CheckResultV1,
  type EvaluationResultV1,
  type CriterionResultV1,
  type WorkspaceEvidenceEntryV1,
  type WorkspaceEvidenceV1,
} from '../results/index.js';
import {scoreEvaluation, criterionResultMatchesDefinition} from './score.js';

const MAX_CHECK_FILE_BYTES = 256_000;
const MAX_REGEX_BYTES = 1_024;
const MAX_REGEX_EXECUTION_MS = 100;

export interface EvaluateRunEvidenceInput {
  readonly plan: ResolvedRunPlanV1;
  readonly trajectory: AtifTrajectoryV1_8;
  readonly workspace: ReadonlyWorkspace;
  /** Results produced by the configured judge for the plan's exact criteria. */
  readonly criterionResults?: readonly CriterionResultV1[];
  readonly signal?: AbortSignal;
}

export interface EvaluatedRunEvidence {
  readonly evaluation: EvaluationResultV1;
  readonly workspaceEvidence: WorkspaceEvidenceV1;
}

/** Evaluate canonical ATIF and sealed-workspace evidence. */
export async function evaluateRunEvidence(
  input: EvaluateRunEvidenceInput,
): Promise<EvaluatedRunEvidence> {
  input.signal?.throwIfAborted();
  const expectedCriteria = input.plan.evaluation.judging_criteria;
  if (expectedCriteria.length > 0 && input.criterionResults === undefined) {
    throw new UnsupportedEvaluationCapabilityError(
      'Criterion results are required to evaluate this run.',
    );
  }
  const criterionResults = [...(input.criterionResults ?? [])];
  if (
    criterionResults.length !== expectedCriteria.length ||
    criterionResults.some(
      (result, index) => !criterionResultMatchesDefinition(result, expectedCriteria[index]!),
    )
  ) {
    throw new TypeError(
      'Criterion results must correspond exactly to the resolved plan.',
    );
  }
  // Touch the canonical discriminator so callers cannot accidentally supply a
  // parallel native-transcript shape without TypeScript noticing.
  if (input.trajectory.schema_version !== 'ATIF-v1.8') {
    throw new UnsupportedEvaluationCapabilityError('Unsupported ATIF version.');
  }
  const workspaceEvidence = await collectWorkspaceEvidence(
    input.workspace,
    input.plan.evaluation.checks,
    input.signal,
  );
  const checks = runWorkspaceChecks(
    input.plan.evaluation.checks,
    workspaceEvidence,
  );
  return {
    workspaceEvidence,
    evaluation: scoreEvaluation(criterionResults, checks),
  };
}

export async function collectWorkspaceEvidence(
  workspace: ReadonlyWorkspace,
  checks: ChecksV1 | undefined,
  signal?: AbortSignal,
): Promise<WorkspaceEvidenceV1> {
  signal?.throwIfAborted();
  const requestedPaths = new Set<string>([
    ...(checks?.files_created ?? []),
    ...(checks?.file_checks ?? []).map(({file}) => file),
  ]);
  const entries: WorkspaceEvidenceEntryV1[] = [];
  const warnings: Array<{code: string; message: string; path?: string}> = [];
  let complete = true;

  for (const requestedPath of [...requestedPaths].sort(compareStrings)) {
    signal?.throwIfAborted();
    let inspected: Awaited<ReturnType<ReadonlyWorkspace['inspect']>> | undefined;
    try {
      inspected = await workspace.inspect(requestedPath);
      signal?.throwIfAborted();
      if (inspected.kind !== 'file') {
        entries.push({
          path: requestedPath,
          exists: inspected.kind !== 'absent',
          kind:
            inspected.kind === 'absent'
              ? 'missing'
              : inspected.kind === 'directory'
                ? 'directory'
                : 'other',
          ...(inspected.size === undefined ? {} : {size_bytes: inspected.size}),
          ...(inspected.kind === 'symlink'
            ? {issue: 'Symbolic links are not valid grading evidence.'}
            : {}),
        });
        continue;
      }
      const body = await workspace.readFile(requestedPath, {
        maxBytes: MAX_CHECK_FILE_BYTES,
      });
      signal?.throwIfAborted();
      entries.push({
        path: requestedPath,
        exists: true,
        kind: 'file',
        size_bytes: body.byteLength,
        content_base64: Buffer.from(body).toString('base64'),
      });
    } catch (error) {
      signal?.throwIfAborted();
      complete = false;
      const message = safeEvidenceError(error);
      entries.push({
        path: requestedPath,
        exists: inspected?.kind === 'file',
        kind: inspected?.kind === 'file' ? 'file' : 'missing',
        ...(inspected?.size === undefined ? {} : {size_bytes: inspected.size}),
        issue: message,
      });
      warnings.push({code: 'workspace_evidence_unavailable', message, path: requestedPath});
    }
  }

  return {
    entries,
    complete,
    warnings,
  };
}

export function runWorkspaceChecks(
  checks: ChecksV1 | undefined,
  evidence: WorkspaceEvidenceV1,
): CheckResultV1[] {
  if (!checks) return [];
  const byPath = new Map(evidence.entries.map((entry) => [entry.path, entry]));
  const results: CheckResultV1[] = [];

  for (const file of checks.files_created ?? []) {
    const entry = byPath.get(file);
    const passed = entry?.exists === true && entry.kind !== 'other';
    results.push({
      name: `file_created: ${file}`,
      passed,
      ...(passed ? {} : {detail: entry?.issue ?? `Not found: ${file}`}),
    });
  }

  for (const check of checks.file_checks ?? []) {
    const entry = byPath.get(check.file);
    const expectedExists = check.exists;
    const exists = entry?.exists === true;
    const label = check.description ?? check.file;
    const existencePasses = entry !== undefined && (expectedExists
      ? exists
      : !exists && entry.issue === undefined);
    results.push({
      name: expectedExists ? `file_exists: ${label}` : `file_absent: ${label}`,
      passed: existencePasses,
      ...(existencePasses
        ? {}
        : {
            detail: expectedExists
              ? (entry?.issue ?? `Not found: ${check.file}`)
              : (entry?.issue ?? `Should not exist: ${check.file}`),
          }),
    });

    if (expectedExists && check.contains !== undefined && exists) {
      const contentResult = evaluateContains(entry, check.contains);
      results.push({
        name: `file_contains: ${label} /${check.contains}/`,
        passed: contentResult.passed,
        ...(contentResult.detail === undefined ? {} : {detail: contentResult.detail}),
      });
    }
  }
  return results;
}

export class UnsupportedEvaluationCapabilityError extends Error {
  readonly code = 'unsupported_evaluation_capability' as const;
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEvaluationCapabilityError';
  }
}

function evaluateContains(
  entry: WorkspaceEvidenceEntryV1 | undefined,
  pattern: string,
): {passed: boolean; detail?: string} {
  if (!entry || entry.kind !== 'file' || entry.content_base64 === undefined) {
    return {passed: false, detail: entry?.issue ?? 'File content was not captured.'};
  }
  if (Buffer.byteLength(pattern, 'utf8') > MAX_REGEX_BYTES) {
    return {passed: false, detail: `Pattern exceeds ${MAX_REGEX_BYTES} bytes.`};
  }
  try {
    RegExp(pattern);
  } catch {
    return {passed: false, detail: 'Invalid regular expression syntax.'};
  }
  const content = Buffer.from(entry.content_base64, 'base64').toString('utf8');
  try {
    const passed = runInNewContext(
      'new RegExp(pattern).test(content)',
      {pattern, content},
      {
        timeout: MAX_REGEX_EXECUTION_MS,
        contextCodeGeneration: {strings: false, wasm: false},
      },
    );
    return passed === true
      ? {passed: true}
      : {passed: false, detail: `Pattern not found in ${entry.path}.`};
  } catch {
    return {passed: false, detail: 'Regular expression evaluation failed or timed out.'};
  }
}

function safeEvidenceError(error: unknown): string {
  if (error instanceof Error && /exceed|limit/i.test(error.message)) {
    return 'Workspace evidence exceeded its byte limit.';
  }
  return 'Workspace evidence could not be read safely.';
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
