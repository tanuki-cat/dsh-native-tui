/**
 * `/codex` terminal wiring: the Host seams plus the overlay helpers.
 *
 * @module dsh-native-tui/ui/commands/codex
 */

import type { AuthorizationLike, CredentialStoreLike } from '../../codex/types.js'
import { runCodexCommand } from '../../runtime/codex-command.js'
import { openUrlInBrowser } from '../../runtime/open.js'
import type { SettingsAccess } from '../../runtime/settings-write.js'
import { showChoice, showTextInput } from '../dialogs.js'
import { formatLocalTimestamp } from '../format-time.js'
import type { CommandContext } from './context.js'
import type { LLM } from './services.js'

/** The `/codex` command. */
export async function codexCommand(ctx: CommandContext, args: string): Promise<void> {
  await runCodexCommand(args, {
    authorization: ctx.host.get('authorization') as AuthorizationLike | undefined,
    credentials: ctx.host.get('credentials') as CredentialStoreLike | undefined,
    settings: ctx.host.get('settings') as unknown as SettingsAccess | undefined,
    llm: ctx.host.get('llm') as LLM | undefined,
    modelSelection: ctx.modelSelection,
    notice: (level, text) => ctx.notice(level, text),
    choose: (title, items, hint, signal) => showChoice(ctx.tui, ctx.palette, title, items, hint, signal),
    ask: (message, placeholder, secret, signal) => showTextInput(
      ctx.tui,
      ctx.palette,
      message,
      placeholder ?? '',
      secret
        ? 'Input is hidden from the transcript · Esc cancels'
        : 'Enter submits · Esc cancels · empty keeps waiting',
      signal,
      undefined,
      true,
    ),
    openUrl: url => openUrlInBrowser(url),
    signal: ctx.signal,
    formatTime: ms => formatLocalTimestamp(ms),
  })
}
