/**
 * The `/` menu's skill list, cached across one typing burst.
 *
 * The editor asks for candidates on every keystroke while a `/` word is being
 * typed, and each request would otherwise list the catalog and re-map every
 * skill. One reading serves that burst; a session switch invalidates it by
 * identity so a menu never lists another Session's catalog.
 *
 * @module dsh-native-tui/ui/skill-cache
 */
import type { HostSession } from '../runtime/agent.js'
import { skillRows } from '../runtime/skill-catalog.js'
import type { SkillSuggestion } from './autocomplete.js'
import type { SkillsCatalog } from './commands/services.js'

/** How long one reading serves the menu before the next request re-lists it. */
export const SKILLS_CACHE_MS = 1000

/** User-invocable skills for the `/` menu, read at most once per burst. */
export class SkillCatalogCache {
  private reading: { readonly agent: HostSession['agent']; readonly cwd: string; readonly at: number; readonly rows: readonly SkillSuggestion[] } | undefined

  /**
   * @param registry - the active catalog, or undefined when the Host exposes none.
   * @param workingDirectory - the Agent's current workspace.
   * @param isCurrent - whether the Agent is still the one on screen.
   */
  constructor(
    private readonly registry: () => SkillsCatalog | undefined,
    private readonly workingDirectory: (agent: HostSession['agent']) => string,
    private readonly isCurrent: (agent: HostSession['agent']) => boolean,
  ) {}

  /** Drop the reading after a session switch. */
  clear(): void {
    this.reading = undefined
  }

  /**
   * List the user-invocable skills of one Agent's Session.
   * @param agent - Agent whose Session menu is being built.
   * @param now - clock the reading is aged with, injectable for tests.
   * @returns rows for the menu, or none when the catalog cannot be read.
   */
  async load(agent: HostSession['agent'], now = Date.now): Promise<readonly SkillSuggestion[]> {
    try {
      const cwd = this.workingDirectory(agent)
      const cached = this.reading
      if (cached !== undefined && cached.agent === agent && cached.cwd === cwd && now() - cached.at < SKILLS_CACHE_MS) return cached.rows
      const registry = this.registry()
      if (registry === undefined) return []
      const list = await registry.list({ cwd, scope: agent })
      const rows = skillRows(list).filter(skill => skill.userInvocable)
      if (!this.isCurrent(agent) || this.workingDirectory(agent) !== cwd) return []
      this.reading = { agent, cwd, at: now(), rows }
      return rows
    }
    catch {
      return []
    }
  }
}
