import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandContext } from './context.js'
import { showChoice } from '../dialogs.js'

function terminalFence(error: unknown): boolean {
  return error instanceof Error && /^cannot change sandbox mode from "[^"]+" to "[^"]+" while persistent terminal sessions are open or being created;/.test(error.message)
}

function assertIdle(agent: Agent): void {
  if (agent.status === 'running') throw new Error('Wait for the running turn to finish or cancel it before changing permissions.')
}

/**
 * Retry a terminal-fenced change once after explicit consent to reset the Agent.
 * Returns false on cancellation, true after applying the change; other failures reject.
 * Resetting preserves the Session but discards Agent-owned shell state.
 */
export async function changePermissions(ctx: CommandContext, change: (agent: Agent) => void | Promise<void>): Promise<boolean> {
  if (ctx.signal.aborted) return false
  assertIdle(ctx.active.agent)
  try {
    await change(ctx.active.agent)
    return true
  }
  catch (error) {
    if (!terminalFence(error) || ctx.restartSession === undefined) throw error
    const consent = await showChoice(ctx.tui, ctx.palette,
      'Reset persistent shells to change permissions?\nThis closes this Agent and its background work, then restores the same Session. Shell cwd and environment are lost; conversation history is preserved.', [
        { value: 'cancel', label: 'Keep current permissions' },
        { value: 'restart', label: 'Reset shells and apply permissions' },
      ], 'Choose explicitly · Esc cancels', ctx.signal)
    if (consent !== 'restart' || ctx.signal.aborted) return false
    assertIdle(ctx.active.agent)
    const reopened = await ctx.restartSession(ctx.active)
    if (ctx.signal.aborted) return false
    if (reopened.id !== ctx.active.id) throw new Error('The restarted Agent belongs to a different Session.')
    if (reopened.agent.status === 'running') throw new Error('The restored Agent is running; choose permissions again when idle.')
    await change(reopened.agent)
    return true
  }
}
