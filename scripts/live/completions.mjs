import * as path from 'node:path';

/** Real host completions through the complete lifecycle, with deterministic agent work. */
export async function runOpenAICompletionSuite(options, suppliedForge) {
  const forge =
    suppliedForge ??
    Object.assign(
      {},
      await import('../../dist/index.js'),
      await import('../../dist/testing/index.js'),
      await import('../../dist/providers/openai/index.js'),
    );
  const {
    completionModel,
    upstreamCredential,
    gatewayBaseUrl,
    resultsRoot,
    suiteId,
    signal,
    progress,
  } = options;
  const model = { provider: 'openai', model: completionModel };
  const provider = forge.createOpenAICompletionProvider({
    ...(gatewayBaseUrl === undefined ? {} : { baseUrl: gatewayBaseUrl }),
  });
  const schemas = [];
  const completionProvider = {
    ...provider,
    async complete(request, context) {
      schemas.push(request.responseSchema?.name);
      return provider.complete(request, context);
    },
  };
  const agent = forge.createScriptedAgentAdapter({
    turns: [
      {
        text: 'HELLO',
        sessionId: 'completion-live-session',
        toolCalls: [],
      },
    ],
  });
  const runtime = forge.createFakeRuntimeAdapter();
  const plan = forge.parseResolvedRunPlan({
    ...forge.createTestResolvedRunPlan({
      mode: 'multi_turn',
      maxTurns: 1,
      prompt:
        'Ask the coding assistant to reply with exactly HELLO. No files or other work are needed.',
      rolePlayer: model,
      judge: model,
      judgingCriteria: ['The coding assistant replied with exactly HELLO.'],
    }),
    limits: { run_timeout_ms: 180000 },
  });
  progress(
    'checking real OpenAI Ava initialization, continuation, and criterion judgment',
  );
  const completed = await forge.executeEval({
    runId: `${suiteId}-completions`,
    plan,
    signal,
    composition: {
      runtime: runtime.adapter,
      agents: new Map([[agent.adapter.id, agent.adapter]]),
      completionProviders: new Map([[provider.id, completionProvider]]),
      credentialResolver: forge.createStaticCredentialResolver({
        'openai.completion-api-key': upstreamCredential,
      }),
      inputProvider: forge.createMemoryRunInputProvider(),
      artifactStore: forge.createArtifactStore({ root: resultsRoot }),
    },
  });
  const verified = await forge.verifyCompletedRun(completed.location);
  const { result } = verified;
  if (
    result.failure !== null ||
    result.stop_reason !== 'task_complete' ||
    result.evaluation.status !== 'passed' ||
    result.evaluation.score !== 1 ||
    result.completion_calls.length !== 3 ||
    !result.completion_calls.every((call) => call.status === 'succeeded') ||
    schemas.join(',') !== 'ava_initial_turn,ava_turn,criterion_judgment'
  ) {
    throw new Error(
      `Live host completion validation failed; inspect ${path.join(completed.location, 'result.json')}.`,
    );
  }
  return {
    verified: true,
    suite_id: suiteId,
    mode: 'completions',
    model,
    schemas,
    location: completed.location,
    evaluation: result.evaluation.status,
    coding_agent: 'scripted',
    runtime: 'in_memory',
  };
}
