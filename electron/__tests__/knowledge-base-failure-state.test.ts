import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { shown } from '../../src/i18n/__tests__/shown-locale'
import { displayedErrorMessage } from '../../src/i18n/app-errors'
import { closeProjectDatabase, getProjectDb } from '../database'
import { importReferenceText, importText } from '../knowledge-base'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { addChunks, closeConnection, getConnection, getDocumentIntegrity, getEmbeddingSpaces, listDocuments, search } from '../vector-store'

let projectPath = ''
const ftsModel = { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }
const space = { modelFingerprint: 'test/failure-state', distanceMetric: 'l2' }
const vector = Array.from({ length: 768 }, (_, index) => index / 768)

function sqliteFull(): Error {
  return Object.assign(new Error('database or disk is full'), { name: 'SqliteError', code: 'SQLITE_FULL' })
}

function enospc(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' })
}

function referenceImport(content: string) {
  const prepared = ImportRunRepository.prepare({
    runId: 'failure-state-run',
    purpose: 'reference',
    sourceFingerprint: createHash('sha256').update('source').digest('hex'),
    locale: 'zh-CN',
    sourceDisplay: [{ displayName: '第1章.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: '旧港', content, contentSize: Buffer.byteLength(content), contentFingerprint: createHash('sha256').update(content).digest('hex') }],
  })
  const run = prepared.run!
  const started = ImportRunRepository.startOrResume(run.id, 'failure-state-owner')
  const authority = { owner: started.execution.owner, epoch: started.execution.epoch }
  const chapterNumber = prepared.newChapterNumbers[0]
  const stableKey = ImportRunRepository.resolveReferenceImportAuthority(run.id, authority, chapterNumber).stableKey
  return () => importReferenceText(content, '第1章 旧港.txt', stableKey, chapterNumber, run.id, authority, projectPath, 'openai', ftsModel)
}

beforeAll(() => { fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true }) })

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), 'ai-novel-kb-failure-state-'))
  openCanonicalProjectFixture(projectPath)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  closeConnection(projectPath)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('what the author is told after a failure that already changed the knowledge base', () => {
  it('does not claim nothing changed when a reference import saved the document but its receipt could not be committed', async () => {
    const db = getProjectDb()!
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (/SET state = 'committed'/u.test(sql)) throw sqliteFull()
      return prepare(sql)
    })
    const run = referenceImport('林岚核对潮位表，发现旧港的记录被人改过。')

    const result = await run()

    expect(result.success).toBe(false)
    const documents = await listDocuments(projectPath)
    expect(documents).toHaveLength(1)
    expect(await getDocumentIntegrity(projectPath, documents[0].id)).toMatchObject({ complete: true })
    expect(await search(projectPath, '潮位表')).toEqual([expect.objectContaining({ fileName: '第1章 旧港.txt' })])
    expect(displayedErrorMessage(shown('zh-CN'), result.error)).not.toMatch(/没有改动/u)
    expect(displayedErrorMessage(shown('en-US'), result.error)).not.toMatch(/not changed/iu)
    expect(displayedErrorMessage(shown('ja-JP'), result.error)).not.toMatch(/変更されていません/u)

    vi.restoreAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(run()).resolves.toMatchObject({ success: true, idempotent: true })
  })

  it('does not claim nothing changed when a text-only import fails after the vector index was switched off', async () => {
    expect(await addChunks(projectPath, 'old-document', 'old.txt', ['旧港潮位表'], [vector], undefined, undefined, space)).toEqual({ success: true, chunkCount: 1 })
    expect((await getEmbeddingSpaces(projectPath)).activeGeneration).toBe(1)
    const lance = await getConnection(projectPath)
    const openTable = lance.openTable
    vi.spyOn(lance, 'openTable').mockImplementation(async (...args) => {
      if (String(args[0]) === 'chunks') throw enospc()
      return await Reflect.apply(openTable, lance, args)
    })

    const result = await addChunks(projectPath, 'new-document', 'new.txt', ['新资料'], undefined, undefined, undefined, space)
    vi.restoreAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(result).toMatchObject({ success: false, error: 'KNOWLEDGE_BASE_DISK_FULL' })
    expect((await getEmbeddingSpaces(projectPath)).activeGeneration).toBeNull()
    expect(await search(projectPath, '潮位表', vector, 5, space)).toEqual([expect.objectContaining({ fileName: 'old.txt', text: '旧港潮位表' })])
    expect((await listDocuments(projectPath)).map(document => document.id)).toEqual(['old-document'])
    expect(displayedErrorMessage(shown('zh-CN'), result.error)).not.toMatch(/没有改动/u)
    expect(displayedErrorMessage(shown('en-US'), result.error)).not.toMatch(/not changed/iu)
    expect(displayedErrorMessage(shown('ja-JP'), result.error)).not.toMatch(/変更されていません/u)
  })

  it('does not claim nothing changed when an ordinary import fails to index', async () => {
    const lance = await getConnection(projectPath)
    const createTable = lance.createTable
    vi.spyOn(lance, 'createTable').mockImplementation(async (...args) => {
      if (String(args[0]) === 'chunks') throw enospc()
      return await Reflect.apply(createTable, lance, args)
    })

    const result = await importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', ftsModel, { mode: 'fts-only' })
    vi.restoreAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(result).toMatchObject({ success: false, error: 'KNOWLEDGE_BASE_DISK_FULL' })
    expect(await listDocuments(projectPath)).toEqual([])
    expect(await search(projectPath, '潮位表')).toEqual([])
    expect(displayedErrorMessage(shown('zh-CN'), result.error)).not.toMatch(/没有改动/u)
  })
})

describe('storage errors whose message is itself a code', () => {
  it.each([
    ['SQLITE_FULL', 'KNOWLEDGE_BASE_DISK_FULL'],
    ['SQLITE_READONLY', 'KNOWLEDGE_BASE_UNWRITABLE'],
  ])('maps %s to the author-facing reason', async (code, expected) => {
    const db = getProjectDb()!
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (/SET state = 'committed'/u.test(sql)) throw Object.assign(new Error(code), { code })
      return prepare(sql)
    })

    const result = await referenceImport('林岚核对潮位表。')()

    expect(result.error).toBe(expected)
  })
})
