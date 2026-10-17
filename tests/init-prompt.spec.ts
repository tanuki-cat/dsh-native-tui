import { describe, expect, it } from 'vitest'
import { INIT_AGENTS_PROMPT } from '../src/runtime/init-prompt.js'

describe('INIT_AGENTS_PROMPT', () => {
  it('asks for a project-level AGENTS.md contributor guide', () => {
    expect(INIT_AGENTS_PROMPT).toContain('AGENTS.md')
    expect(INIT_AGENTS_PROMPT).toContain('contributor guide')
  })

  it('protects an existing AGENTS.md from being overwritten', () => {
    expect(INIT_AGENTS_PROMPT).toMatch(/do not overwrite or modify/i)
  })

  it('keeps the Codex outline sections', () => {
    const sections = [
      'Project Structure & Module Organization',
      'Build, Test, and Development Commands',
      'Coding Style & Naming Conventions',
      'Testing Guidelines',
      'Commit & Pull Request Guidelines',
    ]
    for (const section of sections) expect(INIT_AGENTS_PROMPT).toContain(section)
  })

  it('bounds the document length', () => {
    expect(INIT_AGENTS_PROMPT).toContain('200-400 words')
  })
})
