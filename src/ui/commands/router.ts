/**
 * The `/` command dispatcher.
 *
 * One submitted line becomes one handler call: a local family from this
 * directory, the codebuddy flow, or a Host command. Everything a handler cannot
 * reach through {@link CommandContext} — the session switch, a prompt, the
 * transcript reset, the preset record — arrives as an injected collaborator, so
 * the dispatcher stays independent of the closure that owns the terminal.
 *
 * @module dsh-native-tui/ui/commands/router
 */

import type {} from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createHostSession, resumeHostSession, type HostSession } from '../../runtime/agent.js'
import { runCodebuddyCommand, type CodeBuddyCommandDeps } from '../../runtime/codebuddy-command.js'
import type { CodeBuddyService } from '../../codebuddy.js'
import { INIT_AGENTS_PROMPT } from '../../runtime/init-prompt.js'
import { openUrlInBrowser } from '../../runtime/open.js'
import type { SkillSuggestion } from '../autocomplete.js'
import { showTextInput } from '../dialogs.js'
import { attachCommand, attachmentsCommand } from './attachments.js'
import { changesCommand, deliverablesCommand, filesCommand } from './artifacts.js'
import { HELP_LINES } from './catalog.js'
import type { CommandContext } from './context.js'
import { mcpCommand } from './mcp.js'
import { modelCommand, reasoningCommand } from './model.js'
import { pluginsCommand } from './plugins.js'
import { providerCommand } from './provider.js'
import { agentsCommand, jobsCommand, permissionsCommand } from './runtime-status.js'
import { helpCommand, statusCommand } from './session.js'
import { sessionsCommand } from './sessions.js'
import { settingsCommand } from './settings.js'
import { errorMessage } from './shared.js'
import { diffCommand, toolCommand, toolsCommand } from './tools.js'
import { exportCommand, openCommand, presetCommand, previewCommand } from './workspace-files.js'
import { scheduleCommand, workspacesCommand } from './workspace.js'

/** What the dispatcher needs that a command context does not carry. */
export interface CommandRouterDeps {
  /** The handler-facing application view, rebuilt for the session on screen now. */
  readonly context: () => CommandContext
  /** Replace the visible session, disposing the previous one. */
  readonly switchTo: (next: () => Promise<HostSession>) => Promise<void>
  /** Send a line as a prompt: `/init`, and the user-invocable-skill fallback. */
  readonly sendPrompt: (text: string) => void
  /** Drop the transcript and its local notices. */
  readonly clearTranscript: () => void
  /** Leave the process with this exit code. */
  readonly exit: (code: number) => void
  /** Replace the process with a fresh TUI that resumes the session on screen. */
  readonly reload: () => void
  /** The agent preset new sessions inherit, and where `/preset` records it. */
  readonly preset: {
    readonly current: () => string | undefined
    readonly select: (id: string) => void
  }
  /** User-invocable skills, for the unknown-command fallback. */
  readonly skills: () => Promise<readonly SkillSuggestion[]>
}

/**
 * Dispatch one submitted `/` line.
 * @param line - the line as typed, including its leading slash.
 * @param deps - the collaborators the handlers cannot reach on their own.
 */
export async function runCommandLine(line: string, deps: CommandRouterDeps): Promise<void> {
  const withoutSlash = line.slice(1)
  const space = withoutSlash.indexOf(' ')
  const name = (space === -1 ? withoutSlash : withoutSlash.slice(0, space)).toLowerCase()
  const args = space === -1 ? '' : withoutSlash.slice(space + 1).trim()
  // Built on first use and kept for this dispatch, so every handler sees the
  // session that is on screen and an `exit` line pays for nothing extra.
  let prepared: CommandContext | undefined
  const ctx = (): CommandContext => {
    prepared ??= deps.context()
    return prepared
  }

  switch (name) {
    case 'reload':
      if (args !== '') {
        ctx().notice('warning', 'Usage: /reload')
        return
      }
      if (ctx().active.agent.status === 'running') {
        ctx().notice('warning', 'Wait for the running turn to finish before /reload.')
        return
      }
      deps.reload()
      return
    case 'exit':
    case 'quit':
      deps.exit(0)
      return
    case 'help':
      await helpCommand(ctx(), HELP_LINES)
      return
    case 'clear':
      deps.clearTranscript()
      return
    case 'status':
      statusCommand(ctx())
      return
    case 'cancel':
      ctx().active.agent.cancel({ kind: 'user' })
      ctx().notice('info', 'Cancellation requested')
      return
    case 'new':
      await deps.switchTo(() => createHostSession(ctx().host, {
        ...ctx().config,
        sessionId: undefined,
        agentPreset: deps.preset.current() ?? ctx().config.agentPreset,
      }))
      return
    case 'init':
      deps.sendPrompt(INIT_AGENTS_PROMPT)
      return
    case 'sessions':
      await sessionsCommand(ctx())
      return
    case 'resume':
      if (args === '') await sessionsCommand(ctx())
      else await deps.switchTo(() => resumeHostSession(ctx().host, args as SessionId))
      return
    case 'model':
      await modelCommand(ctx(), args)
      return
    case 'reasoning':
      await reasoningCommand(ctx(), args)
      return
    case 'permissions':
      await permissionsCommand(ctx(), args)
      return
    case 'jobs':
      jobsCommand(ctx(), args)
      return
    case 'agents':
      await agentsCommand(ctx())
      return
    case 'workspaces':
      await workspacesCommand(ctx(), args, deps.switchTo, deps.preset.current)
      return
    case 'schedule':
      await scheduleCommand(ctx(), args)
      return
    case 'plugins':
      await pluginsCommand(ctx(), args)
      return
    case 'settings':
      await settingsCommand(ctx(), args)
      return
    case 'preset':
      await presetCommand(ctx(), args, deps.preset.current, deps.preset.select)
      return
    case 'export':
      await exportCommand(ctx(), args)
      return
    case 'open':
      await openCommand(ctx(), args)
      return
    case 'attach':
      await attachCommand(ctx(), args)
      return
    case 'files':
      await filesCommand(ctx(), args)
      return
    case 'changes':
      await changesCommand(ctx(), args)
      return
    case 'deliverables':
      await deliverablesCommand(ctx(), args)
      return
    case 'preview':
      await previewCommand(ctx(), args)
      return
    case 'tools':
      toolsCommand(ctx())
      return
    case 'tool':
      await toolCommand(ctx(), args)
      return
    case 'diff':
      await diffCommand(ctx(), args)
      return
    case 'attachments':
      await attachmentsCommand(ctx())
      return
    case 'mcp':
      await mcpCommand(ctx(), args)
      return
    case 'codebuddy':
      await runCodebuddyCommand(args, {
        service: ctx().host.get('codebuddy') as CodeBuddyService | undefined,
        authorization: ctx().host.get('authorization') as CodeBuddyCommandDeps['authorization'],
        credentials: ctx().host.get('credentials') as CodeBuddyCommandDeps['credentials'],
        openUrl: url => openUrlInBrowser(url),
        signal: ctx().signal,
        notice: (level, text) => ctx().notice(level, text),
        prompt: question => showTextInput(
          ctx().tui,
          ctx().palette,
          question.message,
          question.placeholder ?? '',
          question.secret === true ? 'Input is hidden from the transcript · Esc cancels' : 'Enter submits · Esc cancels',
          ctx().signal,
        ),
      })
      return
    case 'provider':
      await providerCommand(ctx(), args)
      return
    default: {
      try {
        const execution = await ctx().host.commands.execute(ctx().active.agent, line, [], new AbortController().signal)
        if (execution !== undefined) {
          // Host commands append command/done before execute() resolves, and the
          // transcript renders that event. Do not also surface result.text here.
          return
        }
      }
      catch (error) {
        ctx().notice('error', 'Command failed: ' + errorMessage(error))
        return
      }
      // A user-invocable skill goes through as a prompt: dsh-tool-skill reads the
      // /name gesture from claimed user messages and injects the skill body.
      const skills = await deps.skills()
      if (skills.some(skill => skill.name.toLowerCase() === name)) {
        deps.sendPrompt(line)
        return
      }
      ctx().notice('warning', 'Unknown command: /' + name + '. Use /help for local and host commands.')
    }
  }
}
