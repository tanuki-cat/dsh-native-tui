import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const permission = patch.split('- id: permission\n')[1]?.split('\n#')[0]

describe('bundled native permission presets', () => {
  it('defaults to native workspace permissions while preserving the environment override', () => {
    expect(permission).toContain("defaultPreset: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'")
  })

  it.each([
    ['read-only', 'read-only', 'ask'],
    ['workspace-write', 'workspace-write', 'ask'],
    ['danger-full-access', 'danger-full-access', 'never'],
  ])('keeps %s selectable alongside TUI modes', (name, sandbox, approval) => {
    expect(permission).toContain('      ' + name + ':\n        sandbox: ' + sandbox + '\n        approval: ' + approval)
  })
})
