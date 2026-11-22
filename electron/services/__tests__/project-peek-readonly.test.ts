import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { ProjectPeekService, readPeekSnapshot } from '../project-peek'
import { verifyOpenedSchema } from '../sqlite-project-migration'
import type { ProjectSqliteWorkerOptions } from '../project-sqlite-host'
import { projectSqliteWorkerForTest } from '../../../test/helpers/portable-export-worker'
import { attachStatementLedger, breakReviewProof, seedReviewedBook } from '../../../test/helpers/review-cycle-fixture'

vi.mock('../../migrations/runner', async importOriginal => {
  const actual = await importOriginal<typeof import('../../migrations/runner')>()
  return { ...actual, migrateSchema: vi.fn(actual.migrateSchema) }
})

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
type DatabaseHandle = import('better-sqlite3').Database

let worker: ProjectSqliteWorkerOptions
beforeAll(async () => { worker = await projectSqliteWorkerForTest() }, 60_000)

const roots: string[] = []
const handles: DatabaseHandle[] = []
afterEach(() => {
  for (const database of handles.splice(0)) database.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function manifest(projectId: string) {
  return {
    schemaVersion: 1,
    kind: 'ai-novel-project',
    projectId,
    createdAt: '2026-09-21T00:00:00.000Z',
    storageFormat: 'ai-novel',
    storageVersion: 1,
  }
}

function fixture(options: { schemaVersion?: number; journalMode?: 'delete' | 'wal' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-project-peek-'))
  roots.push(root)
  const storage = path.join(root, '.ai-novel')
  const scratch = path.join(root, 'peek-scratch')
  fs.mkdirSync(storage)
  const projectId = randomUUID()
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(manifest(projectId)))
  const databasePath = path.join(storage, 'project.db')
  const database = new Database(databasePath)
  handles.push(database)
  database.pragma('foreign_keys = ON')
  initializeLegacyBaselineSchema(database)
  const schemaVersion = options.schemaVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION
  migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), schemaVersion)
  if (schemaVersion === CURRENT_DESKTOP_SCHEMA_VERSION) seedCore(database)
  if (options.journalMode === 'wal') database.pragma('journal_mode = WAL')
  return { root, storage, scratch, projectId, databasePath, database }
}

function seedCore(database: DatabaseHandle, totalChapters = 3) {
  database.prepare(`
    INSERT INTO project_core (
      id, project_name, genre, sub_genre, target_audience, total_chapters,
      words_per_chapter, writing_language, plot_structure, narrative_pov,
      core_outline, world_setting, golden_finger, protagonist_profile,
      global_guidance, writing_style, premise, worldbuilding, characters_arch, synopsis
    ) VALUES (
      'main', '雨夜来信', '悬疑', '都市', '成年读者', ?,
      3000, 'zh-CN', 'three_act', 'third_limited',
      '核心大纲', '世界设定', '无', '主角档案',
      '保持克制', '冷峻现实主义', '', '', '', ''
    )
  `).run(totalChapters)
}

function addChapter(database: DatabaseHandle, chapterNumber: number, options: {
  blueprint?: boolean; draft?: boolean; review?: boolean; finalized?: boolean
} = {}) {
  if (options.blueprint) database.prepare('INSERT INTO blueprints (chapter_number,title) VALUES (?,?)')
    .run(chapterNumber, `第${chapterNumber}章`)
  if (!options.draft && !options.review && !options.finalized) return
  const body = `第${chapterNumber}章正文：雨落在旧车站。`
  const content = database.prepare('INSERT INTO contents (body) VALUES (?)').run(body)
  // schema 7 的夹具还没有 M07 改名。
  const raw = (table: string) => database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`${table}_all`)
    ? `${table}_all` : table
  const draft = database.prepare(`
    INSERT INTO ${raw('drafts')} (chapter_number,version,status,source,content_id,word_count)
    VALUES (?,1,?,'write',?,?)
  `).run(chapterNumber, options.finalized ? 'finalized' : 'draft', content.lastInsertRowid, 12)
  if (options.review) {
    const report = database.prepare('INSERT INTO contents (body) VALUES (?)').run('审稿意见')
    database.prepare(`
      INSERT INTO reviews (base_draft_id,review_index,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id)
      VALUES (?,1,?,1,?,?,?)
    `).run(draft.lastInsertRowid, chapterNumber, options.finalized ? 'finalized' : 'draft', body, report.lastInsertRowid)
  }
  if (options.finalized) {
    database.prepare(`
      INSERT INTO ${raw('finalization_outbox')} (
        finalization_id,draft_id,chapter_number,chapter_title,content_hash,
        content_revision,content_snapshot,target_file_name,publication_status
      ) VALUES (?,?,?,?,?,?,?,?,'pending')
    `).run(
      `final-${chapterNumber}`,
      draft.lastInsertRowid,
      chapterNumber,
      `第${chapterNumber}章`,
      createHash('sha256').update(body).digest('hex'),
      1,
      body,
      `chapter-${chapterNumber}.txt`,
    )
  }
}

function sourceState(databasePath: string) {
  return Object.fromEntries(['', '-wal', '-shm'].filter(suffix => fs.existsSync(databasePath + suffix)).map(suffix => {
    const file = databasePath + suffix
    const stat = fs.statSync(file)
    return [suffix, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    }]
  }))
}

function ready<T extends { state: string }>(overview: T): asserts overview is T & { state: 'ready' } {
  expect(overview.state).toBe('ready')
}

describe('ProjectPeekService source-zero-write overview', () => {
  it('accepts only a live opaque capability and invalidates it on revoke or manifest drift', async () => {
    const f = fixture()
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    const capability = service.issueCapability(f.root)
    expect(capability).toEqual({ capabilityId: expect.any(String), projectId: f.projectId })
    expect(await service.peek(`${capability!.capabilityId}-tampered`)).toEqual({ state: 'unavailable' })

    ready(await service.peek(capability!.capabilityId))
    service.revokeCapability(capability!.capabilityId)
    expect(await service.peek(capability!.capabilityId)).toEqual({ state: 'unavailable' })

    const replacement = service.issueCapability(f.root)!
    fs.writeFileSync(path.join(f.storage, 'project.json'), JSON.stringify(manifest(randomUUID())))
    expect(await service.peek(replacement.capabilityId)).toEqual({ state: 'unavailable' })
  })

  it('never changes source DB/WAL/SHM, creates no source sidecar, and cleans its exact attempt', async () => {
    const f = fixture({ journalMode: 'wal' })
    addChapter(f.database, 1, { blueprint: true, draft: true, review: true, finalized: true })
    const userVersion = f.database.pragma('user_version', { simple: true })
    const outbox = f.database.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()
    const before = sourceState(f.databasePath)
    expect(Object.keys(before)).toEqual(['', '-wal', '-shm'])
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    const overview = await service.peek(service.issueCapability(f.root)!.capabilityId)

    ready(overview)
    expect(sourceState(f.databasePath)).toEqual(before)
    expect(f.database.pragma('user_version', { simple: true })).toBe(userVersion)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()).toEqual(outbox)
    expect(fs.readdirSync(f.storage).sort()).toEqual(['project.db', 'project.db-shm', 'project.db-wal', 'project.json'])
    expect(fs.readdirSync(f.scratch)).toEqual([])
  })

  it('creates no WAL/SHM beside a source database that had none', async () => {
    const f = fixture()
    const before = sourceState(f.databasePath)
    expect(Object.keys(before)).toEqual([''])
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    ready(await service.peek(service.issueCapability(f.root)!.capabilityId))
    expect(sourceState(f.databasePath)).toEqual(before)
    expect(fs.existsSync(`${f.databasePath}-wal`)).toBe(false)
    expect(fs.existsSync(`${f.databasePath}-shm`)).toBe(false)
  })

  it('refuses legacy roots plus old, future, and forked desktop schemas', async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-project-peek-legacy-'))
    roots.push(legacyRoot)
    fs.mkdirSync(path.join(legacyRoot, '.vela'))
    const service = new ProjectPeekService({ scratchRoot: path.join(legacyRoot, 'scratch'), worker })
    expect(service.issueCapability(legacyRoot)).toBeNull()

    const old = fixture({ schemaVersion: 5 })
    const future = fixture()
    future.database.pragma(`user_version = ${CURRENT_DESKTOP_SCHEMA_VERSION + 1}`)
    const fork = fixture()
    fork.database.exec('CREATE TABLE unrecognized_fork (id INTEGER PRIMARY KEY)')
    for (const candidate of [old, future, fork]) {
      const candidateService = new ProjectPeekService({ scratchRoot: candidate.scratch, worker })
      const capability = candidateService.issueCapability(candidate.root)!
      expect(await candidateService.peek(capability.capabilityId)).toEqual({ state: 'unavailable' })
    }
  })

  // 最近项目列表在正常打开升级之前就预览，旧 schema 也必须照常统计，结果与已升级的书一样。
  it.each([7, 8, 9, 10, 11])('previews a schema-%i project like a current one, leaving the source as it was', async version => {
    const book = (schemaVersion: number) => {
      const f = fixture({ schemaVersion, journalMode: 'wal' })
      if (schemaVersion !== CURRENT_DESKTOP_SCHEMA_VERSION) seedCore(f.database)
      addChapter(f.database, 1, { blueprint: true, draft: true, review: true, finalized: true })
      addChapter(f.database, 2, { draft: true })
      f.database.prepare("INSERT INTO characters(character_id,name,cs_location) VALUES('c1','林澈','北门')").run()
      return f
    }
    const peek = (f: ReturnType<typeof book>) => {
      const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
      return service.peek(service.issueCapability(f.root)!.capabilityId)
    }
    const current = await peek(book(CURRENT_DESKTOP_SCHEMA_VERSION))
    const f = book(version)
    const before = sourceState(f.databasePath)
    const overview = await peek(f)

    ready(overview)
    ready(current)
    expect(overview).toMatchObject({ ...current, projectId: f.projectId, revision: overview.revision, name: '雨夜来信', totalWords: 24, finalizedChapters: 1 })
    expect(overview.stages.find(stage => stage.id === 'drafting')).toEqual({ id: 'drafting', status: 'in-progress', count: 2 })
    expect(sourceState(f.databasePath)).toEqual(before)
    expect(f.database.pragma('user_version', { simple: true })).toBe(version)
    expect(fs.readdirSync(f.storage).sort()).toEqual(['project.db', 'project.db-shm', 'project.db-wal', 'project.json'])
    expect(fs.readdirSync(f.scratch)).toEqual([])
  })

  // 预览只读概览要的表；在副本上整本升级一遍，作者点一下封面就要等升级那么久（#702）。
  it('previews an older book without running the migration lane', () => {
    const f = fixture({ schemaVersion: CURRENT_DESKTOP_SCHEMA_VERSION - 1 })
    seedCore(f.database)
    addChapter(f.database, 1, { draft: true, finalized: true })
    vi.mocked(migrateSchema).mockClear()
    ready(readPeekSnapshot({ databasePath: f.databasePath, projectId: f.projectId, manifestFingerprint: 'manifest', scratchRoot: f.scratch,
      recognizedSchemas: getDesktopMigrationRegistry().recognizedSchemas }))
    expect(migrateSchema).not.toHaveBeenCalled()
  })

  it('复制快照期间源库被写过，这次预览作废', () => {
    const f = fixture()
    const request = { databasePath: f.databasePath, projectId: f.projectId, manifestFingerprint: 'manifest', scratchRoot: f.scratch,
      recognizedSchemas: getDesktopMigrationRegistry().recognizedSchemas }
    const read = fs.readSync
    const spy = vi.spyOn(fs, 'readSync').mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      const count = read(...args)
      f.database.prepare("UPDATE project_core SET genre='科幻'").run()
      return count
    })
    try {
      expect(() => readPeekSnapshot(request)).toThrow('PROJECT_PEEK_SOURCE_CHANGED')
    } finally { spy.mockRestore() }
    expect(fs.readdirSync(f.scratch)).toEqual([])
  })

  it('reports conservative counts and never marks one chapter as a completed multi-chapter plan', async () => {
    const f = fixture()
    f.database.prepare("UPDATE project_core SET premise='前提', worldbuilding='世界观'").run()
    f.database.prepare("INSERT INTO characters (character_id,name,retired) VALUES ('c1','林舟',0),('c2','已退场',1)").run()
    addChapter(f.database, 1, { blueprint: true, draft: true, review: true, finalized: true })
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    const overview = await service.peek(service.issueCapability(f.root)!.capabilityId)

    ready(overview)
    expect(overview).toMatchObject({
      projectId: f.projectId,
      revision: expect.any(String),
      name: '雨夜来信',
      totalWords: 12,
      characters: 1,
      finalizedChapters: 1,
    })
    expect(overview).not.toHaveProperty('path')
    expect(overview).not.toHaveProperty('excerpt')
    expect(JSON.stringify(overview)).not.toContain(f.root)
    expect(overview.stages).toEqual([
      { id: 'configuration', status: 'completed', count: 9 },
      { id: 'architecture', status: 'in-progress', count: 2 },
      { id: 'blueprint', status: 'in-progress', count: 1 },
      { id: 'drafting', status: 'in-progress', count: 1 },
      { id: 'review', status: 'in-progress', count: 1 },
      { id: 'finalization', status: 'in-progress', count: 1 },
    ])
  })

  it('reports setup readiness from the four required fields and the planned chapter count, not the nine-field count', async () => {
    const f = fixture()
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    const peek = async () => {
      const overview = await service.peek(service.issueCapability(f.root)!.capabilityId)
      ready(overview)
      return { setupReady: overview.setupReady, plannedChapters: overview.plannedChapters, configuration: overview.stages[0].count }
    }
    expect(await peek()).toEqual({ setupReady: true, plannedChapters: 3, configuration: 9 })
    f.database.prepare("UPDATE project_core SET world_setting='', golden_finger=''").run()
    expect(await peek()).toEqual({ setupReady: true, plannedChapters: 3, configuration: 7 })
    f.database.prepare("UPDATE project_core SET target_audience=' '").run()
    expect(await peek()).toMatchObject({ setupReady: false })
    f.database.prepare("UPDATE project_core SET target_audience='成年读者', words_per_chapter=0").run()
    expect(await peek()).toMatchObject({ setupReady: false })
  })

  it('does not count a finalized status whose frozen outbox fact is inconsistent', async () => {
    const f = fixture()
    f.database.prepare('UPDATE project_core SET total_chapters=1').run()
    addChapter(f.database, 1, { draft: true, finalized: true })
    f.database.prepare("UPDATE finalization_outbox_all SET content_hash='not-the-content-hash'").run()
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    const overview = await service.peek(service.issueCapability(f.root)!.capabilityId)

    ready(overview)
    expect(overview.finalizedChapters).toBe(0)
    expect(overview.stages[5]).toEqual({ id: 'finalization', status: 'not-started', count: 0 })
  })

  it('uses unknown for an unknown plan, in-progress once data exists, and only completes full planned coverage', async () => {
    const unknown = fixture()
    unknown.database.prepare('UPDATE project_core SET total_chapters=0').run()
    const unknownService = new ProjectPeekService({ scratchRoot: unknown.scratch, worker })
    const empty = await unknownService.peek(unknownService.issueCapability(unknown.root)!.capabilityId)
    ready(empty)
    expect(empty.stages.slice(2).map(stage => stage.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    unknown.database.prepare("INSERT INTO blueprints (chapter_number,title) VALUES (7,'片段')").run()
    const withData = await unknownService.peek(unknownService.issueCapability(unknown.root)!.capabilityId)
    ready(withData)
    expect(withData.stages[2]).toEqual({ id: 'blueprint', status: 'in-progress', count: 1 })

    const complete = fixture()
    complete.database.prepare('UPDATE project_core SET total_chapters=2').run()
    addChapter(complete.database, 1, { blueprint: true, draft: true, review: true, finalized: true })
    addChapter(complete.database, 2, { blueprint: true, draft: true, review: true, finalized: true })
    const completeService = new ProjectPeekService({ scratchRoot: complete.scratch, worker })
    const overview = await completeService.peek(completeService.issueCapability(complete.root)!.capabilityId)
    ready(overview)
    expect(overview.stages.slice(2).map(stage => stage.status)).toEqual(['completed', 'completed', 'completed', 'completed'])
  })

  it('does not count a finalized draft without an authoritative outbox receipt', async () => {
    const f = fixture()
    const content = f.database.prepare('INSERT INTO contents (body) VALUES (?)').run('缺少定稿回执的正文')
    f.database.prepare(`
      INSERT INTO drafts_all (chapter_number,version,status,source,content_id,word_count)
      VALUES (1,1,'finalized','write',?,10)
    `).run(content.lastInsertRowid)
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })

    const external = await service.peek(service.issueCapability(f.root)!.capabilityId)
    const current = service.readCurrent(f.projectId, f.database)
    ready(external)
    ready(current)
    expect(external.finalizedChapters).toBe(0)
    expect(current.finalizedChapters).toBe(0)
    expect(external.stages[5]).toEqual({ id: 'finalization', status: 'not-started', count: 0 })
  })

  it('treats a later reviewed draft as the chapter current draft for words and excerpt (#452)', () => {
    const f = fixture()
    addChapter(f.database, 1, { draft: true })
    const reviewed = f.database.prepare('INSERT INTO contents (body) VALUES (?)').run('第1章审过的新稿：灯塔亮了。')
    f.database.prepare(`
      INSERT INTO drafts_all (chapter_number,version,status,source,content_id,word_count)
      VALUES (1,2,'reviewed','revise',?,30)
    `).run(reviewed.lastInsertRowid)
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    const current = service.readCurrent(f.projectId, f.database)

    ready(current)
    expect(current.totalWords).toBe(30)
    expect(current.excerpt).toContain('灯塔亮了')
    expect(current.excerpt).not.toContain('雨落在旧车站')
    expect(current.stages[3]).toEqual({ id: 'drafting', status: 'in-progress', count: 1 })
  })

  it('allows an excerpt only for the already-open current database and performs SELECT-only aggregation', async () => {
    const f = fixture()
    addChapter(f.database, 1, { draft: true })
    const beforeChanges = f.database.prepare('SELECT total_changes()').pluck().get()
    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    const current = service.readCurrent(f.projectId, f.database)
    const external = await service.peek(service.issueCapability(f.root)!.capabilityId)

    ready(current)
    ready(external)
    expect(current.excerpt).toContain('雨落在旧车站')
    expect(external).not.toHaveProperty('excerpt')
    expect(f.database.prepare('SELECT total_changes()').pluck().get()).toBe(beforeChanges)
  })
})

describe('书架上其他书的预览不比打开作品校验得多（ADR-0029 决定 1）', () => {
  it('有一条审修循环过不了全书证明、打开得了的书，预览照常给出统计', async () => {
    const f = fixture()
    const book = seedReviewedBook(f.database, 2, { firstChapter: 2 })
    breakReviewProof(f.database, book[1]!)
    expect(() => verifyOpenedSchema(f.database)).not.toThrow()

    const service = new ProjectPeekService({ scratchRoot: f.scratch, worker })
    ready(await service.peek(service.issueCapability(f.root)!.capabilityId))
  })
})

describe('当前作品的书库概览只做打开作品时的校验（ADR-0029 决定 1）', () => {
  it('有一条审修循环过不了全书证明时，当前作品的概览照常可用', () => {
    const f = fixture()
    const book = seedReviewedBook(f.database, 2, { firstChapter: 2 })
    breakReviewProof(f.database, book[1]!)

    ready(new ProjectPeekService({ scratchRoot: f.scratch }).readCurrent(f.projectId, f.database))
  })

  it('只扫一遍全库外键', () => {
    const f = fixture()
    const ledger = attachStatementLedger(f.database)
    try {
      ready(new ProjectPeekService({ scratchRoot: f.scratch }).readCurrent(f.projectId, f.database))
      expect(ledger.counts.get('PRAGMA foreign_key_check')).toBe(1)
    } finally { ledger.detach() }
  })

  it.each([
    ['外键损坏', (database: DatabaseHandle) => {
      database.pragma('foreign_keys = OFF')
      database.prepare('INSERT INTO review_cycle_merges(cycle_id,body) VALUES(?,?)').run('missing-cycle', '孤儿快照')
      database.pragma('foreign_keys = ON')
    }],
    ['结构不认识', (database: DatabaseHandle) => { database.exec('ALTER TABLE contents ADD COLUMN fork_secret TEXT') }],
    ['版本不符', (database: DatabaseHandle) => { database.pragma(`user_version = ${CURRENT_DESKTOP_SCHEMA_VERSION - 1}`) }],
    ['角色身份账目对不上（M02）', (database: DatabaseHandle) => {
      database.exec("UPDATE character_identity_meta SET legacy_count=legacy_count+1 WHERE id='main'")
    }],
  ] as const)('%s的当前作品，概览仍不可用', (_name, damage) => {
    const f = fixture()
    damage(f.database)

    expect(new ProjectPeekService({ scratchRoot: f.scratch }).readCurrent(f.projectId, f.database)).toEqual({ state: 'unavailable' })
  })
})

describe('书房预览和打开同一本书同时进行', () => {
  it('预览开着源库的复制句柄时，打开作品的可写连接照常能写入，这次预览作废', () => {
    const f = fixture({ journalMode: 'wal' })
    handles.splice(handles.indexOf(f.database), 1)
    f.database.close()
    const request = { databasePath: f.databasePath, projectId: f.projectId, manifestFingerprint: 'manifest', scratchRoot: f.scratch,
      recognizedSchemas: getDesktopMigrationRegistry().recognizedSchemas }
    const open = fs.openSync
    let written: unknown
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args)
      if (written === undefined && args[0] === f.databasePath) {
        const writer = new Database(f.databasePath, { fileMustExist: true })
        try {
          writer.pragma('journal_mode = WAL')
          writer.prepare("UPDATE project_core SET genre='科幻'").run()
          written = writer.prepare('SELECT genre FROM project_core').get()
        } finally { writer.close() }
      }
      return fd
    })
    try {
      expect(() => readPeekSnapshot(request)).toThrow('PROJECT_PEEK_SOURCE_CHANGED')
    } finally { spy.mockRestore() }

    expect(written).toEqual({ genre: '科幻' })
    expect(fs.readdirSync(f.scratch)).toEqual([])
  })
})
