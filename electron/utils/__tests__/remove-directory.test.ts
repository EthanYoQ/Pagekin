import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeDirectoryWithWindowsRetry } from '../remove-directory'

const BetterSqlite = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

describe('removeDirectoryWithWindowsRetry', () => {
  let root = ''
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    root = ''
  })

  async function bookFolder() {
    root = await mkdtemp(path.join(os.tmpdir(), 'remove-directory-'))
    await mkdir(path.join(root, '.ai-novel', 'lancedb', 'chunks.lance'), { recursive: true })
    await writeFile(path.join(root, '.ai-novel', 'lancedb', 'chunks.lance', 'data.lance'), 'x')
    await writeFile(path.join(root, '正文.md'), '第一章')
    return root
  }

  it('删掉整个作品文件夹', async () => {
    const folder = await bookFolder()

    await removeDirectoryWithWindowsRetry(folder)

    expect(existsSync(folder)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('库文件只是关库前后短暂占着：稍等后照样删掉', async () => {
    const folder = await bookFolder()
    const database = new BetterSqlite(path.join(folder, '.ai-novel', 'project.db'))
    database.exec('create table chapters (body text)')
    const released = new Promise<void>(resolve => setTimeout(() => { database.close(); resolve() }, 300))

    try {
      await removeDirectoryWithWindowsRetry(folder)
    } finally {
      await released
    }

    expect(existsSync(folder)).toBe(false)
  })
})
