import { describe, expect, it } from 'vitest'
import { compactErrorPreview, ptcCallLine } from '../src/ui/tool-preview.js'

describe('ptcCallLine', () => {
  it('names the loaded skill and keeps distinct skills distinguishable', () => {
    expect(ptcCallLine('skill', JSON.stringify({ name: 'daily-log-writer' }))).toBe('skill daily-log-writer')
    expect(ptcCallLine('skill', JSON.stringify({ name: 'dsh-doc' }))).toBe('skill dsh-doc')
  })

  it('does not invent skill names for missing, blank or malformed arguments', () => {
    for (const args of ['{}', '{\"name\":\" \"}', '{\"name\":123}', 'not JSON']) expect(ptcCallLine('skill', args)).toBe('skill')
    const label = ptcCallLine('skill', JSON.stringify({ name: 'a'.repeat(200) }))
    expect(label.length).toBeLessThanOrEqual('skill '.length + 64)
    expect(label.endsWith('…')).toBe(true)
  })

  it.each([
    [{ job_id: 'bash-build' }, 'job_output bash-build · poll'],
    [{ job_id: 'bash-test', wait: false, timeout_ms: 90000 }, 'job_output bash-test · poll'],
    [{ job_id: 'bash-build', wait: true }, 'job_output bash-build · wait'],
    [{ job_id: 'bash-build', wait: true, timeout_ms: 90000 }, 'job_output bash-build · wait · timeout 90s'],
    [{ job_id: 'bash-build', wait: true, timeout_ms: 1500 }, 'job_output bash-build · wait · timeout 1500ms'],
  ])('summarizes job_output %j', (args, expected) => {
    expect(ptcCallLine('job_output', JSON.stringify(args))).toBe(expected)
  })

  it('does not invent a job identity or timeout for invalid arguments', () => {
    for (const args of ['{}', '{"job_id":" "}', '{"job_id":123}', 'not JSON']) {
      expect(ptcCallLine('job_output', args)).toBe('job_output')
    }
    for (const timeout_ms of [-1, '90000', null]) {
      expect(ptcCallLine('job_output', JSON.stringify({ job_id: 'bash-build', wait: true, timeout_ms })))
        .toBe('job_output bash-build · wait')
    }
    const line = ptcCallLine('job_output', JSON.stringify({ job_id: 'prefix'.repeat(100) + '-distinct-job', wait: true }))
    expect(line).toContain('…')
    expect(line.endsWith('-distinct-job · wait')).toBe(true)
    expect(line.length).toBeLessThanOrEqual('job_output '.length + 64 + ' · wait'.length)
  })

  it('names the file a file tool read', () => {
    expect(ptcCallLine('read', JSON.stringify({ file_path: 'src/ui/transcript.ts' }))).toBe('read src/ui/transcript.ts')
    expect(ptcCallLine('write', JSON.stringify({ file_path: 'a.ts', content: 'x' }))).toBe('write a.ts')
  })

  it('names the MCP server instead of the registered tool id', () => {
    expect(ptcCallLine('mcp__idea__get_file_problems', JSON.stringify({ file_path: 'a.ts' }))).toBe('mcp idea.get_file_problems a.ts')
    expect(ptcCallLine('mcp__my_server__read_file', '{}')).toBe('mcp my_server.read_file')
  })

  it('prefers the pattern for search tools', () => {
    expect(ptcCallLine('grep', JSON.stringify({ pattern: 'ptc-dispatch', path: 'src' }))).toBe('grep ptc-dispatch')
    expect(ptcCallLine('glob', JSON.stringify({ pattern: '**/*.ts' }))).toBe('glob **/*.ts')
  })

  it('names the description or command of a shell call', () => {
    expect(ptcCallLine('bash', JSON.stringify({ description: 'List files', command: 'ls -la' }))).toBe('bash ls -la')
    expect(ptcCallLine('pwsh', JSON.stringify({ command: 'Get-ChildItem' }))).toBe('pwsh Get-ChildItem')
  })

  it('falls back to the tool name when no target applies', () => {
    expect(ptcCallLine('todo_write', '{"todos":[]}')).toBe('todo_write 0 tasks · clear list')
    expect(ptcCallLine('read', 'not json')).toBe('read')
  })

  it('collapses whitespace and bounds one row', () => {
    expect(ptcCallLine('read', JSON.stringify({ file_path: 'src/a\n  b.ts' }))).toBe('read src/a b.ts')
    const long = ptcCallLine('read', JSON.stringify({ file_path: 'a'.repeat(200) }))
    expect(long).toHaveLength('read '.length + 64)
    expect(long.startsWith('read …')).toBe(true)
  })

  it('keeps the file name when a path is too long', () => {
    // Two paths in the same deep directory share a prefix, so truncating from
    // the left would render them identically and deduplicate one away.
    const directory = 'src/features/extremely/deeply/nested/directory/structure/with/many/segments/'
    const alpha = ptcCallLine('read', JSON.stringify({ file_path: directory + 'alpha-handler.ts' }))
    const beta = ptcCallLine('read', JSON.stringify({ file_path: directory + 'beta-handler.ts' }))
    expect(alpha).not.toBe(beta)
    expect(alpha.endsWith('alpha-handler.ts')).toBe(true)
    expect(beta.endsWith('beta-handler.ts')).toBe(true)
  })

  it('keeps the head of prose-like values', () => {
    const description = 'List every TypeScript file under the nested directory structure for review'
    const line = ptcCallLine('bash', JSON.stringify({ description }))
    expect(line.startsWith('bash List every TypeScript')).toBe(true)
    expect(line.endsWith('…')).toBe(true)
  })

  it('reads the first web search query', () => {
    expect(ptcCallLine('web_search', JSON.stringify({ queries: ['ptc compact card', 'second'] }))).toBe('web_search ptc compact card')
  })
})

describe('compactErrorPreview', () => {
  it('keeps the first non-empty line of a failed result', () => {
    expect(compactErrorPreview('\n  Error: ENOENT: no such file\n  at readFile')).toBe('Error: ENOENT: no such file')
    expect(compactErrorPreview('   ')).toBe('')
    expect(compactErrorPreview(undefined)).toBe('')
  })

  it('bounds a long message', () => {
    const long = compactErrorPreview('x'.repeat(500))
    expect(long).toHaveLength(220)
    expect(long.endsWith('…')).toBe(true)
  })
})
