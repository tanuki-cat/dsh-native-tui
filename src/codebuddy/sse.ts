/**
 * Server-sent-event framing for the CodeBuddy chat stream.
 *
 * The decoder is incremental: UTF-8 chunk boundaries, multi-line data fields,
 * comment heartbeats and CRLF line endings all decode correctly. A trailing
 * frame without its blank-line terminator is still emitted when it carries
 * data, because a gateway that closes right after [DONE] would otherwise look
 * like a truncated stream.
 *
 * @module dsh-native-tui/codebuddy/sse
 */

/** One decoded SSE frame. */
export interface SseFrame {
  /** Joined data fields of the frame. */
  readonly data: string
  /** Event name, when the frame carried one. */
  readonly event?: string
}

/** Decoder options. */
export interface SseDecodeOptions {
  /**
   * Called for every body chunk, before framing. A `:` comment heartbeat and a
   * chunk that does not complete a frame are both progress: consumers with an
   * idle budget must observe them, which parsed frames alone cannot report.
   */
  readonly onChunk?: () => void
}

/** Maximum unframed SSE buffer retained, in UTF-8 bytes, before aborting the stream. */
export const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024

/** UTF-8 byte length of one buffer slice, the unit the frame limit is stated in. */
function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Decode one SSE byte stream into frames.
 * @param body - the response body stream.
 * @param options - chunk observer for idle-budget consumers.
 * @returns frames in arrival order.
 */
export async function* decodeSse(
  body: ReadableStream<Uint8Array>,
  options: SseDecodeOptions = {},
): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // Tracked in UTF-8 bytes, not UTF-16 code units: the limit is a byte budget,
  // and a multi-byte character would otherwise count as half of its wire size.
  let bufferedBytes = 0
  let scanFrom = 0
  let done = false
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) {
        done = true
        break
      }
      options.onChunk?.()
      // A fresh decoder call per chunk keeps multi-byte sequences whole.
      buffer += decoder.decode(step.value, { stream: true })
      bufferedBytes += step.value.byteLength
      // Frames are split out first: only the incomplete remainder is subject to
      // the buffer limit, so a large but well-formed frame never trips it.
      let index = splitIndex(buffer, scanFrom)
      while (index !== -1) {
        const length = separatorLength(buffer, index)
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + length)
        bufferedBytes -= utf8Length(frame) + (length === 4 ? 4 : 2)
        scanFrom = 0
        const parsed = parseFrame(frame)
        if (parsed !== undefined) yield parsed
        index = splitIndex(buffer, 0)
      }
      scanFrom = Math.max(0, buffer.length - 3)
      if (bufferedBytes > MAX_SSE_BUFFER_BYTES) {
        throw new Error('SSE frame exceeded buffer limit')
      }
    }
    const tail = decoder.decode()
    buffer += tail
    bufferedBytes += utf8Length(tail)
    if (bufferedBytes > MAX_SSE_BUFFER_BYTES) {
      throw new Error('SSE frame exceeded buffer limit')
    }
    const parsed = parseFrame(buffer)
    if (parsed !== undefined) yield parsed
  }
  finally {
    if (!done) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Index of the next blank-line frame separator, or -1. */
function splitIndex(buffer: string, fromIndex: number): number {
  const lf = buffer.indexOf('\n\n', fromIndex)
  const crlf = buffer.indexOf('\r\n\r\n', fromIndex)
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

/** Length of the separator starting at one index. */
function separatorLength(buffer: string, index: number): number {
  return buffer.startsWith('\r\n\r\n', index) ? 4 : 2
}

/** Parse one raw frame; undefined when it carries no data fields. */
function parseFrame(raw: string): SseFrame | undefined {
  const data: string[] = []
  let event: string | undefined
  for (const line of raw.split(/\r?\n/u)) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
  }
  if (data.length === 0) return undefined
  return { data: data.join('\n'), ...(event === undefined ? {} : { event }) }
}
