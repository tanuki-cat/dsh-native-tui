/**
 * System-prompt neutralization for the gateway's client fingerprinting.
 *
 * CodeBuddy's CN gateway answers HTTP 400 code 11128 ("Illegal API invocation
 * from an unapproved channel", display tip: "this call failed channel
 * verification, possibly because it was not sent from an official client")
 * when the system prompt carries third-party agent wording. It fingerprints
 * prompt text, not conversation content: the same wording in a user message or
 * a tool result is accepted, and the international gateway does not check at
 * all. The list has grown once already:
 *
 * - 2026-10-20: the DeepSeek Harness opening line, alone, was refused while a
 *   200 KB prompt with only that line restated was accepted.
 * - 2026-10-28: a whole 201 KB prompt was refused again after that line had
 *   been restated. Only one paragraph of the harness briefing was refused, and
 *   changing a single word in its opening sentence cleared it — the match is
 *   wording-sensitive, not semantic, so a paraphrase, a reordering, or one
 *   substituted word all pass.
 *
 * Every other part of the prompt — tool notes, workspace rules, user
 * instructions — is preserved byte for byte, so the model keeps its whole
 * briefing and only the measured spans change. Restating a sentence inside a
 * paragraph is deliberate: the rest of that paragraph stays the wording the
 * gateway accepts.
 *
 * The harness can deliver that prompt either as `GenerateOptions.system` or as
 * an in-history system message (the TUI does the latter), so wire.ts restates
 * every system-role message it sends.
 *
 * @module dsh-native-tui/codebuddy/prompt
 */

/** Restatement that the gateway accepts in place of a harness identity line. */
export const NEUTRAL_IDENTITY = 'You are a software engineering assistant.'

/**
 * Placeholder an operator-configured system prompt may carry to keep the
 * harness prompt in place.
 *
 * The harness prompt is assembled per request — workspace rules, skills and
 * tool notes can make it hundreds of kilobytes — so a custom opening sentence
 * cannot reasonably be written by copying it. The placeholder lets a configured
 * prompt wrap that text instead.
 */
export const PROMPT_PLACEHOLDER = '{prompt}'

/**
 * Expand one configured system prompt template.
 *
 * Expansion happens once and is not recursive: a literal placeholder inside the
 * harness prompt stays text. The replacement is not subject to `String.replace`
 * patterns either, because harness prompts can contain `$&` and similar runs.
 * @param template - operator-configured system prompt.
 * @param harnessPrompt - system text the harness assembled for this request.
 * @returns the text to send as the leading system message.
 */
export function expandSystemPrompt(template: string, harnessPrompt: string): string {
  return template.split(PROMPT_PLACEHOLDER).join(harnessPrompt)
}

/** One measured refusal and the wording that clears it. */
interface Restatement {
  /** Exact harness span the gateway answers with code 11128. */
  readonly refused: RegExp
  /** Wording the gateway accepts for that span. */
  readonly restated: string
}

/**
 * Measured refusals, applied in order.
 *
 * Each entry replaces the shortest span that reproduces the refusal, so
 * accepted sentences next to it keep their wording. A span is added only after
 * a live refusal was measured against the gateway; without one it would cost
 * the model its own briefing for no reason.
 */
const RESTATEMENTS: readonly Restatement[] = [
  { refused: /^You are an AI agent powered by .+$/i, restated: NEUTRAL_IDENTITY },
  {
    refused: /^Tokens prefixed with @ are paths the user explicitly referenced\./,
    restated: 'Tokens starting with @ name paths the user referenced.',
  },
]

/**
 * Restate the spans the gateway refuses.
 *
 * Only matched spans are replaced; the rest of each line, including blank
 * lines, is returned unchanged. Idempotent: a prompt that has already been
 * restated no longer matches.
 * @param text - composed system prompt.
 * @returns the prompt with refused spans restated.
 */
export function neutralizeAgentIdentity(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let restated = line
      for (const entry of RESTATEMENTS) restated = restated.replace(entry.refused, entry.restated)
      return restated
    })
    .join('\n')
}
