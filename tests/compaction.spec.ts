import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const presets = ['standard', 'ptc', 'minimal', 'cordis'] as const

describe('agent preset compaction wiring', () => {
  it('enables automatic compaction in every shipped preset', () => {
    for (const preset of presets) {
      const patch = readFileSync(new URL('../presets/' + preset + '.patch.yml', import.meta.url), 'utf8')
      expect(patch, preset).toContain("@deepseek-ai/dsh-compaction-basic")
      expect(patch, preset).toContain("@deepseek-ai/dsh-command-compact")
    }
  })

  it('mounts the tool-result pruner where the preset expects it', () => {
    for (const preset of ['standard', 'ptc', 'cordis'] as const) {
      const patch = readFileSync(new URL('../presets/' + preset + '.patch.yml', import.meta.url), 'utf8')
      expect(patch, preset).toContain("@deepseek-ai/dsh-compaction-tool-result-pruner")
    }
  })
})
