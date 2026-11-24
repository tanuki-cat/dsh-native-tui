/**
 * Read a response body as UTF-8 text while enforcing a hard byte limit.
 *
 * Cancels the underlying stream immediately once incoming bytes exceed
 * `maxBytes` so a misbehaving upstream cannot exhaust process memory.
 * @param response - fetch Response to read.
 * @param maxBytes - maximum allowed body size in bytes.
 * @returns decoded UTF-8 text.
 */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('response maxBytes must be a positive safe integer')
  }
  const body = response.body
  if (body === null) {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error('response body exceeded limit')
    }
    return text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  let done = false
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) {
        done = true
        break
      }
      total += step.value.byteLength
      if (total > maxBytes) {
        throw new Error('response body exceeded limit')
      }
      text += decoder.decode(step.value, { stream: true })
    }
    text += decoder.decode()
    return text
  }
  finally {
    if (!done) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
