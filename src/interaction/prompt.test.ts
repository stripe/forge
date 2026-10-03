import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  buildAvaContinuationPrompt,
  buildAvaInitializationPrompt,
} from './prompt.js';

describe('Ava prompts', () => {
  it('binds the trimmed task and context, with a fallback for blank background', () => {
    const inputs = Object.freeze({
      task: '  Add a receipt link\nwithout changing checkout.  ',
      context: '  A developer maintaining billing.\n  ',
    });
    const prompt = buildAvaInitializationPrompt(inputs);

    assert.ok(prompt.includes('\n\nA developer maintaining billing.\n\n## Task\n'));
    assert.ok(prompt.includes('\n\nAdd a receipt link\nwithout changing checkout.\n\n## Human behavior\n'));
    const missingContext = buildAvaInitializationPrompt({task: inputs.task});
    const blankContext = buildAvaInitializationPrompt({task: inputs.task, context: ' \n\t '});
    assert.equal(blankContext, missingContext);
    assert.ok(missingContext.includes('\n\n(no additional background provided)\n\n## Task\n'));
  });

  it('renders the frozen task model and only the currently unresolved IDs', () => {
    const state = Object.freeze({
      needs: Object.freeze([
        Object.freeze({id: 'need_1', description: 'Choose the checkout experience'}),
        Object.freeze({id: 'need_2', description: 'Verify the receipt link'}),
      ]),
      remainingNeedIds: Object.freeze(['need_2']),
    });
    const inputs = Object.freeze({task: ' Add a receipt link. ', context: ' A developer. '});
    const prompt = buildAvaContinuationPrompt(inputs, state);

    assert.ok(prompt.includes('\n\nA developer.\n\n## Task\n'));
    assert.ok(prompt.includes('\n\nAdd a receipt link.\n\n## Human behavior\n'));
    assert.ok(prompt.includes(
      '\n\n- need_1: Choose the checkout experience\n- need_2: Verify the receipt link\n\nCurrently unresolved IDs: need_2\n',
    ));
    assert.match(prompt, /never reintroduce a\n  need that is no longer unresolved/);
    const terminalPrompt = buildAvaContinuationPrompt(inputs, {...state, remainingNeedIds: []});
    assert.ok(terminalPrompt.includes('\nCurrently unresolved IDs: (none)\n'));
    assert.deepEqual(state.remainingNeedIds, ['need_2']);
  });
});
