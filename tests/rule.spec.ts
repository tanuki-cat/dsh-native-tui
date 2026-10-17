import { describe, expect, it } from 'vitest'
import { Rule } from '../src/ui/rule.js'

describe('Rule', () => {
  it('renders a padded full-width line', () => {
    expect(new Rule(text => text, 1).render(8)).toEqual([' ──────'])
  })

  it('never renders a negative-width line', () => {
    expect(new Rule(text => text, 2).render(3)).toEqual(['  '])
  })
})
