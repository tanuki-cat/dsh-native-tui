import { describe, expect, it } from 'vitest'
import { NEUTRAL_IDENTITY, PROMPT_PLACEHOLDER, expandSystemPrompt, neutralizeAgentIdentity } from '../src/codebuddy/prompt.js'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const TOKENS_SENTENCE = 'Tokens prefixed with @ are paths the user explicitly referenced.'
const TOKENS_PARAGRAPH = TOKENS_SENTENCE
  + ' Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.'
  + ' A trailing slash marks a directory: list it when its contents matter.'
  + ' Anything else is a file: use the read tool when its contents are needed.'
const RESTATED_TOKENS = 'Tokens starting with @ name paths the user referenced.'

describe('neutralizeAgentIdentity', () => {
  it('restates the harness identity line and keeps the rest of the prompt', () => {
    const prompt = IDENTITY + '\n\nYou are a coding agent powered by the model.\n\nTools: run_code.'
    const out = neutralizeAgentIdentity(prompt)
    expect(out).toBe(NEUTRAL_IDENTITY + '\n\nYou are a coding agent powered by the model.\n\nTools: run_code.')
    expect(out).not.toContain('AI agent powered by')
  })

  it('restates the fingerprinted sentence and keeps the rest of its paragraph', () => {
    const out = neutralizeAgentIdentity(TOKENS_PARAGRAPH)
    expect(out).toBe(RESTATED_TOKENS + TOKENS_PARAGRAPH.slice(TOKENS_SENTENCE.length))
    expect(out).not.toContain('explicitly referenced')
  })

  it('restates a fingerprinted sentence in a prompt with no identity line', () => {
    expect(neutralizeAgentIdentity('Intro.\n\n' + TOKENS_PARAGRAPH + '\n\nOutro.'))
      .toBe('Intro.\n\n' + RESTATED_TOKENS + TOKENS_PARAGRAPH.slice(TOKENS_SENTENCE.length) + '\n\nOutro.')
  })

  it('restates every fingerprinted span in one prompt', () => {
    const out = neutralizeAgentIdentity(IDENTITY + '\n\n' + TOKENS_PARAGRAPH)
    expect(out).toBe(NEUTRAL_IDENTITY + '\n\n' + RESTATED_TOKENS + TOKENS_PARAGRAPH.slice(TOKENS_SENTENCE.length))
  })

  it('leaves a paraphrase of the fingerprinted sentence alone', () => {
    const prompt = 'Tokens beginning with @ denote paths the user referenced. Relative paths start at the workspace root;'
    expect(neutralizeAgentIdentity(prompt)).toBe(prompt)
  })

  it('ignores a neutral prompt and returns it unchanged', () => {
    const prompt = 'You are a helpful assistant.\n\nAnswer in one line.'
    expect(neutralizeAgentIdentity(prompt)).toBe(prompt)
  })

  it('is idempotent', () => {
    const once = neutralizeAgentIdentity(IDENTITY + '\n\n' + TOKENS_PARAGRAPH)
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
