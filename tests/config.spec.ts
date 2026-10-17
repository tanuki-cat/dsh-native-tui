import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('applies terminal defaults', () => {
    const config = resolveConfig(undefined)
    expect(config.showReasoning).toBe(true)
    expect(config.maxTranscriptEntries).toBe(2000)
    expect(config.fullscreen).toBe(false)
    expect(config.theme).toBe('auto')
    expect(config.cwd).toBe(process.cwd())
    expect(config.title).toBe('DeepSeek Harness')
  })

  it('keeps explicit values', () => {
    const config = resolveConfig({
      sessionId: 'session-1',
      cwd: '/tmp/workspace',
      showReasoning: false,
      maxTranscriptEntries: 50,
      fullscreen: true,
      theme: 'plain',
      agentPreset: 'minimal',
      title: 'TUI',
    })
    expect(config.sessionId).toBe('session-1')
    expect(config.cwd).toBe('/tmp/workspace')
    expect(config.showReasoning).toBe(false)
    expect(config.maxTranscriptEntries).toBe(50)
    expect(config.fullscreen).toBe(true)
    expect(config.theme).toBe('plain')
    expect(config.agentPreset).toBe('minimal')
    expect(config.title).toBe('TUI')
  })
})