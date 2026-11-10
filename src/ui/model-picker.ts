import type { LlmModelBadge } from '@deepseek-ai/dsh-llm'
import type { CommandContext } from './commands/context.js'
import type { LLM } from './commands/services.js'
import { showSearchChoice, type ChoiceItem } from './dialogs.js'
import { loadModelCatalog, type ProviderListing } from './model-catalog.js'

const HINT = 'Type to filter · ↑/↓ moves · Enter selects · Esc cancels'

function modelBadge(ctx: CommandContext, badge: LlmModelBadge | undefined): ChoiceItem['badge'] {
  if (badge === undefined) return undefined
  const locale = ctx.host.get('locale') as { resolveText(text: LlmModelBadge['text']): string } | undefined
  const text = locale?.resolveText(badge.text) ?? (typeof badge.text === 'string' ? badge.text : badge.text.en)
  return { text, tone: badge.tone }
}

function choices(ctx: CommandContext, listings: readonly ProviderListing[]): ChoiceItem[] {
  const selected = ctx.modelSelection.current
  return listings.flatMap(({ provider, models }) => models.map(model => ({
    value: provider.id + '/' + model.id,
    label: (selected?.provider === provider.id && selected.model === model.id ? '* ' : '  ') + provider.id + '/' + model.id,
    badge: modelBadge(ctx, model.badge),
    description: model.name + (model.description === undefined ? '' : ' — ' + model.description),
  })))
}

/** Read Host-owned catalogues while the picker is open; never persist discovery. */
export async function showModelPicker(ctx: CommandContext, llm: LLM): Promise<string | undefined> {
  if (ctx.signal.aborted) return undefined
  const off: Array<() => void> = []
  let closed = false, dirtyTopology = false
  const dirtyProviders = new Set<string>()
  const requests = new Map<string, object>()
  let reloadProvider = (id: string): void => { dirtyProviders.add(id) }
  let reloadTopology = (): void => { dirtyTopology = true }
  try {
    off.push(ctx.host.on('llm/models-updated', provider => { reloadProvider(provider) }))
    off.push(ctx.host.on('llm/adapters-updated', () => { reloadTopology() }))
    let listings: readonly ProviderListing[] | undefined
    try {
      listings = await loadModelCatalog(llm, ctx.tui, ctx.palette, ctx.signal)
    } catch {
      ctx.notice('error', 'Could not load model catalogs. Check provider configuration and retry /model.')
      return undefined
    }
    if (listings === undefined || ctx.signal.aborted) return undefined
    const failures = listings.filter(row => row.error !== undefined)
    if (failures.length > 0) ctx.notice('warning', 'Model catalogs unavailable: ' + failures.map(row => row.provider.id + ' (' + row.error + ')').join(', '))
    const items = choices(ctx, listings)
    if (items.length === 0 && !dirtyTopology && dirtyProviders.size === 0) {
      ctx.notice('warning', failures.length === 0 ? 'The LLM catalog advertises no models.' : 'No models loaded. Some catalogs failed; check credentials or connectivity.')
      return undefined
    }
    let order = listings.map(row => row.provider.id)
    let rows = new Map(listings.map(row => [row.provider.id, row]))
    const current = (): ProviderListing[] => order.flatMap(id => { const row = rows.get(id); return row === undefined ? [] : [row] })
    const title = (items: readonly ChoiceItem[]): string => 'Select model · ' + items.length + ' available'
    return await showSearchChoice(ctx.tui, ctx.palette, title(items), items, HINT, ctx.signal, update => {
      const alive = (): boolean => !closed && !ctx.signal.aborted
      const publish = (error?: string): void => {
        if (!alive()) return
        const listed = current(), items = choices(ctx, listed)
        const failed = listed.filter(row => row.error !== undefined).map(row => row.provider.id)
        const status = [
          ...(error === undefined ? [] : [error]),
          ...(failed.length === 0 ? [] : ['Refresh failed: ' + failed.join(', ') + ' · keeping last loaded models']),
          ...(requests.size === 0 ? [] : ['Refreshing model catalogs…']),
          HINT,
        ].join(' · ')
        update(title(items), items, status)
      }
      reloadProvider = id => {
        if (!alive() || !rows.has(id)) return
        const token = {}
        requests.set(id, token)
        publish()
        const valid = (): boolean => alive() && requests.get(id) === token && rows.has(id)
        void Promise.resolve().then(async () => {
          if (!valid()) return
          const models = await llm.listModels(id)
          if (!valid()) return
          rows.set(id, { provider: rows.get(id)!.provider, models })
          requests.delete(id)
          publish()
        }).catch(() => {
          if (!valid()) return
          rows.set(id, { ...rows.get(id)!, error: 'catalog request failed' })
          requests.delete(id)
          publish()
        })
      }
      reloadTopology = () => {
        if (!alive()) return
        let providers
        try { providers = llm.listProviders() }
        catch { publish('Could not refresh catalogs · keeping last loaded models'); return }
        requests.clear()
        order = providers.map(provider => provider.id)
        rows = new Map(providers.map(provider => [provider.id, { ...rows.get(provider.id), provider, models: rows.get(provider.id)?.models ?? [] }]))
        publish()
        for (const provider of providers) reloadProvider(provider.id)
      }
      if (dirtyTopology) reloadTopology()
      else for (const id of dirtyProviders) reloadProvider(id)
      dirtyProviders.clear()
      return () => { closed = true; requests.clear() }
    })
  } finally {
    closed = true
    requests.clear()
    for (const dispose of off) dispose()
  }
}
