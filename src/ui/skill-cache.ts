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

/** One shared catalog read for a typing burst. */
interface InFlight {
  readonly generation: number
  readonly promise: Promise<readonly SkillSuggestion[]>
}

/** User-invocable skills for the `/` menu, read at most once per burst. */
export class SkillCatalogCache {
  private reading: { readonly agent: HostSession['agent']; readonly cwd: string; readonly at: number; readonly rows: readonly SkillSuggestion[] } | undefined
  /** Reads already running for one Agent/worktree pair. */
  private readonly inFlight = new Map<HostSession['agent'], Map<string, InFlight>>()
  /** Bumped by `clear()` so an older read cannot publish over a newer one. */
  private generation = 0

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
    this.generation += 1
    this.reading = undefined
    this.inFlight.clear()
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
      const running = this.inFlight.get(agent)?.get(cwd)
      if (running !== undefined && running.generation === this.generation) return running.promise
      const registry = this.registry()
      if (registry === undefined) {
        // An unavailable catalog is a result too: do not re-enter Host lookup on
        // every keystroke while the same Session is still on screen.
        if (this.isCurrentRead(agent, cwd, this.generation)) this.reading = { agent, cwd, at: now(), rows: [] }
        return []
      }
      const generation = this.generation
      const promise = this.read(agent, cwd, registry, generation, now)
      const perAgent = this.inFlight.get(agent) ?? new Map<string, InFlight>()
      this.inFlight.set(agent, perAgent)
      perAgent.set(cwd, { generation, promise })
      try {
        return await promise
      }
      finally {
        const current = this.inFlight.get(agent)
        if (current?.get(cwd)?.promise === promise) {
          current.delete(cwd)
          if (current.size === 0) this.inFlight.delete(agent)
        }
      }
    }
    catch {
      return []
    }
  }

  /**
   * Read one catalog and publish it only while it is still current.
   * @param agent - Agent the read belongs to.
   * @param cwd - worktree the read was scoped to.
   * @param registry - catalog that will be listed.
   * @param generation - invalidation generation the read started under.
   * @param now - clock injected by the caller.
   * @returns the rows, empty when the read failed or went stale.
   */
  private async read(
    agent: HostSession['agent'],
    cwd: string,
    registry: SkillsCatalog,
    generation: number,
    now: () => number,
  ): Promise<readonly SkillSuggestion[]> {
    try {
      const list = await registry.list({ cwd, scope: agent })
      if (!this.isCurrentRead(agent, cwd, generation)) return []
      const rows = skillRows(list).filter(skill => skill.userInvocable)
      this.reading = { agent, cwd, at: now(), rows }
      return rows
    }
    catch {
      // Cache the failure for the TTL as well: an unavailable catalog must not
      // make every keystroke query Host again.
      if (this.isCurrentRead(agent, cwd, generation)) this.reading = { agent, cwd, at: now(), rows: [] }
      return []
    }
  }

  /** Whether a read still belongs to the session and worktree on screen. */
  private isCurrentRead(agent: HostSession['agent'], cwd: string, generation: number): boolean {
    if (generation !== this.generation || !this.isCurrent(agent)) return false
    try {
      return this.workingDirectory(agent) === cwd
    }
    catch {
      return false
    }
  }
}
