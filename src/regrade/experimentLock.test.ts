import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import type { CompletionRequest } from '../contracts/completion.ts';
import { defaultForgeEngine } from '../engine.ts';
import { runExperiment } from '../experiment.ts';
import { createArtifactStore } from '../results/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedAgentAdapter,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../testing/index.ts';
import { ORIGINAL_JUDGMENT, temporaryRoot } from './__tests__/judgedFixture.ts';
import { regradeExperimentRun } from './experiment.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function savedExperiment(root: string) {
  const source = path.join(root, 'source');
  const judge = { provider: 'test-provider', model: 'original-judge' };
  const agent = createScriptedAgentAdapter({
    turns: Array.from({ length: 3 }, () => ({
      text: 'Completed the task.',
      sessionId: 'source-session',
      toolCalls: [],
    })),
  });
  const completion = createScriptedCompletionProvider({
    responses: Array.from({ length: 3 }, () => ORIGINAL_JUDGMENT),
  });
  const composition = {
    runtime: createFakeRuntimeAdapter().adapter,
    agents: new Map([[agent.adapter.id, agent.adapter]]),
    completionProviders: new Map([
      [completion.provider.id, completion.provider],
    ]),
    credentialResolver: createStaticCredentialResolver(),
    inputProvider: createMemoryRunInputProvider(),
    artifactStore: createArtifactStore({ root: source }),
  };
  let run = 0;
  const summary = await runExperiment({
    root: source,
    plans: Array.from({ length: 3 }, (_, index) =>
      createTestResolvedRunPlan({
        caseId: `testing/drain-${index}`,
        judgingCriteria: ['Complete the task.'],
        judge,
      }),
    ),
    composition,
    engine: defaultForgeEngine,
    resume: false,
    signal: new AbortController().signal,
    execute: (input) => defaultForgeEngine.executeEval(input),
    runIdFactory: () => `source-${++run}`,
    progress: () => {},
  });
  assert.equal(summary.completed, 3);
  return source;
}

describe('regrade worker lock lifetime', () => {
  for (const lateFailure of [false, true]) {
    it(`drains a ${lateFailure ? 'rejecting' : 'fulfilling'} judge after worker failure before releasing the lock`, async () => {
      const root = await temporaryRoot('forge-regrade-drain-');
      roots.push(root);
      const source = await savedExperiment(root);
      const output = path.join(root, 'regrade');
      const firstError = new Error('Progress failed while a peer was judging.');
      const peerStarted = deferred<CompletionRequest>();
      const peerAborted = deferred<void>();
      const finishPeer = deferred<void>();
      const peerProgress = deferred<void>();
      const cleanup = new AbortController();
      let peerSettled = false;
      const scripted = createScriptedCompletionProvider({
        responses: [
          async () => {
            await peerStarted.promise;
            return ORIGINAL_JUDGMENT;
          },
          async (request) => {
            request.signal.addEventListener(
              'abort',
              () => peerAborted.resolve(),
              { once: true },
            );
            peerStarted.resolve(request);
            // Deliberately delay settlement even after cancellation. Aborting
            // a provider is not proof that its outstanding work has stopped.
            await finishPeer.promise;
            peerSettled = true;
            if (lateFailure) throw new Error('Later peer failure.');
            return ORIGINAL_JUDGMENT;
          },
          ORIGINAL_JUDGMENT,
        ],
      });
      const dependencies = {
        completionProviders: new Map([
          [scripted.provider.id, scripted.provider],
        ]),
        credentialResolver: createStaticCredentialResolver(),
      };
      let failedProgress = false;
      let invocationSettled = false;
      const invocation = regradeExperimentRun(
        {
          experimentRun: source,
          judge: { provider: 'test-provider', model: 'judge-a' },
          output,
          jobs: 2,
          signal: cleanup.signal,
          waitBeforeJudgeRetry: async () => {},
          progress: () => {
            if (!failedProgress) {
              failedProgress = true;
              throw firstError;
            }
            cleanup.abort(firstError);
            peerProgress.resolve();
          },
        },
        dependencies,
      ).then(
        () => {
          invocationSettled = true;
          return undefined;
        },
        (error: unknown) => {
          invocationSettled = true;
          return error;
        },
      );
      let refused: unknown;
      let settledBeforePeer = false;
      let lockHeld = false;
      let cancellationRequested = false;
      try {
        const peer = await peerStarted.promise;
        // On the fix, peer cancellation marks the failure boundary. On main,
        // the invocation returns first. Neither branch depends on a timer.
        await Promise.race([invocation, peerAborted.promise]);
        settledBeforePeer = invocationSettled;
        cancellationRequested = peer.signal.aborted;
        lockHeld = await fs.access(path.join(output, '.regrade.lock')).then(
          () => true,
          () => false,
        );
        const retry = createScriptedCompletionProvider({
          responses: Array.from({ length: 3 }, () => ORIGINAL_JUDGMENT),
        });
        await regradeExperimentRun(
          {
            experimentRun: source,
            judge: { provider: 'test-provider', model: 'judge-b' },
            output,
          },
          {
            completionProviders: new Map([[retry.provider.id, retry.provider]]),
            credentialResolver: createStaticCredentialResolver(),
          },
        ).catch((error: unknown) => {
          refused = error;
        });
        assert.equal(peerSettled, false, 'the straggler is still judging');
        assert.deepEqual(
          {
            invocationSettled: settledBeforePeer,
            lockHeld,
            retryRefusedByLock: /Another regrade is writing to/.test(
              String(refused),
            ),
            retryJudgeCalls: retry.calls.length,
          },
          {
            invocationSettled: false,
            lockHeld: true,
            retryRefusedByLock: true,
            retryJudgeCalls: 0,
          },
          'keep the invocation pending and exclude a retry until its peer settles',
        );
        assert.equal(
          invocationSettled,
          false,
          'the invocation is still pending',
        );
        assert.equal(cancellationRequested, true, 'cancel the in-flight judge');
      } finally {
        finishPeer.resolve();
        assert.equal(
          await invocation,
          firstError,
          'preserve the first worker error',
        );
        // On main, drain the late writer explicitly before fixture cleanup.
        // Its progress callback aborts scheduling of the queued third run.
        if (!cancellationRequested) {
          await peerProgress.promise;
        }
      }
      assert.equal(peerSettled, true);
      assert.equal(
        scripted.calls.length,
        2,
        'do not start the queued third run',
      );
      await assert.rejects(fs.access(path.join(output, '.regrade.lock')));
      await assert.rejects(fs.access(path.join(output, 'report.json')));
      await assert.rejects(fs.access(path.join(output, 'regrade.json')));
    });
  }
});
