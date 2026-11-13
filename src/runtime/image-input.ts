import { homedir } from 'node:os'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectImageMediaType, loadAttachment, type AttachmentsService, type PendingAttachment } from './attachments.js'

export interface ImagePathReference {
  readonly start: number
  readonly end: number
  readonly path: string
}

function imagePath(value: string): string | undefined {
  let path = value.startsWith('@') ? value.slice(1) : value
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1)
  else path = path.replace(/\\([\s'"()\[\]\\])/gu, '$1')
  if (path.startsWith('file://')) {
    try { path = fileURLToPath(path) }
    catch { return undefined }
  }
  if (path.startsWith('~/')) path = homedir() + path.slice(1)
  if (!/\.(?:png|jpe?g|gif|webp)$/iu.test(extname(path))) return undefined
  if (!value.startsWith('@') && !/^(?:\/|\.\.?\/|~\/|file:\/\/|["'])/u.test(value)) return undefined
  return path
}

/** Recognize a pasted path/list, or explicit @image references mixed with prose. */
export function imagePathReferences(text: string): ImagePathReference[] {
  if (text.trimStart().startsWith('/') && /^\/[a-z][\w-]*(?:\s|$)/iu.test(text.trimStart())) return []
  const refs: ImagePathReference[] = []
  const tokens = /@?(?:"[^"\n]+"|'[^'\n]+'|(?:\\[^\n]|[^\s"'])+)/gu
  let onlyPaths = true
  for (const match of text.matchAll(tokens)) {
    const path = imagePath(match[0])
    if (path === undefined) { onlyPaths = false; continue }
    refs.push({ start: match.index, end: match.index + match[0].length, path })
  }
  return onlyPaths ? refs : refs.filter(ref => text[ref.start] === '@')
}

/** Import candidates independently; failed references stay editable as their original text. */
export async function importImagePaste(
  text: string,
  options: {
    readonly cwd: string
    readonly attachments: AttachmentsService
    readonly pending: PendingAttachment[]
    isCurrent(): boolean
    onError(path: string, error: unknown): void
    onImported?(ref: ImagePathReference): void
  },
): Promise<string> {
  const refs = imagePathReferences(text)
  let result = '', offset = 0
  for (const ref of refs) {
    try {
      // Verify bytes before saveImages: a renamed text file is not an image.
      const verified: AttachmentsService = { ...options.attachments,
        saveImages: inputs => options.attachments.saveImages(inputs.map(input => {
          const mediaType = detectImageMediaType(input.data)
          if (mediaType === undefined) throw new Error('unsupported image format; expected PNG, JPEG, GIF, or WebP')
          return { ...input, mediaType }
        })),
      }
      const pending = await loadAttachment(ref.path, options.cwd, verified)
      if (!options.isCurrent()) return text
      options.pending.push(pending)
      result += text.slice(offset, ref.start)
      offset = ref.end
      options.onImported?.(ref)
    }
    catch (error) {
      if (!options.isCurrent()) return text
      options.onError(ref.path, error)
    }
  }
  const remaining = result + text.slice(offset)
  return refs.length > 0 && remaining.trim() === '' ? '' : remaining
}
