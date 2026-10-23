import { describe, expect, it } from 'vitest'
import { compactErrorPreview, ptcCallLine } from '../src/ui/tool-preview.js'

describe('ptcCallLine', () => {
  it('names the file a file tool read', () => {
    expect(ptcCallLine('read', JSON.stringify({ file_path: 'src/ui/transcript.ts' }))).toBe('read src/ui/transcript.ts')
    expect(ptcCallLine('write', JSON.stringify({ file_path: 'a.ts', content: 'x' }))).toBe('write a.ts')
  })

  it('names the MCP server instead of the registered tool id', () => {
    expect(ptcCallLine('mcp__idea__get_file_problems', JSON.stringify({ file_path: 'a.ts' }))).toBe('mcp idea')
    expect(ptcCallLine('mcp__my_server__read_file', '{}')).toBe('mcp my_server')
  })

  it('prefers the pattern for search tools', () => {
    expect(ptcCallLine('grep', JSON.stringify({ pattern: 'ptc-dispatch', path: 'src' }))).toBe('grep ptc-dispatch')
    expect(ptcCallLine('glob', JSON.stringify({ pattern: '**/*.ts' }))).toBe('glob **/*.ts')
  })

  it('names the description or command of a shell call', () => {
    expect(ptcCallLine('bash', JSON.stringify({ description: 'List files', command: 'ls -la' }))).toBe('bash List files')
    expect(ptcCallLine('pwsh', JSON.stringify({ command: 'Get-ChildItem' }))).toBe('pwsh Get-ChildItem')
  })

  it('falls back to the tool name when no target applies', () => {
    expect(ptcCallLine('todo_write', '{"todos":[]}')).toBe('todo_write')
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
    const line = ptcCallLine('bash', JSON.stringify({ description, command: 'ls' }))
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
