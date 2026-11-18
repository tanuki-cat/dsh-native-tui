import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { availableExportPath } from '../src/runtime/export-path.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function dir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'native-tui-export-path-'))
  cleanup.push(path)
  return path
}

describe('availableExportPath', () => {
  it('keeps the requested name while it is free', async () => {
    const root = await dir()
    expect(await availableExportPath(join(root, 'session.jsonl'))).toBe(join(root, 'session.jsonl'))
  })

  it('walks past the names already taken', async () => {
    const root = await dir()
    await writeFile(join(root, 'session.jsonl'), '')
    await writeFile(join(root, 'session-1.jsonl'), '')
    expect(await availableExportPath(join(root, 'session.jsonl'))).toBe(join(root, 'session-2.jsonl'))
  })

  it('inserts the counter before a multi-part extension', async () => {
    const root = await dir()
    await writeFile(join(root, 'session.tar.gz'), '')
    expect(await availableExportPath(join(root, 'session.tar.gz'))).toBe(join(root, 'session.tar-1.gz'))
  })

  it('leaves a path without an extension distinguishable', async () => {
    const root = await dir()
    await writeFile(join(root, 'session'), '')
    expect(await availableExportPath(join(root, 'session'))).toBe(join(root, 'session-1'))
  })
})
