import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  activeAtToken,
  formatFileMention,
  type FileReferenceCandidate,
  type FileReferenceService,
} from '@deepseek-ai/dsh-file-reference'

/** Minimal command projection the editor needs for slash completion. */
export interface CommandSuggestion {
  readonly name: string
  readonly description?: string
  readonly input?: { readonly hint?: string }
  readonly subcommands?: readonly {
    readonly name: string
    readonly description?: string
    readonly hint?: string
  }[]
}

/** One host-exported session mention candidate. */
export interface SessionReferenceCandidateView {
  readonly sessionId: string
  readonly label: string
  readonly displayTitle?: string
  readonly cwd?: string
  readonly mention: string
}

/** Host capability that exports canonical session mentions for autocomplete. */
export interface SessionReferenceService {
  remoteExportCandidates(agent: Agent, query: string, signal: AbortSignal): Promise<readonly SessionReferenceCandidateView[]>
}

/** Dependencies of the terminal completion provider. */
export interface TuiAutocompleteOptions {
  getAgent(): Agent
  getCommands(): readonly CommandSuggestion[]
  getFileReferences(): FileReferenceService | undefined
  getSessionReferences(): SessionReferenceService | undefined
}

function activeSessionToken(line: string, cursorCol: number): { prefix: string; query: string } | undefined {
  const before = line.slice(0, cursorCol)
  const match = /(^|\s)@@([^\s@]*)$/.exec(before)
  if (match === null) return undefined
  return { prefix: '@@' + match[2]!, query: match[2]! }
}

/** Combine slash-command, host-backed @file, and @@session completion in one editor provider. */
export class TuiAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ['@', '/']

  constructor(private readonly options: TuiAutocompleteOptions) {}

  async getSuggestions(
    lines: readonly string[],
    cursorLine: number,
    cursorCol: number,
    request: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    if (request.signal.aborted) return null
    const line = lines[cursorLine] ?? ''
    const beforeCursor = line.slice(0, cursorCol)

    if (beforeCursor.startsWith('/')) {
      const body = beforeCursor.slice(1)
      const space = body.indexOf(' ')
      const commands = this.options.getCommands()
      if (space === -1) {
        const query = body.toLowerCase()
        const exact = commands.find(command => command.name.toLowerCase() === query)
        if (exact?.subcommands !== undefined && exact.subcommands.length > 0) {
          const items: AutocompleteItem[] = exact.subcommands.map(subcommand => ({
            value: '/' + exact.name + ' ' + subcommand.name,
            label: '/' + exact.name + ' ' + subcommand.name + (subcommand.hint === undefined ? '' : ' ' + subcommand.hint),
            ...(subcommand.description === undefined && subcommand.hint === undefined
              ? {}
              : { description: subcommand.description ?? subcommand.hint ?? '' }),
          }))
          return items.length === 0 ? null : { items, prefix: beforeCursor }
        }
        const items: AutocompleteItem[] = commands
          .filter(command => command.name.toLowerCase().startsWith(query))
          .map(command => ({
            value: '/' + command.name,
            label: '/' + command.name,
            ...(command.description === undefined && command.input?.hint === undefined
              ? {}
              : { description: command.description ?? command.input?.hint ?? '' }),
          }))
        return items.length === 0 ? null : { items, prefix: beforeCursor }
      }
      const commandName = body.slice(0, space).toLowerCase()
      const argument = body.slice(space + 1)
      const command = commands.find(candidate => candidate.name.toLowerCase() === commandName)
      if (command === undefined || command.subcommands === undefined || command.subcommands.length === 0 || argument.includes(' ')) {
        return null
      }
      const query = argument.toLowerCase()
      const items: AutocompleteItem[] = command.subcommands
        .filter(subcommand => subcommand.name.toLowerCase().startsWith(query))
        .map(subcommand => ({
          value: subcommand.name,
          label: subcommand.name + (subcommand.hint === undefined ? '' : ' ' + subcommand.hint),
          ...(subcommand.description === undefined
            ? {}
            : { description: subcommand.description }),
        }))
      return items.length === 0 ? null : { items, prefix: argument }
    }

    const sessionToken = activeSessionToken(line, cursorCol)
    if (sessionToken !== undefined) {
      const sessions = this.options.getSessionReferences()
      if (sessions === undefined) return null
      let candidates: readonly SessionReferenceCandidateView[]
      try {
        candidates = await sessions.remoteExportCandidates(this.options.getAgent(), sessionToken.query, request.signal)
      } catch {
        return null
      }
      if (request.signal.aborted) return null
      const items: AutocompleteItem[] = candidates.map(candidate => ({
        value: candidate.mention,
        label: candidate.displayTitle ?? candidate.label,
        description: candidate.cwd ?? candidate.sessionId,
      }))
      return items.length === 0 ? null : { items, prefix: sessionToken.prefix }
    }

    const token = activeAtToken(line, cursorCol)
    if (token === undefined) return null
    const service = this.options.getFileReferences()
    if (service === undefined) return null

    let candidates: FileReferenceCandidate[]
    try {
      candidates = await service.list(this.options.getAgent(), token.query, request.signal)
    } catch {
      return null
    }
    if (request.signal.aborted) return null
    const items: AutocompleteItem[] = []
    for (const candidate of candidates) {
      const value = formatFileMention(candidate, token.quoted)
      if (value === undefined) continue
      items.push({
        value,
        label: candidate.path + (candidate.kind === 'directory' ? '/' : ''),
        description: candidate.kind,
      })
    }
    return items.length === 0 ? null : { items, prefix: token.prefix }
  }

  applyCompletion(
    lines: readonly string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? ''
    const start = Math.max(0, cursorCol - prefix.length)
    const next = line.slice(0, start) + item.value + line.slice(cursorCol)
    const nextLines = [...lines]
    nextLines[cursorLine] = next
    return { lines: nextLines, cursorLine, cursorCol: start + item.value.length }
  }
}
