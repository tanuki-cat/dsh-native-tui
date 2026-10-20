import { describe, expect, it } from 'vitest'
import { NEUTRAL_IDENTITY, neutralizeAgentIdentity } from '../src/codebuddy/prompt.js'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

describe('neutralizeAgentIdentity', () => {
  it('restates the harness identity line and keeps the rest of the prompt', () => {
    const prompt = IDENTITY + '\n\nYou are a coding agent powered by the model.\n\nTools: run_code.'
    const out = neutralizeAgentIdentity(prompt)
    expect(out).toBe(NEUTRAL_IDENTITY + '\n\nYou are a coding agent powered by the model.\n\nTools: run_code.')
    expect(out).not.toContain('AI agent powered by')
  })

  it('ignores a neutral prompt and returns it unchanged', () => {
    const prompt = 'You are a helpful assistant.\n\nAnswer in one line.'
    expect(neutralizeAgentIdentity(prompt)).toBe(prompt)
  })

  it('is idempotent', () => {
    const once = neutralizeAgentIdentity(IDENTITY + '\n\nbody')
    expect(neutralizeAgentIdentity(once)).toBe(once)
  })

  it('matches the identity line case-insensitively and anywhere in the prompt', () => {
    const prompt = 'Intro.\n' + IDENTITY.toLowerCase() + '\nOutro.'
    expect(neutralizeAgentIdentity(prompt)).toBe('Intro.\n' + NEUTRAL_IDENTITY + '\nOutro.')
  })

  it('leaves a coding-agent line with a different shape alone', () => {
    const prompt = 'You are a coding agent powered by the model.'
    expect(neutralizeAgentIdentity(prompt)).toBe(prompt)
  })
})
