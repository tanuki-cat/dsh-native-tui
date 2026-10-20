/**
 * DSH request -> OpenAI Chat Completions payload.
 *
 * The gateway speaks OpenAI Chat Completions with the shape recorded in
 * profiles.ts: no store, no stream_options, max_tokens, system role only, and
 * thinking carried by reasoning_effort + reasoning_summary.
 *
 * Images travel as OpenAI `image_url` parts with a base64 data URI, in the two
 * roles the endpoint was measured to accept them in (user messages and tool
 * results). An image in any other role is refused rather than dropped, and an
 * image whose bytes cannot be read degrades to placeholder text with a
 * diagnostic instead of failing the whole turn.
 *
 * @module dsh-native-tui/codebuddy/wire
 */

import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { CodeBuddyProfile } from './profiles.js'
import { REASONING_SUMMARY } from './profiles.js'
import { neutralizeAgentIdentity } from './prompt.js'

/** One durable image reference carried by a request. */
type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** Dimensions and byte target one route asks the attachment service to encode at. */
export interface ImageRequestTarget {
  readonly width: number
  readonly height: number
  readonly maxBytes: number
}

/** Reads one request-sized image version from the host attachment service. */
export interface WireImageReader {
  readImageRequest(ref: ImageRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<{
    readonly data: Uint8Array
    readonly mediaType: string
  }>
}

/** Image handling for one payload build. */
export interface WireImageOptions {
  /** Attachment reads; absent when this composition mounts no attachment service. */
  readonly reader?: WireImageReader
  /** Report one degraded image, so a missing reader or unreadable byte range is not silent. */
  readonly onDiagnostic?: (message: string) => void
  /** Cancellation for attachment reads. */
  readonly signal?: AbortSignal
}

/**
 * Request-image pixel budget, matching the pi-ai route's shipped default
 * (2048²). The body carries base64 inline, so an unbounded source image would
 * multiply the request size.
 */
const MAX_REQUEST_PIXELS = 2048 * 2048

/** Encoded-byte target before base64 expansion, matching the pi-ai route. */
const MAX_REQUEST_BYTES = 1024 * 1024

/**
 * Inline base64 budget for all retained images of one request.
 *
 * The route always inlines images, so this is the only bound on how large a
 * long conversation can grow. Exceeding it fails with `IMAGE_OFFLOAD_REQUIRED`,
 * which `dsh-compaction-image-offload` answers by marking the oldest images
 * offloaded and retrying — the mechanism every other image-capable route uses.
 */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** Occurrences one offload advance removes; one at a time is the smallest repair. */
const IMAGE_OFFLOAD_COUNT_QUANTUM = 1

/**
 * Aspect-preserving integer dimensions within a hard total-pixel budget.
 *
 * Mirrors `requestImageDimensions` from `@deepseek-ai/dsh-attachment`: this
 * plugin reaches host services through structural local interfaces, so the
 * projection is restated here rather than imported, and both routes must
 * project one attachment to the same request image.
 * @param width - positive source width.
 * @param height - positive source height.
 * @param maxPixels - positive width-times-height cap.
 * @returns inward-rounded dimensions; small images are not enlarged.
 */
export function projectedDimensions(
  width: number,
  height: number,
  maxPixels: number,
): { readonly width: number; readonly height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/**
 * The request-image projection this route sends for one attachment.
 * @param ref - normalized attachment reference.
 * @returns dimensions inside the pixel budget and the encoded-byte target.
 */
export function imageTargetOf(ref: {
  readonly width: number
  readonly height: number
}): ImageRequestTarget {
  // A missing or non-positive dimension is malformed input, not a 1x1 image:
  // projecting it to 1x1 would ask the attachment service to encode a thumbnail
  // nothing can read, and the only trace would be a useless answer. Ask for a
  // square of the full pixel budget instead, so the service encodes at its own
  // bound and the image stays usable; a real read never reports a bad size,
  // because the reference is normalized before it reaches this route.
  const usable = (value: number): boolean => Number.isSafeInteger(value) && value > 0
  if (!usable(ref.width) || !usable(ref.height)) {
    const side = Math.max(1, Math.floor(Math.sqrt(MAX_REQUEST_PIXELS)))
    return { width: side, height: side, maxBytes: MAX_REQUEST_BYTES }
  }
  return { ...projectedDimensions(ref.width, ref.height, MAX_REQUEST_PIXELS), maxBytes: MAX_REQUEST_BYTES }
}

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

/** True when this block list carries an image the endpoint would have to receive. */
function hasImage(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'image')
}

/** Roles this endpoint accepts an image part in. */
function carriesImages(message: RequestMessage): boolean {
  return message.role === 'user' || message.role === 'tool'
}

/**
 * Refuse an image in a role the chat endpoint cannot carry one in.
 *
 * Only roles this route actually sends are checked: a developer message is
 * dropped whole (its tool additions are an in-history protocol this endpoint
 * does not take), so an image inside one never reaches the wire and must not
 * fail the turn.
 * @param message - the request message being serialized.
 */
function assertImageRole(message: RequestMessage): void {
  if (carriesImages(message)) return
  if (message.role === 'developer') return
  if (!hasImage(message.content)) return
  throw new LlmError(
    'the CodeBuddy chat endpoint accepts images only in user messages and tool results, not in a '
    + message.role + ' message',
    'UNSUPPORTED_CONTENT',
  )
}

/** Stable placeholder for an image this route could not turn into bytes. */
function unavailableImageText(ref: ImageRef): string {
  return '[image unavailable: attachment sha256:' + String(ref.attachmentId).slice(7, 15) + ']'
}

/** One wire content part. */
type WirePart = Record<string, unknown>

/** One prepared image: the wire part to emit, plus the encoded byte count it measured. */
interface PreparedImage {
  readonly part: WirePart
  /** Encoded request bytes, or the source size when the read failed. */
  readonly bytes: number
}

/**
 * Collect the image references this request would send bytes for.
 *
 * Offloaded occurrences are excluded: the host marked them as omitted from the
 * request, and re-reading them would undo that decision — the reader would pay
 * the decode cost and the model would receive an image the surface had already
 * accounted for as placeholder text.
 * @param messages - request history.
 * @returns one reference per distinct attachment id, in first-seen order.
 */
function requestImageRefs(messages: readonly RequestMessage[]): ImageRef[] {
  const refs = new Map<string, ImageRef>()
  for (const message of messages) {
    if (!carriesImages(message)) continue
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue
      refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  return [...refs.values()]
}

/**
 * Read every request image once, concurrently, before any message is built.
 *
 * One attachment referenced from several messages is decoded once, and the
 * reads overlap instead of running one per message in sequence. A failed read
 * degrades that image to placeholder text with a diagnostic; it never fails the
 * turn, because the model can still answer about the rest of the request.
 * @param refs - distinct references to read.
 * @param images - reader, diagnostics and cancellation.
 * @returns one prepared part per attachment id.
 */
async function prepareImages(refs: readonly ImageRef[], images: WireImageOptions): Promise<Map<string, PreparedImage>> {
  const prepared = new Map<string, PreparedImage>()
  if (refs.length === 0) return prepared
  const reader = images.reader
  if (reader === undefined) {
    images.onDiagnostic?.('no attachment service is mounted; ' + String(refs.length)
      + ' image(s) were sent as placeholder text')
    for (const ref of refs) {
      prepared.set(ref.attachmentId, { part: { type: 'text', text: unavailableImageText(ref) }, bytes: ref.bytes })
    }
    return prepared
  }
  // Each task carries its own reference, so the map is built from the reads
  // themselves rather than from a positional index a later edit could misalign.
  // A misaligned index would send one attachment's bytes where another was
  // meant: silent, and hard to trace from the transcript.
  const entries = await Promise.all(refs.map(async (ref): Promise<[ImageRef, PreparedImage]> => {
    try {
      const stored = await reader.readImageRequest(ref, imageTargetOf(ref), images.signal)
      return [ref, {
        part: {
          type: 'image_url',
          image_url: { url: 'data:' + stored.mediaType + ';base64,' + Buffer.from(stored.data).toString('base64') },
        },
        bytes: stored.data.byteLength,
      }]
    }
    catch (error) {
      images.onDiagnostic?.('image ' + ref.attachmentId + ' could not be read and was sent as placeholder text: '
        + (error instanceof Error ? error.message : String(error)))
      // A placeholder carries no bytes, so it costs the budget nothing while
      // still telling the model an image was attached.
      return [ref, { part: { type: 'text', text: unavailableImageText(ref) }, bytes: 0 }]
    }
  }))
  for (const [ref, preparedImage] of entries) prepared.set(ref.attachmentId, preparedImage)
  return prepared
}

/**
 * One image block as its prepared part.
 *
 * An offloaded occurrence becomes the host's own placeholder text: the surface
 * already decided this image is not part of the request, so its bytes are not
 * read again.
 * @param block - image block from a user message or tool result.
 * @param prepared - request images read before serialization.
 * @returns the wire part to append.
 */
function imagePartOf(
  block: Extract<ContentBlock, { type: 'image' }>,
  prepared: ReadonlyMap<string, PreparedImage>,
): WirePart {
  if (block.offloaded === true) return { type: 'text', text: offloadedImageText(block.attachment) }
  return prepared.get(block.attachment.attachmentId)?.part
    ?? { type: 'text', text: unavailableImageText(block.attachment) }
}

/** Text-only content for one message, exactly as this route sent it before images existed. */
function textContent(blocks: readonly ContentBlock[], resolveFileText: ((ref: unknown) => string) | undefined): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'file') text += fileTextOf(block, resolveFileText)
  }
  return text
}

/**
 * Content for one user message or tool result: a plain string when the message
 * carries no image, an OpenAI parts array when it does.
 * @param blocks - message content.
 * @param resolveFileText - Host projection for durable file references.
 * @param images - image reader, diagnostics and cancellation.
 * @returns the wire `content` value.
 */
function contentOf(
  blocks: readonly ContentBlock[],
  resolveFileText: ((ref: unknown) => string) | undefined,
  images: ReadonlyMap<string, PreparedImage>,
): string | WirePart[] {
  if (!hasImage(blocks)) return textContent(blocks, resolveFileText)
  const parts: WirePart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text !== '') parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'file') {
      parts.push({ type: 'text', text: fileTextOf(block, resolveFileText) })
      continue
    }
    if (block.type === 'image') parts.push(imagePartOf(block, images))
    // tool-call and tool-change blocks are not user-input vocabulary for this endpoint.
  }
  return parts
}

/** One wire message. */
type WireMessage = Record<string, unknown>

/**
 * Convert one durable message into its wire projection; undefined drops it.
 * @param message - durable history message.
 * @param resolveFileText - Host projection for durable file references.
 * @param images - image reader, diagnostics and cancellation.
 * @returns the wire message, or undefined when this route sends nothing for it.
 */
function wireMessage(
  message: RequestMessage,
  resolveFileText: ((ref: unknown) => string) | undefined,
  images: ReadonlyMap<string, PreparedImage>,
): WireMessage | undefined {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: textOf(message.content) }
    case 'developer':
      // Tool additions and removals are an in-history protocol; this route
      // declares the complete tool list on every request instead.
      return undefined
    case 'user':
      return { role: 'user', content: contentOf(message.content, resolveFileText, images) }
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: String(message.toolCallId),
        content: contentOf(message.content, resolveFileText, images),
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
 * Messages whose images this route actually sends.
 *
 * The budget must price the request as it will be posted: a developer message
 * is dropped whole and an assistant image is refused outright, so neither
 * consumes the inline budget. Counting them would reject a request over images
 * that never reach the wire.
 * @param messages - request history.
 * @returns the user and tool messages, in order.
 */
function sendingMessages(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  return messages.filter(carriesImages)
}

/**
 * Refuse a request whose retained images exceed this route's inline budget.
 *
 * The failure carries `offloadImages`, the positive count of additional oldest
 * occurrences that must be offloaded; `dsh-compaction-image-offload` records
 * that decision on the surface and retries, which is what keeps a long
 * conversation's request body bounded. Without this check the route would grow
 * without limit and fail upstream with an opaque 400 instead.
 * @param messages - request history, already narrowed to the messages this route sends.
 * @param prepared - images already read for this request.
 * @throws LlmError with `IMAGE_OFFLOAD_REQUIRED` when the budget is exceeded.
 */
function assertImagesFit(
  messages: readonly RequestMessage[],
  prepared: ReadonlyMap<string, PreparedImage>,
): void {
  // `requiredImageOffload` applies the base64 expansion itself for the base64
  // representation, so this returns the encoded bytes as measured, not their
  // data-URI length.
  const bytesOf = (block: Extract<ContentBlock, { type: 'image' }>): number =>
    prepared.get(block.attachment.attachmentId)?.bytes ?? block.attachment.bytes
  const offloadImages = requiredImageOffload(
    messages,
    { representation: 'base64', maxBytes: MAX_REQUEST_IMAGE_BYTES, countQuantum: IMAGE_OFFLOAD_COUNT_QUANTUM },
    bytesOf,
  )
  if (offloadImages > 0) {
    throw new LlmError(
      'CodeBuddy request images exceed the ' + String(MAX_REQUEST_IMAGE_BYTES)
      + '-byte inline budget; ' + String(offloadImages) + ' more oldest occurrence(s) must be offloaded.',
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }
}

/**
 * Build one chat-completions request body.
 *
 * Roles are validated first: an image in a message this endpoint cannot carry
 * is a request that will never be posted, so it is named before any image is
 * decoded or priced. Only the messages that will actually be sent are then
 * read (once per attachment, concurrently) and priced against the inline
 * budget; serialization itself is synchronous. Callers that reach this
 * function directly bypass the harness modality gate, so they own the decision
 * that the target model accepts images.
 * @param options - the assembled DSH request.
 * @param profile - deployment whose normalization applies.
 * @param resolveFileText - Host projection for durable file references.
 * @param images - image reader, diagnostics and cancellation.
 * @returns the JSON body to POST.
 */
export async function buildChatPayload(
  options: GenerateOptions,
  profile: CodeBuddyProfile,
  resolveFileText?: (ref: unknown) => string,
  images: WireImageOptions = {},
): Promise<Record<string, unknown>> {
  const scoped: WireImageOptions = { ...images, signal: images.signal ?? options.signal }
  // Role failures are reported before any image work: an assistant image is a
  // request this route cannot send at all, so it must not be priced.
  for (const message of options.messages) assertImageRole(message)
  const sending = sendingMessages(options.messages)
  const prepared = await prepareImages(requestImageRefs(sending), scoped)
  assertImagesFit(sending, prepared)
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    const wire = wireMessage(message, resolveFileText, prepared)
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
  // The CN gateway refuses a third-party agent identity wherever the prompt is
  // carried: as `options.system` and as an in-history system message (the
  // harness can deliver the composed prompt either way). Restating every
  // system message keeps both paths on the same approved wording while the
  // rest of each prompt stays untouched.
  if (profile.rewritesAgentIdentity === true) {
    for (const message of messages) {
      if (message.role === 'system' && typeof message.content === 'string') {
        message.content = neutralizeAgentIdentity(message.content)
      }
    }
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
