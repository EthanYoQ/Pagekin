import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler)
    }),
  },
}))

import { registerExternalFileGrantController } from '../../../electron/controllers/external-file-grant-controller'
import { closeProjectDatabase, getProjectDb } from '../../../electron/database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { FinalizationRepository } from '../../../electron/repositories/finalization-repository'
import { ExternalFileGrantService } from '../../../electron/services/external-file-grant-service'
import { nodeTestSecureFileSystem } from '../../../test/helpers/node-test-secure-file-system'
import { createWindowsSafeFileSystem } from '../../../electron/security/windows-safe-file-system'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { exportNovel } from '../export-service'

const temporaryRoots: string[] = []

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

afterEach(() => {
  closeProjectDatabase()
  setActiveProjectSessionContext(null)
  vi.unstubAllGlobals()
  electronMocks.handlers.clear()
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('authoritative finalized export integration', () => {
  it('reads sparse finalized facts from SQLite and writes exact files through the production grant controller', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-export-integration-'))
    temporaryRoots.push(root)
    const projectPath = path.join(root, 'project')
    const exportPath = path.join(root, 'export')
    fs.mkdirSync(projectPath)
    fs.mkdirSync(exportPath)
    initProjectDatabase(projectPath, Buffer.alloc(32, 7))

    const db = getProjectDb()
    if (!db) throw new Error('Expected project database')
    const insertContent = db.prepare('INSERT INTO contents (body) VALUES (?)')
    const insertDraft = db.prepare(`
      INSERT INTO drafts_all (chapter_number, version, status, content_id, word_count)
      VALUES (?, ?, 'draft', ?, 0)
    `)
    const facts = [
      { chapterNumber: 1, title: '起航', content: '第一章：The sign reads “夜航 Café”.' },
      { chapterNumber: 4, title: '归来', content: '第四章：归航。' },
    ]
    for (const fact of facts) {
      const contentId = Number(insertContent.run('old draft').lastInsertRowid)
      const draftId = Number(insertDraft.run(fact.chapterNumber, 1, contentId).lastInsertRowid)
      FinalizationRepository.commit({
        finalizationId: `finalization-${fact.chapterNumber}`,
        draftId,
        chapterNumber: fact.chapterNumber,
        chapterTitle: fact.title,
        content: fact.content,
        contentHash: sha256(fact.content),
        contentRevision: 1,
        targetFileName: `第${fact.chapterNumber}章 ${fact.title}.txt`,
      })
    }

    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'integration-export-grant',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: exportPath,
      operations: ['write', 'create'],
      ttlMs: 60_000,
      maxUses: 10,
    })
    registerExternalFileGrantController(grants, nodeTestSecureFileSystem)

    const projectSession: ProjectSessionContext = {
      projectId: 'project-integration',
      leaseId: 'lease-integration',
      projectPath,
    }
    setActiveProjectSessionContext(projectSession)
    const event = { sender: { id: 17, once: vi.fn() } }
    vi.stubGlobal('window', {
      aiNovelAPI: {
        invoke: async (channel: string, ...args: unknown[]) => {
          if (channel === 'db:draft-export-snapshot') {
            expect(args).toEqual([projectPath, projectSession])
            return FinalizationRepository.listAuthoritativeForExport()
          }
          if (channel === 'db:draft-export-authority-current') {
            expect(args.slice(1)).toEqual([projectPath, projectSession])
            return FinalizationRepository.matchesAuthoritativeExportReceipt(args[0] as never)
          }
          const ipcHandler = electronMocks.handlers.get(channel)
          if (!ipcHandler) throw new Error(`Missing IPC handler: ${channel}`)
          return ipcHandler(event, ...args)
        },
      },
    })

    const first = await exportNovel(
      { format: 'split-md', grantId: grant.grantId },
      {
        id: projectSession.projectId,
        sessionLease: projectSession.leaseId,
        path: projectPath,
        name: 'Sparse Novel',
        novelConfig: {
          genre: 'fantasy',
          targetAudience: 'general',
          writingLanguage: 'zh-CN',
        },
      },
      projectSession,
    )
    expect(first).toMatchObject({ success: true })
    if (!first.path) throw new Error('Expected first export path')

    expect(fs.readFileSync(path.join(exportPath, first.path, 'chapter_1.md'), 'utf8'))
      .toBe(`# 第1章 ${facts[0].title}\n\n${facts[0].content}`)
    expect(fs.readFileSync(path.join(exportPath, first.path, 'chapter_4.md'), 'utf8'))
      .toBe(`# 第4章 ${facts[1].title}\n\n${facts[1].content}`)
    expect(fs.readdirSync(path.join(exportPath, first.path)).sort())
      .toEqual(['chapter_1.md', 'chapter_4.md'])

    db.prepare("UPDATE drafts_all SET status = 'archived' WHERE chapter_number = 4").run()
    const second = await exportNovel(
      { format: 'split-md', grantId: grant.grantId },
      {
        id: projectSession.projectId,
        sessionLease: projectSession.leaseId,
        path: projectPath,
        name: 'Sparse Novel',
        novelConfig: { genre: 'fantasy', targetAudience: 'general', writingLanguage: 'zh-CN' },
      },
      projectSession,
    )
    expect(second).toMatchObject({ success: true })
    expect(second.path).not.toBe(first.path)
    if (!second.path) throw new Error('Expected second export path')
    expect(fs.readdirSync(path.join(exportPath, second.path)))
      .toEqual(['chapter_1.md'])
  })

  it.runIf(process.platform === 'win32')('目标文件被其他程序打开时，说明原因并保持原文件不变', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-export-held-'))
    temporaryRoots.push(root)
    const projectPath = path.join(root, 'project')
    const exportPath = path.join(root, 'export')
    fs.mkdirSync(projectPath)
    fs.mkdirSync(exportPath)
    initProjectDatabase(projectPath, Buffer.alloc(32, 7))
    const db = getProjectDb()
    if (!db) throw new Error('Expected project database')
    const contentId = Number(db.prepare('INSERT INTO contents (body) VALUES (?)').run('old draft').lastInsertRowid)
    const draftId = Number(db.prepare(`
      INSERT INTO drafts_all (chapter_number, version, status, content_id, word_count)
      VALUES (1, 1, 'draft', ?, 0)
    `).run(contentId).lastInsertRowid)
    FinalizationRepository.commit({
      finalizationId: 'finalization-held',
      draftId,
      chapterNumber: 1,
      chapterTitle: '起航',
      content: '第一章正文。',
      contentHash: sha256('第一章正文。'),
      contentRevision: 1,
      targetFileName: '第1章 起航.txt',
    })
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'held-export-grant' })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: exportPath,
      operations: ['write', 'create'],
      ttlMs: 60_000,
      maxUses: 10,
    })
    registerExternalFileGrantController(grants, createWindowsSafeFileSystem())
    const projectSession: ProjectSessionContext = { projectId: 'project-held', leaseId: 'lease-held', projectPath }
    setActiveProjectSessionContext(projectSession)
    const event = { sender: { id: 17, once: vi.fn() } }
    vi.stubGlobal('window', {
      aiNovelAPI: {
        invoke: async (channel: string, ...args: unknown[]) => {
          if (channel === 'db:draft-export-snapshot') return FinalizationRepository.listAuthoritativeForExport()
          if (channel === 'db:draft-export-authority-current') {
            return FinalizationRepository.matchesAuthoritativeExportReceipt(args[0] as never)
          }
          const ipcHandler = electronMocks.handlers.get(channel)
          if (!ipcHandler) throw new Error(`Missing IPC handler: ${channel}`)
          return ipcHandler(event, ...args)
        },
      },
    })
    const targetPath = path.join(exportPath, 'Held Novel.md')
    fs.writeFileSync(targetPath, 'earlier export', 'utf8')

    const holder = fs.openSync(targetPath, 'r+')
    let result: Awaited<ReturnType<typeof exportNovel>>
    try {
      result = await exportNovel(
        { format: 'merged-md', grantId: grant.grantId },
        {
          id: projectSession.projectId,
          sessionLease: projectSession.leaseId,
          path: projectPath,
          name: 'Held Novel',
          novelConfig: { genre: 'fantasy', targetAudience: 'general', writingLanguage: 'zh-CN' },
        },
        projectSession,
      )
    } finally {
      fs.closeSync(holder)
    }

    expect(result).toEqual({
      success: false,
      error: '文件没有改动。目标文件正被其他程序打开，关掉它后再点「选择目录并导出」。',
    })
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('earlier export')
    expect(fs.readdirSync(exportPath)).toEqual(['Held Novel.md'])
  })
})

const globalEnvironmentKeys = ['AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME'] as const
let globalFixtureRoot = ''
const previousGlobalEnvironment = new Map<string, string | undefined>()
beforeAll(async () => {
  for (const key of globalEnvironmentKeys) previousGlobalEnvironment.set(key, process.env[key])
  const cache = path.resolve('.runtime/.cache')
  fs.mkdirSync(cache, { recursive: true })
  globalFixtureRoot = fs.mkdtempSync(path.join(cache, 'export-service-integration-global-'))
  process.env.AI_NOVEL_LEGACY_SOURCE_HOME = path.join(globalFixtureRoot, 'legacy')
  await (await import('../../../electron/services/__tests__/global-data-fixture')).prepareGlobalDataFixture(globalFixtureRoot)
})
afterAll(() => {
  for (const key of globalEnvironmentKeys) {
    const previous = previousGlobalEnvironment.get(key)
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  vi.resetModules()
  if (globalFixtureRoot) fs.rmSync(globalFixtureRoot, { recursive: true, force: true })
})
