/**
 * DSH request -> OpenAI Chat Completions payload.
 *
 * The gateway speaks OpenAI Chat Completions with the shape recorded in
 * profiles.ts: no store, no stream_options, max_tokens, system role only, and
 * thinking carried by reasoning_effort + reasoning_summary. The adapter
 * declares text-only input, so an image block is refused rather than silently
 * dropped.
 *
 * @module dsh-native-tui/codebuddy/wire
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { CodeBuddyProfile } from './profiles.js'
import { REASONING_SUMMARY } from './profiles.js'

/** Concatenate the visible text of one block list. */
function textOf(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** Handle text for one durable file reference, from the Host when available. */
function fileTextOf(block: ContentBlock, resolveFileText: ((ref: unknown) => string) | undefined): string {
  const reference = (block as { attachment?: unknown }).attachment
  if (resolveFileText !== undefined) return resolveFileText(reference)
  const record = reference !== null && typeof reference === 'object' ? reference as Record<string, unknown> : {}
  const name = typeof record.name === 'string' && record.name !== '' ? record.name : 'attachment'
  const bytes = typeof record.bytes === 'number' ? record.bytes : undefined
  return bytes === undefined ? '[file: ' + name + ']' : '[file: ' + name + ', ' + String(bytes) + ' bytes]'
}

/** Refuse anything this text-only route cannot send. */
function assertNoImages(blocks: readonly ContentBlock[], model: string): void {
  if (blocks.some(block => block.type === 'image')) {
    throw new LlmError(
      model + ' is a text-only CodeBuddy route; remove the image attachment or pick another model',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** One user-role message body. */
function userContent(blocks: readonly ContentBlock[], resolveFileText: ((ref: unknown) => string) | undefined): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'file') text += fileTextOf(block, resolveFileText)
  }
  return text
}

/** One wire message. */
type WireMessage = Record<string, unknown>

/** Convert one durable message into its wire projection; undefined drops it. */
function wireMessage(
  message: RequestMessage,
  model: string,
  resolveFileText: ((ref: unknown) => string) | undefined,
): WireMessage | undefined {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: textOf(message.content) }
    case 'developer':
      // Tool additions and removals are an in-history protocol; this route
      // declares the complete tool list on every request instead.
      return undefined
    case 'user': {
      assertNoImages(message.content, model)
      return { role: 'user', content: userContent(message.content, resolveFileText) }
    }
    case 'tool': {
      assertNoImages(message.content, model)
      return {
        role: 'tool',
        tool_call_id: String(message.toolCallId),
        content: textOf(message.content),
      }
    }
    case 'assistant': {
      const toolCalls: Record<string, unknown>[] = []
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        toolCalls.push({
          id: String(block.id),
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        })
      }
      const content = textOf(message.content)
      if (content === '' && toolCalls.length === 0) return undefined
      return {
        role: 'assistant',
        content,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      }
    }
    default:
      return undefined
  }
}

/** One tool declaration, when the request carries tools. */
function wireTools(options: GenerateOptions): Record<string, unknown>[] | undefined {
  if (options.tools === undefined || options.tools.length === 0) return undefined
  return options.tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

/**
 * Build one chat-completions request body.
 * @param options - the assembled DSH request.
 * @param profile - deployment whose normalization applies.
 * @param resolveFileText - Host projection for durable file references.
 * @returns the JSON body to POST.
 */
export function buildChatPayload(
  options: GenerateOptions,
  profile: CodeBuddyProfile,
  resolveFileText?: (ref: unknown) => string,
): Record<string, unknown> {
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    const wire = wireMessage(message, options.model, resolveFileText)
    if (wire !== undefined) messages.push(wire)
  }
  // Both gateways require the leading message to be a system prompt, and the
  // international one rejects a conversation outright without it (code 11128).
  // A caller that supplies no system text — a hand-built one-shot, a probe —
  // gets an empty system message rather than a transport error; the conversation
  // itself is unchanged.
  if (messages.length === 0 || messages[0]?.role !== 'system') {
    messages.unshift({ role: 'system', content: '' })
  }

  const tools = wireTools(options)
  const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  const payload: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: [...options.stop] }),
    ...(tools === undefined ? {} : { tools }),
  }
  // The gateway emits thinking only when both fields are present, and rejects
  // them for a model without thinking support.
  if (effort !== undefined && effort !== 'off' && effort !== '') {
    payload.reasoning_effort = effort
    payload.reasoning_summary = REASONING_SUMMARY
  }
  profile.normalizePayload?.(payload)
  return payload
}
