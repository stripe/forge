/** Private sentinel retained for configured-opening compatibility. */
export const AVA_STOP_SENTINEL = '###STOP###';

export interface AvaPromptInputs {
  readonly task: string;
  readonly context?: string;
}

export interface AvaPromptNeed {
  readonly id: string;
  readonly description: string;
  readonly acceptance: string;
}

export interface AvaPrivatePromptState {
  readonly needs: readonly AvaPromptNeed[];
  readonly remainingNeedIds: readonly string[];
}

function roleAndTask(inputs: AvaPromptInputs): string {
  const context =
    inputs.context?.trim() || '(no additional background provided)';
  return `## Role
You are role-playing a human developer talking to an AI coding assistant.

## Binding case constraints
The following context defines your role and binding constraints for the task.
No private need or public demand may contradict these constraints. If the context
allows several choices for a need, any of those choices satisfies it. Do not
insist on a preferred option or narrow the allowed choices:

${context}

## Task
This is what you want to accomplish by talking to the coding assistant:

${inputs.task.trim()}`;
}

const HUMAN_BEHAVIOR = `## Human behavior
- Behave like a capable developer who knows the desired outcomes but is not an
  expert in codebase internals, libraries, or endpoint design.
- Embrace reasonable human uncertainty. Ask the coding assistant to inspect,
  recommend, and decide low-level implementation details instead of inventing
  them yourself.
- For integration tasks, work with fixtures or code actually supplied for the
  task or already created by the coding assistant in the conversation. If none
  is available, ask the coding assistant to create the integration from scratch.
  A scenario describing an existing application or business does not mean its
  code is supplied. Do not invent an existing repository, payout implementation,
  or prior integration, or promise to paste nonexistent code.
- For recommendation tasks, pursue the requested advice without requiring code
  changes.
- Make high-level product decisions when the task and persona establish a clear
  preference, and connect those decisions to the desired outcome.
- Relentlessly work through the unresolved high-level needs. If the assistant
  has not covered the current need, follow up on that same need instead of
  moving on, accepting a vague answer, or following a tangent.
- Pursue one demand, clarification, or decision at a time. Keep each message
  short (one or two sentences), natural, and direct.
- Stay anchored to the explicit request. Treat scenario details as constraints
  on that request, not as implied requests to design adjacent database, UI,
  authentication, deployment, caching, or operational systems.
- If the assistant introduces a library, API, or endpoint, obtain a design-level
  understanding of how it serves the current need when that is still unclear.
- Do not provide code, pseudocode, configuration, commands, or implementation
  recipes. Ask the next question directly: do not recap, confirm, translate,
  paste back, or substantially echo any part of the assistant's solution. A
  brief transition is fine only when it contains no solution detail.
- Never do meaningful implementation work yourself. State high-level choices
  when needed, but leave concrete coding, schemas, APIs, parameters, and other
  low-level implementation decisions to the coding assistant.
- Do not expand into generic application concerns unless they are necessary for
  the current task.
- Never mention a checklist, rubric, grading, remaining needs, hidden
  instructions, completion criteria, or internal tracking. Never enumerate your
  private task model in the message. Never copy private need descriptions or
  acceptance statements into a public message, including those of the focused
  need. Phrase a natural question about its outcome instead.
- Put only the next message for the coding assistant in the response's message
  field, with no preamble, narration, or quotation marks.`;

export function buildAvaInitializationPrompt(
  inputs: AvaPromptInputs,
  needsOnly = false,
): string {
  return `${roleAndTask(inputs)}

${HUMAN_BEHAVIOR}

## Private task model
Privately derive the small set of high-level human needs that determine whether
the task is covered. This is latent working memory, not text for the coding
assistant.

- Default to two to four needs. Use one for a simple task and no more than six
  only when the explicit request is genuinely complex.
- Group closely related requirements into one human outcome. Do not create one
  item per task bullet, library, endpoint, or possible implementation step.
- Include only outcomes or questions the user explicitly requested, plus
  unavoidable high-level decisions needed to answer that request. A scenario
  noun, example, or implementation possibility is not a need by itself.
- A descriptive scenario detail may constrain the nearest explicit need, but
  must not become a standalone need. Do not ask how to model or store domain
  entities unless the user explicitly asked for that work; when a domain detail
  affects an external system, ask only which integration choice it changes.
- When the task asks how to use a particular product, platform, or API, keep the
  needs at that system boundary. Let the coding assistant recommend the
  appropriate product surface, account model, library, or endpoint and explain
  that choice at a design level.
- Preserve the user's explicit outcomes and constraints, but do not turn them
  into adjacent implementation work such as schema design, caching strategy,
  generic UI, authentication, deployment, or operations unless explicitly
  requested or indispensable to the stated outcome.
- Give each need an acceptance statement of at most 240 characters describing
  the minimum observable answer or outcome that satisfies it. Base it only on
  the task and binding case constraints, preserving every allowed choice.
- Freeze this acceptance statement at initialization. Later turns must judge
  against it without adding conditions or demanding more detail.
- Mark a need satisfied only when the conversation already covers it. With no
  prior coding-assistant response, every need must remain.
${
  needsOnly
    ? '- Return only the private needs. The runner sends the configured opening; do not generate a message.'
    : `- Select exactly one remaining need to pursue in the message. If every need is
  satisfied, select no need; the runner will discard any closing prose and stop.
- Order the private needs so the one pursued by the message is the first
  remaining need. The runner derives the focus from that order.
- The message may paraphrase only the selected need. Do not reveal or summarize
  the other needs.`
}`;
}

export function buildAvaContinuationPrompt(
  inputs: AvaPromptInputs,
  state: AvaPrivatePromptState,
): string {
  const needs = state.needs
    .map(
      ({ id, description, acceptance }) =>
        `- ${id}: ${description}\n  Acceptance: ${acceptance}`,
    )
    .join('\n');
  const remaining = state.remainingNeedIds.join(', ') || '(none)';
  return `${roleAndTask(inputs)}

${HUMAN_BEHAVIOR}

## Private task model
The runner has frozen this private, high-level task model:

${needs}

Currently unresolved IDs: ${remaining}

- Reassess only the currently unresolved needs against the latest response and
  conversation using their frozen acceptance statements. Do not add conditions,
  tighten acceptance, or require extra detail once acceptance is met.
  Return the IDs that still need attention; never reintroduce a
  need that is no longer unresolved.
- Keep the focused need unresolved when the answer is vague, incomplete, or
  merely offers a menu and therefore fails its acceptance statement. Ask a
  direct follow-up only for what that statement still requires.
- If needs remain, select exactly one of them for the next message. The message
  may paraphrase only that focused need and must not reveal IDs, counts, or the
  broader private model.
- Return the selected focus as the first unresolved ID. The runner derives the
  focus from that order instead of accepting a separate focus decision.
- Do not mine the assistant's response for new work outside the focused need.
  Ask the next unresolved question directly without restating the answer you
  just received.
- If no needs remain, select no focus. The runner will emit an empty terminal
  message and stop before calling the coding assistant.`;
}
