import { describe, expect, it } from 'vitest'
import { Rule } from '../src/ui/rule.js'

describe('Rule', () => {
  it('fills exactly the width it is given', () => {
    expect(new Rule(text => text).render(8)).toEqual(['────────'])
  })

  it('tracks the container width instead of a stored margin', () => {
    for (const width of [1, 7, 80, 201]) {
      const [line] = new Rule(text => text).render(width)
      expect(line).toBe('─'.repeat(width))
    }
  })

  it('never renders a negative-width line', () => {
    expect(new Rule(text => text).render(0)).toEqual([''])
    expect(new Rule(text => text).render(-3)).toEqual([''])
  })

  it('keeps the caller styling', () => {
    expect(new Rule(text => '<' + text + '>').render(3)).toEqual(['<───>'])
  })
})
