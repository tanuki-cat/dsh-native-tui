import { describe, expect, it } from 'vitest'
import { NEUTRAL_IDENTITY, PROMPT_PLACEHOLDER, expandSystemPrompt, neutralizeAgentIdentity } from '../src/codebuddy/prompt.js'

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

describe('expandSystemPrompt', () => {
  it('expands the placeholder into the harness prompt and keeps the surrounding text', () => {
    expect(expandSystemPrompt('Intro.\n' + PROMPT_PLACEHOLDER + '\nOutro.', 'Harness rules.'))
      .toBe('Intro.\nHarness rules.\nOutro.')
  })

  it('replaces the prompt verbatim when the template has no placeholder', () => {
    expect(expandSystemPrompt('You are CodeBuddy.', 'Harness rules.')).toBe('You are CodeBuddy.')
  })

  it('expands once and leaves a placeholder inside the harness prompt as text', () => {
    expect(expandSystemPrompt(PROMPT_PLACEHOLDER + ' / ' + PROMPT_PLACEHOLDER, 'A ' + PROMPT_PLACEHOLDER + ' B'))
      .toBe('A ' + PROMPT_PLACEHOLDER + ' B / A ' + PROMPT_PLACEHOLDER + ' B')
  })

  it('keeps replacement-pattern characters in the harness prompt literal', () => {
    expect(expandSystemPrompt(PROMPT_PLACEHOLDER, 'cost $& and $1')).toBe('cost $& and $1')
  })
})
