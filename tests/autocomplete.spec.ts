import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileReferenceService } from '@deepseek-ai/dsh-file-reference'
import { TuiAutocompleteProvider, type SessionReferenceCandidateView } from '../src/ui/autocomplete.js'

const agent = { id: 'agent-1' } as unknown as Agent
const signal = new AbortController().signal

function provider(
  files: readonly { path: string; kind: 'file' | 'directory' }[] = [],
  sessions: readonly SessionReferenceCandidateView[] = [],
) {
  const service = {
    list: async () => files,
  } as unknown as FileReferenceService
  const sessionService = {
    remoteExportCandidates: async () => sessions,
  }
  return new TuiAutocompleteProvider({
    getAgent: () => agent,
    getCommands: () => [
      { name: 'help', description: 'show help' },
      { name: 'model', input: { hint: 'provider/model' } },
    ],
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