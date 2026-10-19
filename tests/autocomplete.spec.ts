import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileReferenceService } from '@deepseek-ai/dsh-file-reference'
import { TuiAutocompleteProvider, type CommandSuggestion, type SessionReferenceCandidateView, type SkillSuggestion } from '../src/ui/autocomplete.js'
import { LOCAL_COMMANDS } from '../src/ui/commands/catalog.js'

const agent = { id: 'agent-1' } as unknown as Agent
const signal = new AbortController().signal

function provider(
  files: readonly { path: string; kind: 'file' | 'directory' }[] = [],
  sessions: readonly SessionReferenceCandidateView[] = [],
  skills: readonly SkillSuggestion[] = [],
  commands?: readonly CommandSuggestion[],
) {
  const service = {
    list: async () => files,
  } as unknown as FileReferenceService
  const sessionService = {
    remoteExportCandidates: async () => sessions,
  }
  return new TuiAutocompleteProvider({
    getAgent: () => agent,
    getCommands: () => commands ?? [
      { name: 'help', description: 'show help' },
      { name: 'model', input: { hint: 'provider/model' } },
      {
        name: 'provider',
        description: 'provider setup',
        subcommands: [
          { name: 'add', description: 'add a route' },
          { name: 'list' },
          { name: 'remove', description: 'delete a route', hint: '<route>' },
        ],
      },
    ],
    getSkills: async () => skills,
    getFileReferences: () => service,
    getSessionReferences: () => sessionService,
  })
}

describe('TuiAutocompleteProvider', () => {
  it('completes slash commands in the first token', async () => {
    const suggestions = await provider().getSuggestions(['/he'], 0, 3, { signal })
    expect(suggestions?.prefix).toBe('/he')
    expect(suggestions?.items).toEqual([
      { value: '/help', label: '/help', description: 'show help' },
    ])
  })

  it('shows subcommands for an exact command', async () => {
    const suggestions = await provider().getSuggestions(['/provider'], 0, 9, { signal })
    expect(suggestions?.prefix).toBe('/provider')
    expect(suggestions?.items).toEqual([
      { value: '/provider add', label: '/provider add', description: 'add a route' },
      { value: '/provider list', label: '/provider list' },
      { value: '/provider remove', label: '/provider remove <route>', description: 'delete a route' },
    ])
  })

  it('lists reasoning map while keeping bare reasoning submittable', async () => {
    const exact = await provider([], [], [], LOCAL_COMMANDS).getSuggestions(['/reasoning'], 0, 10, { signal })
    expect(exact?.prefix).toBe('/reasoning')
    expect(exact?.items[0]).toEqual({
      value: '/reasoning',
      label: '/reasoning',
      description: 'select the reasoning effort or edit its mapping',
    })
    expect(exact?.items).toContainEqual({
      value: '/reasoning map',
      label: '/reasoning map',
      description: 'guide an edit of the current model reasoning map',
    })

    const spaced = await provider([], [], [], LOCAL_COMMANDS).getSuggestions(['/reasoning '], 0, 11, { signal })
    expect(spaced?.prefix).toBe('/reasoning ')
    expect(spaced?.items).toEqual([{
      value: '/reasoning map',
      label: 'map',
      description: 'guide an edit of the current model reasoning map',
    }])

    // Fully typed subcommands submit directly; no second Enter for completion.
    expect(await provider([], [], [], LOCAL_COMMANDS).getSuggestions(['/reasoning map'], 0, 14, { signal })).toBeNull()
    expect(await provider().getSuggestions(['/provider add'], 0, 13, { signal })).toBeNull()
  })

  it('keeps hinted subcommands insert-only after a command space', async () => {
    const suggestions = await provider().getSuggestions(['/provider re'], 0, 12, { signal })
    expect(suggestions?.prefix).toBe('re')
    expect(suggestions?.items).toEqual([
      { value: 'remove', label: 'remove <route>', description: 'delete a route' },
    ])
  })

  it('submits a uniquely filtered leaf subcommand in a mixed command', async () => {
    const suggestions = await provider().getSuggestions(['/provider a'], 0, 11, { signal })
    expect(suggestions?.prefix).toBe('/provider a')
    expect(suggestions?.items).toEqual([
      { value: '/provider add', label: 'add', description: 'add a route' },
    ])
  })

  it('keeps a mixed full subcommand list insert-only', async () => {
    const suggestions = await provider().getSuggestions(['/provider '], 0, 10, { signal })
    expect(suggestions?.prefix).toBe('')
    expect(suggestions?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'add', label: 'add' }),
      expect.objectContaining({ value: 'remove', label: 'remove <route>' }),
    ]))
  })

  it('inserts a hinted subcommand without submitting the command', () => {
    const applied = provider().applyCompletion(['/provider re'], 0, 12, {
      value: 'remove',
      label: 'remove <route>',
    }, 're')
    expect(applied).toEqual({ lines: ['/provider remove'], cursorLine: 0, cursorCol: 16 })
  })

  it('replaces the whole line for a leaf subcommand', () => {
    const applied = provider([], [], [], LOCAL_COMMANDS).applyCompletion(['/reasoning '], 0, 11, {
      value: '/reasoning map',
      label: 'map',
    }, '/reasoning ')
    expect(applied).toEqual({ lines: ['/reasoning map'], cursorLine: 0, cursorCol: 14 })
  })

  it('lists user-invocable skills after the commands', async () => {
    const skills: readonly SkillSuggestion[] = [
      { name: 'daily-log-writer', description: 'write the daily log', modelInvocable: false },
      { name: 'find-skills', description: 'discover skills', modelInvocable: true },
      { name: 'help', description: 'shadowed by the command', modelInvocable: true },
    ]
    const userOnly = await provider([], [], skills).getSuggestions(['/da'], 0, 3, { signal })
    expect(userOnly?.items).toEqual([
      { value: '/daily-log-writer', label: '/daily-log-writer', description: 'user-only · write the daily log' },
    ])
    const skillOnly = await provider([], [], skills).getSuggestions(['/fi'], 0, 3, { signal })
    expect(skillOnly?.items).toEqual([
      { value: '/find-skills', label: '/find-skills', description: 'discover skills' },
    ])
    // A command with the same name wins and the skill is not duplicated.
    const shadowed = await provider([], [], skills).getSuggestions(['/he'], 0, 3, { signal })
    expect(shadowed?.items).toEqual([
      { value: '/help', label: '/help', description: 'show help' },
    ])
  })

  it('completes @file candidates through the host service', async () => {
    const suggestions = await provider([
      { path: 'src', kind: 'directory' },
      { path: 'src/main.ts', kind: 'file' },
    ]).getSuggestions(['see @sr'], 0, 7, { signal })
    expect(suggestions?.prefix).toBe('@sr')
    expect(suggestions?.items).toEqual([
      { value: '@src/', label: 'src/', description: 'directory' },
      { value: '@src/main.ts', label: 'src/main.ts', description: 'file' },
    ])
  })

  it('completes @@session mentions', async () => {
    const suggestions = await provider([], [{
      sessionId: 'session-2',
      label: 'Plan',
      mention: '@[Plan](dsh-session:c2Vzc2lvbi0y)',
    }]).getSuggestions(['see @@pl'], 0, 8, { signal })
    expect(suggestions?.prefix).toBe('@@pl')
    expect(suggestions?.items).toEqual([{
      value: '@[Plan](dsh-session:c2Vzc2lvbi0y)',
      label: 'Plan',
      description: 'session-2',
    }])
  })

  it('does not complete an @ inside another token', async () => {
    const suggestions = await provider([{ path: 'src', kind: 'file' }])
      .getSuggestions(['mail me@example.com'], 0, 20, { signal })
    expect(suggestions).toBeNull()
  })

  it('applies a completion over the active prefix', () => {
    const applied = provider().applyCompletion(['see @sr'], 0, 7, {
      value: '@src/',
      label: 'src/',
    }, '@sr')
    expect(applied).toEqual({ lines: ['see @src/'], cursorLine: 0, cursorCol: 9 })
  })
})