import type BetterSqlite3 from 'better-sqlite3'

import { LIVE_ROW_VIEWS, M07_DRAFT_COLUMNS, M07_DRAFT_SHAPE_SQL } from '../../electron/migrations/m07-chapter-recycle'

export function createLiveRowViews(db: BetterSqlite3.Database): void {
  const type = db.prepare('SELECT type FROM sqlite_master WHERE name=?').pluck()
  if (type.get('drafts') === 'table') {
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('drafts')").pluck().all() as string[])
    const present = M07_DRAFT_COLUMNS.filter(column => columns.has(column)).length
    if (present === 0) db.exec(M07_DRAFT_SHAPE_SQL)
    else if (present !== M07_DRAFT_COLUMNS.length) throw new Error('LIVE_ROW_VIEWS_PARTIAL_DELETION_COLUMNS')
  }
  for (const { view, table, sql } of LIVE_ROW_VIEWS) {
    if (type.get(view) !== 'table') continue
    db.exec(`ALTER TABLE ${view} RENAME TO ${table}`)
    db.exec(sql)
  }
}

export function dropLiveRowViews(db: BetterSqlite3.Database): void {
  for (const { view } of LIVE_ROW_VIEWS) db.exec(`DROP VIEW ${view}`)
  for (const { view, table } of LIVE_ROW_VIEWS) db.exec(`ALTER TABLE ${table} RENAME TO ${view}`)
}
