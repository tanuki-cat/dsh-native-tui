import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Result of one static HTML transcript export. */
export interface HtmlExportResult {
  readonly path: string
  readonly eventCount: number
  readonly bytes: number
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function contentText(message: { readonly content?: readonly unknown[] }): string {
  const parts: string[] = []
  for (const block of message.content ?? []) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { readonly type?: unknown; readonly text?: unknown; readonly attachment?: { readonly name?: unknown; readonly mediaType?: unknown } }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
    else if (candidate.type === 'file') parts.push('[file ' + String(candidate.attachment?.name ?? '') + ']')
    else if (candidate.type === 'image') parts.push('[image ' + String(candidate.attachment?.name ?? candidate.attachment?.mediaType ?? '') + ']')
  }
  return parts.join('\n')
}

function section(kind: string, title: string, body: string): string {
  return '<section class="' + kind + '"><h2>' + escapeHtml(title) + '</h2><pre>' + escapeHtml(body) + '</pre></section>'
}

/**
 * Write a standalone static HTML transcript of the current Session.
 * @param agent - active Agent whose durable log is exported.
 * @param target - relative path resolved from cwd, or an absolute path.
 * @param cwd - Session workspace root used for relative targets.
 * @returns written path, event count, and byte length.
 */
export async function exportSessionHtml(agent: Agent, target: string, cwd: string): Promise<HtmlExportResult> {
  const path = resolve(cwd, target)
  const session = agent.session
  const events = session.snapshotEvents()
  const chunks: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = (event.data as { readonly source?: { readonly kind?: unknown } }).source
      const text = contentText(event.data as { readonly content?: readonly unknown[] })
      if (text.trim() === '') continue
      chunks.push(section(source?.kind === 'user' ? 'user' : 'context', source?.kind === 'user' ? 'You' : 'Context', text))
    } else if (event.type === 'assistant/message') {
      const text = contentText(event.data as { readonly content?: readonly unknown[] })
      if (text.trim() === '') continue
      chunks.push(section('assistant', 'Assistant', text))
    } else if (event.type === 'tool/call') {
      const data = event.data as { readonly name?: unknown; readonly arguments?: unknown }
      chunks.push(section('tool', 'Tool · ' + String(data.name ?? 'tool'), String(data.arguments ?? '')))
    } else if (event.type === 'tool/result') {
      const data = event.data as {
        readonly message?: { readonly isError?: unknown; readonly content?: readonly unknown[] }
      }
      const text = contentText(data.message ?? {})
      chunks.push(section(data.message?.isError === true ? 'tool error' : 'tool-result', data.message?.isError === true ? 'Tool error' : 'Tool result', text))
    } else if ((event.type as string) === 'deliverables/presented') {
      const files = (event.data as { readonly files?: unknown }).files
      if (Array.isArray(files)) {
        const text = files.map(item => String((item as { readonly path?: unknown }).path ?? '')).join('\n')
        chunks.push(section('deliverables', 'Deliverables', text))
      }
    }
  }
  const exportedAt = new Date().toISOString()
  const html = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>DeepSeek Harness Session ' + escapeHtml(String(session.header.id)) + '</title>'
    + '<style>'
    + ':root{color-scheme:dark}body{margin:0;background:#11151c;color:#d7dde8;font:14px/1.55 ui-sans-serif,system-ui,sans-serif}'
    + 'main{max-width:960px;margin:0 auto;padding:24px}header{border-bottom:1px solid #2b3442;margin-bottom:16px}'
    + 'h1{font-size:20px;margin:0 0 6px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8b98aa;margin:0 0 6px}'
    + 'section{background:#171d27;border:1px solid #273140;border-radius:8px;padding:12px 14px;margin:10px 0}'
    + 'section.user{border-color:#315b86}section.assistant{border-color:#2d6349}section.tool,section.tool-result{border-color:#5a4a2a}'
    + 'section.error{border-color:#7c3535}pre{white-space:pre-wrap;word-break:break-word;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,monospace}'
    + 'footer{color:#7d8998;margin-top:20px;font-size:12px}</style></head><body><main>'
    + '<header><h1>DeepSeek Harness Session</h1><div>' + escapeHtml(String(session.header.id))
    + ' · ' + escapeHtml(session.header.cwd ?? cwd) + ' · ' + String(events.length) + ' events</div></header>'
    + chunks.join('\n')
    + '<footer>Exported ' + escapeHtml(exportedAt) + ' by dsh-native-tui.</footer></main></body></html>\n'
  await writeFile(path, html, { encoding: 'utf8', flag: 'wx' })
  return { path, eventCount: events.length, bytes: Buffer.byteLength(html) }
}