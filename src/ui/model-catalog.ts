import { Text, matchesKey } from '@earendil-works/pi-tui'
import type { TUI } from '@earendil-works/pi-tui'
import type { LLM } from './commands/services.js'
import type { Palette } from './theme.js'
import { dialogFrame } from './dialogs.js'

/** One Host-owned model catalogue; failures are not empty catalogues. */
export interface ProviderListing {
  readonly provider: { readonly id: string }
  readonly models: Awaited<ReturnType<LLM['listModels']>>
  readonly error?: string
}

/** Collect Host catalogues concurrently behind a cancellable loading surface. */
export async function loadModelCatalog(
  llm: LLM, tui: TUI, palette: Palette, signal: AbortSignal,
): Promise<readonly ProviderListing[] | undefined> {
  if (signal.aborted) return undefined
  const providers = llm.listProviders()
  const controller = new AbortController()
  const cancel = (): void => { controller.abort() }
  const canceled = new Promise<undefined>(resolve => {
    controller.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
  })
  signal.addEventListener('abort', cancel, { once: true })
  let completed = 0
  let handle: ReturnType<TUI['showOverlay']> | undefined
  try {
    handle = tui.showOverlay({
      render: (width: number) => dialogFrame([
        ...new Text('Loading model catalogs · ' + completed + '/' + providers.length, 0, 0).render(Math.max(1, width - 4)),
        '',
        ...new Text(palette.dim('Host cache and fallback apply · Esc cancels'), 0, 0).render(Math.max(1, width - 4)),
      ], width, palette),
      handleInput: (data: string) => { if (matchesKey(data, 'escape')) cancel() },
      invalidate: () => {},
    }, { width: 84, maxHeight: '85%', anchor: 'center' })
    const loading = Promise.all(providers.map(async (provider): Promise<ProviderListing> => {
      try {
        return { provider, models: await llm.listModels(provider.id) }
      } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        return { provider, models: [], error: code === 'MISSING_CREDENTIAL' ? 'missing credentials' : 'catalog request failed' }
      } finally {
        if (!controller.signal.aborted) {
          completed += 1
          tui.requestRender()
        }
      }
    }))
    return await Promise.race([loading, canceled])
  } finally {
    signal.removeEventListener('abort', cancel)
    controller.abort()
    handle?.hide()
  }
}
