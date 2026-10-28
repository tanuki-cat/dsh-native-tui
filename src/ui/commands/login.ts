import { showChoice } from '../dialogs.js'
import type { CommandContext } from './context.js'

export async function loginCommand(ctx: CommandContext, args: string): Promise<void> {
  if (ctx.signal.aborted || ctx.isCurrent?.() === false) return
  if (args.trim() !== '') {
    ctx.notice('warning', '用法：/login，请在引导窗口选择登录平台。')
    return
  }
  const provider = await showChoice(ctx.tui, ctx.palette, '选择登录平台', [
    { value: 'codebuddy', label: 'CodeBuddy / WorkBuddy', description: '通过浏览器登录' },
    { value: 'codex', label: 'ChatGPT Codex', description: '通过浏览器或设备码登录' },
    { value: 'deepseek', label: 'DeepSeek 官方（待实现）', description: '暂不支持官方账号登录' },
  ], 'Enter 选择 · Esc 取消', ctx.signal)
  if (provider === undefined || ctx.signal.aborted || ctx.isCurrent?.() === false) return

  if (provider === 'deepseek') {
    ctx.notice('info', 'DeepSeek 官方登录待实现，请使用 /provider 配置 API Key。')
    return
  }
  await ctx.runCommand('/' + provider + ' login')
}
