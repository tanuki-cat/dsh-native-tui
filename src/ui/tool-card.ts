import { Box, Container, Spacer, Text, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui'
import type { TranscriptBlock, TranscriptOptions } from './transcript.js'
import { renderWriteCard } from './write-card.js'
import { languageForPath } from './code-preview.js'
import { renderEditDiff } from './edit-card.js'
import { renderCodeExecutionCard } from './code-execution-card.js'
import { formatToolArguments } from './tool-preview.js'
import { literalToolText, toolLabel, ToolOutput } from './tool-output.js'

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
type Arguments = Readonly<Record<string, unknown>>
function argumentsOf(raw: string): Arguments | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Arguments : undefined
  } catch { return undefined }
}
const stringArg = (args: Arguments | undefined, key: string): string | undefined => typeof args?.[key] === 'string' ? args[key] as string : undefined
const inline = toolLabel

/** A tool call keeps its identity and local expansion through stream updates. */
export class ToolCard implements Component {
  private args: Arguments | undefined
  private expanded: boolean
  private component: Component | undefined
  constructor(private block: ToolBlock, private readonly options: TranscriptOptions) {
    this.args = argumentsOf(block.args)
    this.expanded = options.toolsExpanded ?? false
  }

  update(block: ToolBlock): void {
    if (this.block.args !== block.args) this.args = argumentsOf(block.args)
    this.block = block
    this.component = undefined
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.component = undefined
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left' || event.y !== 0 || event.shift || event.alt || event.ctrl) return undefined
    this.setExpanded(!this.expanded)
    return { handled: true }
  }

  render(width: number): string[] {
    this.component ??= this.build()
    return this.component.render(width)
  }

  invalidate(): void { this.component?.invalidate?.() }

  private build(): Component {
    const { block, args, expanded } = this
    const palette = this.options.palette
    if (block.name === 'run_code') return renderCodeExecutionCard(block, { ...this.options, toolsExpanded: expanded })
    const container = new Container()
    const box = new Box(1, 0, palette.toolBand)
    box.addChild(container)
    if (block.name === 'write') { container.addChild(renderWriteCard(block, palette, expanded)); return box }
    const path = stringArg(args, 'file_path') ?? stringArg(args, 'path')
    const shell = block.name === 'bash' || block.name === 'pwsh'
    const diffs = block.diffs ?? []
    const mcp = /^mcp__(.+?)__(.+)$/u.exec(block.name)
    const name = mcp === null ? block.name : 'mcp ' + mcp[1] + '/' + mcp[2]
    const title = (path?: string): string => palette.bold(toolLabel(name, 120)) + (path === undefined ? '' : ' ' + palette.accent(toolLabel(path, 160, 'end')))
    if (diffs.length > 0) {
      for (const diff of diffs) {
        container.addChild(new Text(title(diffs.length === 1 ? path ?? diff.path : diff.path), 0, 0))
        container.addChild(renderEditDiff(diff, palette, expanded))
      }
    } else if (shell) {
      const command = stringArg(args, 'command')
      const commandLines = command?.replace(/\r\n?/g, '\n').trimEnd().split('\n') ?? []
      const firstLine = commandLines[0] ?? ''
      const head = command === undefined ? '[invalid command arg]' : toolLabel(firstLine, 120) || '…'
      const extraLines = Math.max(0, commandLines.length - 1)
      const commandShortened = extraLines > 0 || literalToolText(firstLine).length > 120
      const suffix = extraLines > 0 ? palette.dim(' … (' + extraLines + ' more command lines)') : ''
      container.addChild(new Text(palette.bold((block.name === 'pwsh' ? 'PS> ' : '$ ') + head) + suffix, 0, 0))
      if (commandShortened && !expanded) container.addChild(new Text(palette.dim('(command shortened · ctrl+o to expand)'), 0, 0))
      if (command === undefined && block.args.trim() !== '') container.addChild(new Text(palette.dim(literalToolText(formatToolArguments(block.args))), 0, 0))
      const meta: string[] = []
      const description = stringArg(args, 'description')
      if (description) meta.push(inline(description))
      const cwd = stringArg(args, 'workdir')
      if (cwd) meta.push('workdir ' + inline(cwd))
      if (typeof args?.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) meta.push('timeout ' + (args.timeoutMs % 1000 === 0 ? args.timeoutMs / 1000 + 's' : args.timeoutMs + 'ms'))
      if (args?.run_in_background === true) meta.push('background')
      if (typeof args?.sandbox_permissions === 'string') meta.push('sandbox ' + inline(args.sandbox_permissions))
      if (meta.length > 0) container.addChild(new Text(palette.dim(meta.join(' · ')), 0, 0))
      if (expanded && command !== undefined && commandShortened) {
        container.addChild(new Spacer(1))
        container.addChild(new Text(palette.dim('command'), 0, 0))
        container.addChild(new ToolOutput(command, palette, true, 10, 'start', false, block.name === 'pwsh' ? 'powershell' : 'bash'))
      }
    } else {
      const pattern = stringArg(args, 'pattern')
      const search = ['grep', 'glob', 'find'].includes(block.name) && pattern !== undefined
      let head = search ? palette.bold(block.name) + ' ' + palette.accent(inline(JSON.stringify(pattern))) + (path ? ' ' + toolLabel(path, 160, 'end') : '') : title(path)
      if (block.name === 'read' && (typeof args?.offset === 'number' || typeof args?.limit === 'number')) {
        const start = typeof args.offset === 'number' ? args.offset : 1
        head += palette.dim(':' + start + (typeof args?.limit === 'number' ? '-' + (start + args.limit - 1) : ''))
      } else if (!search && path === undefined && args !== undefined) {
        const summary = Object.entries(args).slice(0, 5).map(([key, value]) => key + '=' + inline(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value))).join(' ')
        head += ' ' + palette.dim(summary.length > 160 ? summary.slice(0, 159) + '…' : summary)
      }
      container.addChild(new Text(head, 0, 0))
      if (args === undefined && block.args.trim() !== '') container.addChild(new Text(palette.dim(literalToolText(formatToolArguments(block.args))), 0, 0))
      else if (expanded && block.name !== 'read' && block.name !== 'edit') container.addChild(new Text(palette.dim(literalToolText(formatToolArguments(block.args))), 0, 0))
    }
    const result = block.result
    if (result?.trim() && (block.isError || (diffs.length === 0 && (block.name !== 'read' || expanded)))) {
      container.addChild(new Spacer(1))
      container.addChild(new ToolOutput(result, palette, expanded, shell ? 5 : 10, shell ? 'end' : 'start', block.isError, block.name === 'read' ? languageForPath(path) : undefined))
    } else if (result?.trim() && block.name === 'read' && !expanded) {
      container.addChild(new Text(palette.dim('(ctrl+o to expand)'), 0, 0))
    }
    if (block.pending) container.addChild(new Text(palette.warning('└ running…'), 0, 0))
    else if (block.isError) container.addChild(new Text(palette.error('└ error'), 0, 0))
    return box
  }
}
