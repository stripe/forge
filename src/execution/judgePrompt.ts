import type { CriterionCompletionRequest } from '../evaluation/index.ts';
import { redactSecrets } from '../security/redaction.ts';

/**
 * The projected transcript and recorded workspace evidence are exact
 * substrings of the final judge prompt. CompletionRuntime still performs
 * defensive redaction, so fail closed if that final pass would rewrite any
 * prompt bytes after those evidence values were constructed. This also
 * catches secret-shaped strings formed only at JSON or prompt-template
 * boundaries.
 */
export function assertJudgePromptWillRemainUnchanged(
  request: Pick<CriterionCompletionRequest, 'systemPrompt' | 'messages'>,
  secrets: readonly string[],
): void {
  const projected = redactSecrets(
    { systemPrompt: request.systemPrompt, messages: request.messages },
    secrets,
  );
  if (projected.replacements !== 0) {
    throw new TypeError(
      'Judge prompt cannot be sent without changing its audited evidence.',
    );
  }
}
