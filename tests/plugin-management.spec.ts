import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginChangeSuffix, withPluginProgress } from '../src/ui/commands/plugin-result.js'
import { pluginsCommand } from '../src/ui/commands/plugins.js'
import type { PluginChangeResult, PluginManagerService } from '../src/ui/commands/services.js'
import { commandFixture } from './rc1-command-fixture.js'
import { showChoice } from '../src/ui/dialogs.js'
vi.mock('../src/ui/dialogs.js', () => ({ showChoice: vi.fn() }))
const applied: PluginChangeResult = { changed: true, application: 'applied', stage: 'install', target: 'example' }
beforeEach(() => { vi.resetAllMocks() })
describe('plugin operation diagnostics', () => {
  it('preserves the original failure, stage, exit status, output and full log location', () => {
    const text = pluginChangeSuffix({ ...applied, application: 'failed', error: { code: 'package-failed', diagnostic: 'fetch\nfailed' } as never,
      packageResult: { exitCode: 1, output: '\x1b[31mUPSTREAM_ERROR\x1b[0m', logPath: '/tmp/install.log', truncated: true, timedOut: true } })
    expect(text).toContain('stage: install'); expect(text).toContain('fetch\nfailed')
    expect(text).toContain('UPSTREAM_ERROR'); expect(text).not.toContain('\x1b')
    expect(text).toContain('Full log: /tmp/install.log'); expect(text).toContain('timed out'); expect(text).toContain('truncated')
  })
  it('streams only this request and removes all observers after settlement', async () => {
    const f = commandFixture(), cancelInstall = vi.fn()
    await withPluginProgress(f.ctx, { cancelInstall } as unknown as PluginManagerService, async requestId => {
      f.emit('plugin-manager/install-log', { requestId: 'unrelated', text: 'UNRELATED' })
      f.emit('plugin-manager/install-log', { requestId, text: 'OWN_LOG' })
      f.emit('plugin-manager/install-state', { requestId, phase: 'applying' })
      return applied
    })
    expect(f.text()).toContain('OWN_LOG'); expect(f.text()).not.toContain('UNRELATED')
    expect(f.text()).toContain('applying'); expect(f.listenerCount()).toBe(0)
    f.abort.abort(); expect(cancelInstall).not.toHaveBeenCalled()
  })
  it('releases observers when the operation rejects', async () => {
    const f = commandFixture()
    await expect(withPluginProgress(f.ctx, {} as PluginManagerService, async () => { throw new Error('failure') })).rejects.toThrow('failure')
    expect(f.listenerCount()).toBe(0)
  })
  it('requests cancellation for the matching installation and waits for its outcome', async () => {
    const f = commandFixture(), cancelInstall = vi.fn(async () => ({ status: 'cancelled' }))
    let id: string | undefined
    await withPluginProgress(f.ctx, { cancelInstall } as unknown as PluginManagerService, async requestId => {
      id = requestId; f.abort.abort(); return applied
    })
    expect(cancelInstall).toHaveBeenCalledWith(id); expect(f.listenerCount()).toBe(0)
  })
})
function managerOf() {
  return { listVersions: vi.fn(async () => ({ status: 'listed', installed: '1.0.0', registry: 'https://registry.npmjs.org/', attempts: [], omitted: 0,
    versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }] })),
    updateBundle: vi.fn(async () => ({ from: '1.0.0', to: '1.1.0', step: 'install', result: applied })),
    cancelInstall: vi.fn(async () => ({ status: 'not-running' })),
  }
}
describe('explicit registry bundle updates', () => {
  it('lists versions without installing anything', async () => {
    const manager = managerOf(), f = commandFixture({ pluginManager: manager })
    await pluginsCommand(f.ctx, 'versions example')
    expect(f.text()).toContain('1.1.0'); expect(manager.updateBundle).not.toHaveBeenCalled()
  })
  it('passes the selected exact version and answering registry after confirmation', async () => {
    vi.mocked(showChoice).mockResolvedValue('yes')
    const manager = managerOf(), f = commandFixture({ pluginManager: manager })
    await pluginsCommand(f.ctx, 'update example 1.1.0')
    expect(manager.updateBundle).toHaveBeenCalledWith('example', '1.1.0', { registry: 'https://registry.npmjs.org/', requestId: expect.any(String) })
    expect(f.listenerCount()).toBe(0)
  })
  it('does not interpret an arbitrary tag or an unlisted version as an update', async () => {
    const manager = managerOf(), f = commandFixture({ pluginManager: manager })
    await pluginsCommand(f.ctx, 'update example latest')
    expect(manager.updateBundle).not.toHaveBeenCalled(); expect(f.text()).toContain('compatible version returned')
  })
  it('does not update after cancellation', async () => {
    vi.mocked(showChoice).mockResolvedValue('no')
    const manager = managerOf(), f = commandFixture({ pluginManager: manager })
    await pluginsCommand(f.ctx, 'update example 1.1.0')
    expect(manager.updateBundle).not.toHaveBeenCalled()
  })
  it('preserves the Host refusal for link and tarball installations', async () => {
    const manager = managerOf(), f = commandFixture({ pluginManager: manager })
    manager.listVersions.mockResolvedValue({ status: 'refused', problem: 'not-updatable', reason: 'not a registry dependency' } as never)
    await pluginsCommand(f.ctx, 'update example')
    expect(f.text()).toContain('not-updatable'); expect(manager.updateBundle).not.toHaveBeenCalled()
  })
  it('reports a failed update and a separately observed failed restoration', async () => {
    vi.mocked(showChoice).mockResolvedValue('yes')
    const manager = managerOf(), f = commandFixture({ pluginManager: manager })
    manager.updateBundle.mockResolvedValue({ from: '1.0.0', to: '1.1.0', step: 'install', result: { ...applied, application: 'failed', error: { code: 'network', diagnostic: 'target failed' } },
      restore: { ...applied, application: 'failed', error: { code: 'network', diagnostic: 'restore failed' } } } as never)
    await pluginsCommand(f.ctx, 'update example 1.1.0')
    expect(f.text()).toContain('target failed'); expect(f.text()).toContain('restore failed')
    expect(f.notices.filter(row => row.tone === 'error')).toHaveLength(2)
  })
})
