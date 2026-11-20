import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { inspectM03ReviewCycles } from '../../migrations/m03-review-cycle'
import { extractPortableProjectArchive, writePortableProjectArchive } from '../portable-project-archive'
import { exportPortableProject, type ExportPortableProjectInput } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { seedReviewedBook } from '../../../test/helpers/review-cycle-fixture'
import { readReviewProof } from '../../../src/shared/review-proof'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../../src/shared/project-format'
import type { ReviewFinalizedMaterial } from '../../../src/shared/review-revision-generation'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

let base = ''
let projectRoot = ''
let projectId = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'proof-seal-'))
  projectRoot = path.join(base, 'book')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot)
  projectId = JSON.parse(fs.readFileSync(path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, 'project.json'), 'utf8')).projectId
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(base, { recursive: true, force: true })
})

const prose = (chapter: number) => `第${chapter}章。` + '林岚走进北塔，灯火照亮了石阶。'.repeat(40)
/** 升级前的书童把前文全部定稿原文冻结进每条审修证明。 */
const priorChapters = (chapter: number): ReviewFinalizedMaterial[] => Array.from({ length: chapter - 1 }, (_, index) => ({
  draftId: 10_000 + index, chapterNumber: index + 1, chapterTitle: `第${index + 1}章`, content: prose(index + 1) }))

function reviewedBook(chapters: number) {
  const db = getProjectDb()!
  const items = seedReviewedBook(db, chapters, { history: priorChapters })
  db.prepare('UPDATE generation_roots SET budget_json=?').run(JSON.stringify({ maxPhysicalRequests: 1,
    maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
  return items
}

function exportInput(): ExportPortableProjectInput {
  return {
    sourceProjectRoot: projectRoot,
    projectSession: { projectId, projectPath: projectRoot, leaseId: 'lease' },
    targetArchivePath: path.join(base, `${randomUUID()}.ainovel`),
    attemptParentPath: base,
    assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], semanticCounts: { 'provided-assets': 0 }, omittedItems: [],
      transferReceiptIds: [], historyProjectionIds: [] }) },
  }
}

async function exportBook() {
  const input = exportInput()
  const receipt = await exportPortableProject(input)
  return { archivePath: input.targetArchivePath, receipt }
}

async function restore(archivePath: string) {
  closeProjectDatabase()
  const target = path.join(base, `restored-${randomUUID()}`)
  await restorePortableProject({ archivePath, targetProjectRoot: target })
  initProjectDatabase(target)
  return target
}

interface SavedProof { runId: string; proofKind: string; proofHash?: string; receiptHash: string; version?: unknown; hasHistory: boolean }
function savedProofs(db: import('better-sqlite3').Database): SavedProof[] {
  const rows = db.prepare(`SELECT r.run_id,r.binding_json,json_extract(t.usage_receipt_json,'$.reviewRevisionEffect.contextHash') AS receipt_hash
    FROM generation_runs r JOIN generation_attempts t ON t.run_id=r.run_id
    WHERE json_type(t.usage_receipt_json,'$.reviewRevisionEffect')='object' ORDER BY r.run_id`).all() as Array<{
      run_id: string; binding_json: string; receipt_hash: string }>
  return rows.map(row => {
    const manifest = JSON.parse(row.binding_json).sourceManifest
    const proof = readReviewProof(manifest, sha256)
    return { runId: row.run_id, proofKind: proof.kind, receiptHash: row.receipt_hash,
      ...(proof.kind === 'recomputable' || proof.kind === 'sealed' ? { proofHash: proof.contextHash, version: proof.context.version } : {}),
      hasHistory: 'history' in (manifest?.reviewRevisionContext ?? {}) }
  })
}

const verifiedStrictly = (db: import('better-sqlite3').Database) => inspectM03ReviewCycles(db)

/** 解开存档，改存档库里某条运行的绑定或收据，再按原样重新打包（条目哈希随之更新）。 */
async function tamperedArchive(archivePath: string, edit: (db: import('better-sqlite3').Database) => void): Promise<string> {
  const unpacked = await extractPortableProjectArchive({ archivePath, stagingParentPath: fs.mkdtempSync(path.join(base, 'unpack-')) })
  const databaseFile = path.join(unpacked.stagingPath, CANONICAL_PROJECT_DATABASE)
  const archived = new Database(databaseFile)
  try { edit(archived) } finally { archived.close() }
  const bytes = fs.readFileSync(databaseFile)
  const entries = unpacked.manifest.entries.map(entry => entry.path === CANONICAL_PROJECT_DATABASE
    ? { ...entry, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } : entry)
  const total = entries.reduce((sum, entry) => sum + entry.byteSize, 0)
  const target = path.join(base, `tampered-${randomUUID()}.ainovel`)
  await writePortableProjectArchive({ manifest: { ...unpacked.manifest, entries, declaredUncompressedBytes: total, declaredCompressedBytes: total },
    sources: entries.map(entry => ({ entry, sourcePath: path.join(unpacked.stagingPath, ...entry.path.split('/')) })), targetPath: target })
  return target
}

/** 改第 1 章审稿运行的审修证明；write 决定是否把清单里的哈希和作者输入改成与改后上下文自洽。 */
function editReviewProof(db: import('better-sqlite3').Database, change: (context: Record<string, unknown>) => void, write: 'self-consistent' | 'context-only') {
  const json = db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-review-ch1'").pluck().get() as string
  const binding = JSON.parse(json)
  const manifest = binding.sourceManifest
  change(manifest.reviewRevisionContext)
  const contextJson = JSON.stringify(manifest.reviewRevisionContext)
  manifest.authorInputs = [{ id: 'review-revision-context', text: contextJson }]
  if (write === 'self-consistent') manifest.reviewRevisionContextHash = sha256(contextJson)
  db.prepare("UPDATE generation_runs SET binding_json=? WHERE run_id='run-review-ch1'").run(JSON.stringify(binding))
}

describe('导出时封存老章节的审修证明（#702 PR 3）', () => {
  it('112 章、每条证明带前文的老书：存档不超过 20 MB，恢复后从严校验通过，收据哈希不变', { timeout: 300_000 }, async () => {
    reviewedBook(112)
    const before = savedProofs(getProjectDb()!)
    expect(before).toHaveLength(224)
    expect(before.every(item => item.proofKind === 'recomputable' && item.version === 1 && item.proofHash === item.receiptHash)).toBe(true)

    const { archivePath, receipt } = await exportBook()
    expect(receipt.targetByteSize).toBeLessThan(20 * 1024 * 1024)

    await restore(archivePath)
    const restored = getProjectDb()!
    expect(verifiedStrictly(restored)).toEqual({ structureOk: true, unprovable: [] })
    const after = savedProofs(restored)
    expect(after.map(item => [item.runId, item.receiptHash])).toEqual(before.map(item => [item.runId, item.receiptHash]))
    expect(after.every(item => item.proofKind === 'sealed' && item.proofHash === item.receiptHash && !item.hasHistory)).toBe(true)
  })

  it('封存过的书再导出再恢复：证明仍是封存形，从严校验通过；源库里的全文证明不动', { timeout: 120_000 }, async () => {
    reviewedBook(3)
    const source = savedProofs(getProjectDb()!)
    const once = await restore((await exportBook()).archivePath)
    projectRoot = once
    projectId = JSON.parse(fs.readFileSync(path.join(once, CANONICAL_PROJECT_DIRECTORY, 'project.json'), 'utf8')).projectId
    await restore((await exportBook()).archivePath)
    const twice = getProjectDb()!
    expect(verifiedStrictly(twice)).toEqual({ structureOk: true, unprovable: [] })
    expect(savedProofs(twice).every(item => item.proofKind === 'sealed' && item.proofHash === item.receiptHash)).toBe(true)
    expect(source.every(item => item.proofKind === 'recomputable' && item.hasHistory)).toBe(true)
  })

  it('同一审修循环下没保存的运行：导出照原样带全文证明', { timeout: 120_000 }, async () => {
    reviewedBook(2)
    getProjectDb()!.prepare(`INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key)
      SELECT 'run-unsaved-ch2',root_action_id,binding_json,status,3,'open-unsaved-ch2' FROM generation_runs WHERE run_id='run-review-ch2'`).run()
    const { archivePath } = await exportBook()
    const { stagingPath } = await extractPortableProjectArchive({ archivePath, stagingParentPath: fs.mkdtempSync(path.join(base, 'unpack-')) })
    const archived = new Database(path.join(stagingPath, CANONICAL_PROJECT_DATABASE), { readonly: true })
    try {
      const kinds = Object.fromEntries((archived.prepare('SELECT run_id,binding_json FROM generation_runs ORDER BY run_id').all() as Array<{
        run_id: string; binding_json: string }>).map(row => {
        const proof = readReviewProof(JSON.parse(row.binding_json).sourceManifest, sha256)
        return [row.run_id, proof.kind === 'recomputable' ? `v${proof.context.version}` : proof.kind]
      }))
      expect(kinds).toEqual({ 'run-review-ch1': 'sealed', 'run-revision-ch1': 'sealed', 'run-review-ch2': 'sealed',
        'run-revision-ch2': 'sealed', 'run-unsaved-ch2': 'v1' })
    } finally { archived.close() }
  })

  describe('改过的封存存档恢复时被拒绝', () => {
    async function sealedArchive() {
      reviewedBook(1)
      const { archivePath } = await exportBook()
      return archivePath
    }
    const rejected = (archivePath: string) => restorePortableProject({ archivePath, targetProjectRoot: path.join(base, `rejected-${randomUUID()}`) })

    it('原样的封存存档能恢复（对照）', { timeout: 60_000 }, async () => {
      const archivePath = await tamperedArchive(await sealedArchive(), () => undefined)
      await expect(restore(archivePath)).resolves.toBeTruthy()
    })

    it('改来源稿正文，封存哈希与作者输入改成自洽：拒绝', { timeout: 60_000 }, async () => {
      const archivePath = await tamperedArchive(await sealedArchive(), db => editReviewProof(db, context => {
        expect(context.rewrittenFrom).toBe(1)
        const source = context.source as { content: string }
        source.content += '作者没写过的句子。'
        context.sourceHash = sha256(source.content)
      }, 'self-consistent'))
      await expect(rejected(archivePath)).rejects.toThrow()
    })

    it('改封存形里的字段，不改封存哈希：拒绝', { timeout: 60_000 }, async () => {
      const archivePath = await tamperedArchive(await sealedArchive(), db => editReviewProof(db, context => {
        expect(context.rewrittenFrom).toBe(1)
        context.wordsPerChapter = 9999
      }, 'context-only'))
      await expect(rejected(archivePath)).rejects.toThrow()
    })

    it('改收据里的上下文哈希：拒绝', { timeout: 60_000 }, async () => {
      const archivePath = await tamperedArchive(await sealedArchive(), db => {
        const binding = JSON.parse(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-review-ch1'").pluck().get() as string)
        expect(binding.sourceManifest.reviewRevisionContext.rewrittenFrom).toBe(1)
        db.prepare(`UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contextHash',?)
          WHERE run_id='run-review-ch1'`).run(sha256('另一份上下文'))
      })
      await expect(rejected(archivePath)).rejects.toThrow()
    })

    it('去掉 rewrittenFrom，清单哈希与作者输入改成自洽的 v2：拒绝', { timeout: 60_000 }, async () => {
      const archivePath = await tamperedArchive(await sealedArchive(), db => editReviewProof(db, context => {
        expect(context.rewrittenFrom).toBe(1)
        delete context.rewrittenFrom
      }, 'self-consistent'))
      await expect(rejected(archivePath)).rejects.toThrow()
    })
  })
})
