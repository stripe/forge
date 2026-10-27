import type { AgentPluginInstallationReceipt } from '../../src/contracts/plugin.ts';
import { scoreEvaluation } from '../../src/evaluation/score.ts';
import {
  buildExperimentRunReport,
  summarizeReportEvaluation,
} from '../../src/experimentReport.ts';
import { createTestResolvedRunPlan } from '../../src/testing/plans.ts';

/** Build a real scorecard from installer-produced receipt sets. */
export function reportPluginInstallations(
  installations: readonly (readonly AgentPluginInstallationReceipt[])[],
) {
  return buildExperimentRunReport({
    experimentRunId: 'plugin-comparison',
    generatedAt: '2026-01-01T00:00:00.000Z',
    checkpointBody: '{}',
    runs: installations.map((receipts, index) => ({
      selection_index: index,
      selection: createTestResolvedRunPlan({
        agent: {
          adapter: receipts[0]?.adapter ?? 'test-agent',
          provider: 'test',
          model: 'test',
        },
        treatment: 'plugin',
      }).selection,
      run_id: `run-${index}`,
      state: 'completed',
      error_code: null,
      attempt_count: 1,
      result_path: `runs/run-${index}/result.json`,
      evaluation: summarizeReportEvaluation(scoreEvaluation([], [])),
      plugin_installations: receipts,
    })),
  });
}
