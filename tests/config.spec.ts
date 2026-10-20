import { describe, expect, it } from 'vitest'
import { parseResumeArg, resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('applies terminal defaults', () => {
    const config = resolveConfig(undefined)
    expect(config.showReasoning).toBe(true)
    expect(config.thinkingDisplay).toBe('detailed')
    expect(config.runCodeDisplay).toBe('detailed')
    expect(config.maxTranscriptEntries).toBe(2000)
    expect(config.fullscreen).toBe(false)
    expect(config.theme).toBe('auto')
    expect(config.cwd).toBe(process.cwd())
    expect(config.title).toBe('DeepSeek Harness')
  })

  it('parses app-level --resume in both forms', () => {
    expect(parseResumeArg(['--profile', 'tui', '--resume', 'session-1'])).toBe('session-1')
    expect(parseResumeArg(['--resume=session-2'])).toBe('session-2')
    expect(parseResumeArg(['--profile', 'tui'])).toBeUndefined()
    expect(() => parseResumeArg(['--resume'])).toThrow(/requires a session id/u)
  })

  it('maps legacy showReasoning and explicit display modes', () => {
    expect(resolveConfig({ showReasoning: false }).thinkingDisplay).toBe('hidden')
    const explicit = resolveConfig({
      showReasoning: false,
      thinkingDisplay: 'compact',
      runCodeDisplay: 'hidden',
    })
    expect(explicit.thinkingDisplay).toBe('compact')
    expect(explicit.runCodeDisplay).toBe('hidden')
  })

  it('unwraps Volatile references for startup fields', () => {
    const ref = <T>(value: T) => ({ get: () => value })
    const config = resolveConfig({
      sessionId: ref('session-2'),
      cwd: ref('/tmp/volatile'),
      showReasoning: ref(false),
      title: ref('Volatile TUI'),
      agentPreset: ref('minimal'),
    })
    expect(config.sessionId).toBe('session-2')
    expect(config.cwd).toBe('/tmp/volatile')
    expect(config.showReasoning).toBe(false)
    expect(config.thinkingDisplay).toBe('hidden')
    expect(config.title).toBe('Volatile TUI')
    expect(config.agentPreset).toBe('minimal')
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