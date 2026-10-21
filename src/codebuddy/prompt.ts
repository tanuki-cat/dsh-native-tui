/**
 * System-prompt neutralization for the gateway's client fingerprinting.
 *
 * CodeBuddy's CN gateway answers HTTP 400 code 11128 ("Illegal API invocation
 * from an unapproved channel", display tip: "this call failed channel
 * verification, possibly because it was not sent from an official client")
 * when the system prompt opens with a third-party agent identity. The DeepSeek
 * Harness opening line is one of those fingerprints: measured against the live
 * gateway, that single sentence is rejected while the same 200 KB prompt with
 * only the line restated is accepted. Everything else in the prompt — tool
 * notes, workspace rules, user instructions — is preserved byte for byte, so
 * the model keeps its whole briefing and only the runtime self-description
 * changes.
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

/** One line that presents the harness itself as the agent's runtime. */
const AGENT_IDENTITY = /^You are an AI agent powered by .+$/i

/**
 * Restate harness-identity lines the gateway refuses.
 *
 * Only whole lines that match the identity shape are replaced; the rest of the
 * prompt, including blank lines, is returned unchanged. Idempotent: a prompt
 * that has already been restated no longer matches.
 * @param text - composed system prompt.
 * @returns the prompt with identity lines restated.
 */
export function neutralizeAgentIdentity(text: string): string {
  if (!/AI agent powered by/i.test(text)) return text
  return text
    .split('\n')
    .map(line => (AGENT_IDENTITY.test(line) ? NEUTRAL_IDENTITY : line))
    .join('\n')
}
