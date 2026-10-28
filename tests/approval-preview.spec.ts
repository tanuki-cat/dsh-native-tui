import { describe, expect, it } from 'vitest'
import { approvalArguments, approvalRequestDetails } from '../src/ui/approval-preview.js'
import { ptcCallLine } from '../src/ui/tool-preview.js'

const event = (type: string, name: string, id: string, args: unknown) => ({ type, data: { name, callId: id, subCallId: id, arguments: args } })

describe('approval arguments', () => {
  it('matches the exact pending native call instead of the latest call', () => {
    expect(approvalArguments([
      event('tool/call', 'bash', 'wanted', '{"command":"git status"}'),
      event('tool/call', 'bash', 'other', '{"command":"rm dangerous"}'),
    ], 'bash', 'wanted')).toBe('{"command":"git status"}')
  })
  it('reads a pending PTC dispatch before it has a result', () => {
    expect(approvalArguments([event('tool/ptc-dispatch-start', 'write', 'sub', { file_path: 'a.ts' })], 'write', 'sub')).toBe('{"file_path":"a.ts"}')
  })
  it('does not borrow arguments from another tool or an unbound request', () => {
    const events = [event('tool/call', 'bash', 'a', '{}')]
    expect(approvalArguments(events, 'write', 'a')).toBeUndefined()
    expect(approvalArguments(events, 'bash', undefined)).toBeUndefined()
    expect(approvalArguments(events, 'bash', 'missing')).toBeUndefined()
  })
  it('preserves long commands, multiline arguments and terminal escapes in full details', () => {
    const command = 'prefix\n' + 'a'.repeat(4000) + '\u001b[2J SECRET_SUFFIX'
    const details = approvalRequestDetails('bash', 'id', 'reason', JSON.stringify({ command }), '/work')
    expect(JSON.parse(details)).toEqual({ tool: 'bash', callId: 'id', sessionCwd: '/work', reason: 'reason', arguments: { command } })
    expect(details).not.toContain(String.fromCharCode(27))
    expect(details).toContain('SECRET_SUFFIX')
  })
})

describe('action summaries', () => {
  it('shows shell commands and workdirs rather than descriptions', () => {
    expect(ptcCallLine('bash', JSON.stringify({ description: 'Safe claim', command: 'git status\npwd', workdir: '/work' })))
      .toBe('bash git status ↵ pwd · cwd /work')
    expect(ptcCallLine('bash', JSON.stringify({ command: 'x'.repeat(400) })).endsWith('…')).toBe(true)
  })
  it('previews the actual outer program instead of its description', () => {
    expect(ptcCallLine('run_code', JSON.stringify({ description: 'Harmless label', code: 'await tools.read({})\nreturn 1' })))
      .toBe('run_code await tools.read({}) ↵ return 1')
  })

  it('shows MCP methods and camelCase paths, symbols, queries and commands', () => {
    expect(ptcCallLine('mcp__idea__get_file_problems', '{"filePath":"src/a.ts"}')).toBe('mcp idea.get_file_problems src/a.ts')
    expect(ptcCallLine('mcp__idea__analyze_calls', '{"symbolFqn":"a.B.run"}')).toBe('mcp idea.analyze_calls a.B.run')
    expect(ptcCallLine('mcp__idea__execute_terminal_command', '{"command":"pnpm test"}')).toBe('mcp idea.execute_terminal_command pnpm test')
  })
  it('shows todo counts and the active task without inventing a target file', () => {
    expect(ptcCallLine('todo_write', JSON.stringify({ todos: [
      { content: 'Read src/a.ts', status: 'completed' },
      { content: 'Edit src/b.ts', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' },
    ] }))).toBe('todo_write 3 tasks · 1 active · 1 done · Edit src/b.ts')
  })
})
