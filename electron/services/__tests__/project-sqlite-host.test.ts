import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { SchemaMigrationError } from '../../migrations/registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { runProjectSqliteJobInWorker, type ProjectSqliteWorkerOptions } from '../project-sqlite-host'
import { openProjectSqlite } from '../sqlite-project-migration'
import { projectSqliteWorkerForTest } from '../../../test/helpers/portable-export-worker'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
type DatabaseHandle = import('better-sqlite3').Database

let worker: ProjectSqliteWorkerOptions
beforeAll(async () => { worker = await projectSqliteWorkerForTest() }, 60_000)

const roots: string[] = []
const handles: DatabaseHandle[] = []
afterEach(() => {
  for (const database of handles.splice(0)) if (database.open) database.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function book(schemaVersion: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-sqlite-host-'))
  roots.push(root)
  const databasePath = path.join(root, 'project.db')
  const database = new Database(databasePath)
  handles.push(database)
  database.pragma('foreign_keys = ON')
  initializeLegacyBaselineSchema(database)
  migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), schemaVersion)
  database.prepare(`INSERT INTO project_core (
      id, project_name, genre, sub_genre, target_audience, total_chapters, words_per_chapter, writing_language,
      plot_structure, narrative_pov, core_outline, world_setting, golden_finger, protagonist_profile,
      global_guidance, writing_style, premise, worldbuilding, characters_arch, synopsis
    ) VALUES ('main', ?, '悬疑', '都市', '成年读者', 3, 3000, 'zh-CN', 'three_act', 'third_limited',
      '核心大纲', '世界设定', '无', '主角档案', '保持克制', '冷峻现实主义', '', '', '', '')`).run(randomUUID())
  return { databasePath, database }
}

const version = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true })
  try { return database.pragma('user_version', { simple: true }) } finally { database.close() }
}

describe('打开作品时的升级与校验在 worker 里跑（#702）', () => {
  it('worker 把旧版本的书升到当前版本，交回的内容身份和主线程重开时一致', async () => {
    const { databasePath, database } = book(CURRENT_DESKTOP_SCHEMA_VERSION - 1)
    database.close()

    const identity = await runProjectSqliteJobInWorker({ kind: 'open', databasePath }, worker)

    expect(version(databasePath)).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(identity).toEqual(openProjectSqlite({ databasePath }))
  })

  it('校验失败时，worker 带回的报错和主线程报的一字不差', async () => {
    const { databasePath, database } = book(CURRENT_DESKTOP_SCHEMA_VERSION)
    database.pragma('foreign_keys = OFF')
    database.prepare('INSERT INTO review_cycle_merges(cycle_id,body) VALUES(?,?)').run('missing-cycle', '孤儿快照')
    database.close()
    const onMain = (() => { try { openProjectSqlite({ databasePath }) } catch (error) { return error } })()
    expect(onMain).toBeInstanceOf(SchemaMigrationError)

    const inWorker = await runProjectSqliteJobInWorker({ kind: 'open', databasePath }, worker).then(() => undefined, error => error)

    expect(String(inWorker)).toBe(String(onMain))
    expect(inWorker).toMatchObject({ code: (onMain as SchemaMigrationError).code })
  })

  it('升级等写锁时主进程照常响应，放锁后打开完成', async () => {
    const { databasePath, database } = book(CURRENT_DESKTOP_SCHEMA_VERSION - 1)
    database.close()
    const holder = new Database(databasePath)
    handles.push(holder)
    holder.exec('BEGIN IMMEDIATE')
    let ticks = 0
    const ticker = setInterval(() => { ticks += 1 }, 20)
    setTimeout(() => holder.exec('COMMIT'), 400)

    try {
      const opening = runProjectSqliteJobInWorker({ kind: 'open', databasePath }, worker)
      await expect(opening).resolves.toBeDefined()
    } finally { clearInterval(ticker) }

    expect(ticks).toBeGreaterThanOrEqual(10)
    expect(version(databasePath)).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
  })
})
