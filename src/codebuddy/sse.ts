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

/** Maximum unframed SSE buffer retained before aborting the stream. */
export const MAX_SSE_BUFFER_CHARS = 4 * 1024 * 1024

/**
 * Decode one SSE byte stream into frames.
 * @param body - the response body stream.
 * @returns frames in arrival order.
 */
export async function* decodeSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let scanFrom = 0
  let done = false
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) {
        done = true
        break
      }
      // A fresh decoder call per chunk keeps multi-byte sequences whole.
      buffer += decoder.decode(step.value, { stream: true })
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        throw new Error('SSE frame exceeded buffer limit')
      }
      let index = splitIndex(buffer, scanFrom)
      while (index !== -1) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + separatorLength(buffer, index))
        scanFrom = 0
        const parsed = parseFrame(frame)
        if (parsed !== undefined) yield parsed
        index = splitIndex(buffer, 0)
      }
      scanFrom = Math.max(0, buffer.length - 3)
    }
    buffer += decoder.decode()
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      throw new Error('SSE frame exceeded buffer limit')
    }
    const tail = parseFrame(buffer)
    if (tail !== undefined) yield tail
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
