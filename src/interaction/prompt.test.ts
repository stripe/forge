import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildAvaContinuationPrompt,
  buildAvaInitializationPrompt,
} from './prompt.ts';

describe('Ava prompts', () => {
  for (const [phase, buildPrompt] of [
    ['initialization', buildAvaInitializationPrompt],
    [
      'needs-only initialization',
      (inputs: Parameters<typeof buildAvaInitializationPrompt>[0]) =>
        buildAvaInitializationPrompt(inputs, true),
    ],
    [
      'continuation',
      (inputs: Parameters<typeof buildAvaInitializationPrompt>[0]) =>
        buildAvaContinuationPrompt(inputs, {
          needs: [{ id: 'need_1', description: 'Complete the requested task' }],
          remainingNeedIds: ['need_1'],
        }),
    ],
  ] as const) {
    it(`grounds ${phase} integration requests in available code rather than fictional existing work`, () => {
      const prompt = buildPrompt({
        task: 'Add a payout integration.',
        context: 'A developer running an existing marketplace.',
      });

      assert.match(
        prompt,
        /work with fixtures or code actually supplied for the\n {2}task or already created by the coding assistant in the conversation/,
      );
      assert.match(
        prompt,
        /If none\n {2}is available, ask the coding assistant to create the integration from scratch/,
      );
      assert.match(
        prompt,
        /A scenario describing an existing application or business does not mean its\n {2}code is supplied/,
      );
      assert.match(
        prompt,
        /Do not invent an existing repository, payout implementation,\n {2}or prior integration, or promise to paste nonexistent code/,
      );
    });

    it(`makes case constraints binding during ${phase}`, () => {
      const context =
        'Use either hosted or embedded checkout. No account login is required.';
      const prompt = buildPrompt({ task: 'Add checkout.', context });
      const constraints = prompt
        .split('## Binding case constraints\n')[1]
        ?.split('\n## Task')[0];
      assert.ok(constraints);
      assert.ok(constraints.includes(context));
      assert.match(
        constraints,
        /No private need or public demand may contradict these constraints/,
      );
      assert.match(
        constraints,
        /allows several choices for a need, any of those choices satisfies it/,
      );
      assert.match(
        constraints,
        /Do not\ninsist on a preferred option or narrow the allowed choices/,
      );
    });

    it(`keeps ${phase} recommendation requests advice-only`, () => {
      const prompt = buildPrompt({
        task: 'Recommend a payment provider for a new store.',
      });

      assert.match(
        prompt,
        /For recommendation tasks, pursue the requested advice without requiring code\n {2}changes/,
      );
    });
  }

  it('binds the trimmed task and context, with a fallback for blank background', () => {
    const inputs = Object.freeze({
      task: '  Add a receipt link\nwithout changing checkout.  ',
      context: '  A developer maintaining billing.\n  ',
    });
    const prompt = buildAvaInitializationPrompt(inputs);

    assert.ok(
      prompt.includes('\n\nA developer maintaining billing.\n\n## Task\n'),
    );
    assert.ok(
      prompt.includes(
        '\n\nAdd a receipt link\nwithout changing checkout.\n\n## Human behavior\n',
      ),
    );
    const missingContext = buildAvaInitializationPrompt({ task: inputs.task });
    const blankContext = buildAvaInitializationPrompt({
      task: inputs.task,
      context: ' \n\t ',
    });
    assert.equal(blankContext, missingContext);
    assert.ok(
      missingContext.includes(
        '\n\n(no additional background provided)\n\n## Task\n',
      ),
    );
  });

  it('renders the frozen task model and only the currently unresolved IDs', () => {
    const state = Object.freeze({
      needs: Object.freeze([
        Object.freeze({
          id: 'need_1',
          description: 'Choose the checkout experience',
        }),
        Object.freeze({ id: 'need_2', description: 'Verify the receipt link' }),
      ]),
      remainingNeedIds: Object.freeze(['need_2']),
    });
    const inputs = Object.freeze({
      task: ' Add a receipt link. ',
      context: ' A developer. ',
    });
    const prompt = buildAvaContinuationPrompt(inputs, state);

    assert.ok(prompt.includes('\n\nA developer.\n\n## Task\n'));
    assert.ok(
      prompt.includes('\n\nAdd a receipt link.\n\n## Human behavior\n'),
    );
    assert.ok(
      prompt.includes(
        '\n\n- need_1: Choose the checkout experience\n- need_2: Verify the receipt link\n\nCurrently unresolved IDs: need_2\n',
      ),
    );
    assert.match(
      prompt,
      /never reintroduce a\n {2}need that is no longer unresolved/,
    );
    const terminalPrompt = buildAvaContinuationPrompt(inputs, {
      ...state,
      remainingNeedIds: [],
    });
    assert.ok(terminalPrompt.includes('\nCurrently unresolved IDs: (none)\n'));
    assert.deepEqual(state.remainingNeedIds, ['need_2']);
  });
});
