import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
  },
}))

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { reopenWithContent } from '../../../test/helpers/reopened-draft'
import { projectAccess } from '../../services/project-access'
import { registerDatabaseController } from '../db-controller'

let parentDirectory = ''
let session = { projectId: '', leaseId: '', projectPath: '' }

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-db-read-only-'))
  const lease = projectAccess.beginSession(projectAccess.createProject(parentDirectory, 'novel'))
  session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
  initProjectDatabase(lease.rootPath)
})

afterEach(() => {
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  fs.rmSync(parentDirectory, { recursive: true, force: true })
})

function finalizedDraft(content: string): number {
  const draftId = DraftRepository.getFinalizedByChapter(1)
    ? reopenWithContent(1, content)
    : DraftRepository.create({ chapterNumber: 1, source: 'write', content, wordCount: content.length })
  FinalizationRepository.commit({
    finalizationId: randomUUID(),
    draftId,
    chapterNumber: 1,
    chapterTitle: '雾钟',
    content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    contentRevision: 1,
    targetFileName: `第1章 雾钟 ${draftId}.txt`,
  })
  return draftId
}

function updateContent(draftId: number, content: string) {
  return handlers.get('db:draft-update-content')!({}, draftId, content, content.length, session.projectPath, session)
}

describe('db:draft-update-content 对带定稿收据的稿', () => {
  it('定稿与被替换的旧定稿都返回只读拒绝，正文不变', async () => {
    const replaced = finalizedDraft('第一章旧定稿。')
    const current = finalizedDraft('第一章新定稿。')

    for (const draftId of [current, replaced]) {
      await expect(updateContent(draftId, '覆盖')).resolves.toEqual({
        success: false,
        error: 'Error: DRAFT_FINALIZED_READ_ONLY',
      })
    }
    expect([DraftRepository.getFull(replaced)?.content, DraftRepository.getFull(current)?.content])
      .toEqual(['第一章旧定稿。', '第一章新定稿。'])
  })

  it('工作稿照常保存', async () => {
    const draftId = DraftRepository.create({ chapterNumber: 2, source: 'write', content: '初稿', wordCount: 2 })

    await expect(updateContent(draftId, '改稿')).resolves.toEqual({ success: true })
    expect(DraftRepository.getFull(draftId)?.content).toBe('改稿')
  })
})

describe('数据库控制器注册的通道', () => {
  it('不再提供无人调用的全局角色状态快照读写通道', () => {
    expect(handlers.has('db:draft-update-content')).toBe(true)
    expect(handlers.has('db:save-summary-snapshot')).toBe(false)
    expect(handlers.has('db:get-latest-summary')).toBe(false)
  })
})

describe('批注修改提交', () => {
  it('在同一事务里保存原文、新文和批注，再更新草稿', async () => {
    const id = DraftRepository.create({ chapterNumber: 2, source: 'write', content: '春雨落下', wordCount: 4 })
    const input = { draftId: id, expectedSaved: '春雨落下', before: '春雨落下', after: '秋雨落下', annotations: [{ id: 'one', from: 0, to: 1, selectedText: '春', instruction: '改成秋' }] }
    await expect(handlers.get('db:annotation-commit')!({}, input, session.projectPath, session)).resolves.toEqual({ success: true })
    expect(DraftRepository.getFull(id)?.content).toBe('秋雨落下')
    const { getProjectDb } = await import('../../database')
    const saved = getProjectDb()!.prepare('SELECT before_text, after_text, annotations_json FROM annotation_history WHERE draft_id=?').get(id) as { before_text: string; after_text: string; annotations_json: string }
    expect(saved.before_text).toBe(input.before)
    expect(saved.after_text).toBe(input.after)
    expect(JSON.parse(saved.annotations_json)).toEqual(input.annotations)
  })
  it('保留尚未保存的作者编辑作为修改前快照', async () => {
    const id = DraftRepository.create({ chapterNumber: 3, source: 'write', content: '旧稿', wordCount: 2 })
    const input = { draftId: id, expectedSaved: '旧稿', before: '春雨落下', after: '秋雨落下', annotations: [{ id: 'one', from: 0, to: 1, selectedText: '春', instruction: '改成秋' }] }
    await expect(handlers.get('db:annotation-commit')!({}, input, session.projectPath, session)).resolves.toEqual({ success: true })
    const { getProjectDb } = await import('../../database')
    expect(getProjectDb()!.prepare('SELECT before_text FROM annotation_history WHERE draft_id=?').pluck().get(id)).toBe('春雨落下')
    expect(DraftRepository.getFull(id)?.content).toBe('秋雨落下')
  })
  it('正文发生变化时不覆盖，也不写历史', async () => {
    const id = DraftRepository.create({ chapterNumber: 2, source: 'write', content: '夏雨落下', wordCount: 4 })
    const input = { draftId: id, expectedSaved: '春雨落下', before: '春雨落下', after: '秋雨落下', annotations: [{ id: 'one', from: 0, to: 1, selectedText: '春', instruction: '改成秋' }] }
    await expect(handlers.get('db:annotation-commit')!({}, input, session.projectPath, session)).resolves.toEqual({ success: false, error: 'Error: SOURCE_DRAFT_CHANGED' })
    expect(DraftRepository.getFull(id)?.content).toBe('夏雨落下')
    const { getProjectDb } = await import('../../database')
    expect(getProjectDb()!.prepare('SELECT count(*) FROM annotation_history WHERE draft_id=?').pluck().get(id)).toBe(0)
  })
})
