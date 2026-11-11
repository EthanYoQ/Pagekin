import { getProjectDb } from '../database'
import type { ConsistencyExemption } from '../../src/shared/consistency-preflight'

function requireText(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 500) throw new Error(code)
  return normalized
}

function requireChapter(value: number | null): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new Error('CONSISTENCY_EXEMPTION_KEY_INVALID')
  return value
}

export class ConsistencyExemptionRepository {
  static list(db = getProjectDb()): ConsistencyExemption[] {
    if (!db) return []
    const rows = db.prepare(`
      SELECT stable_fact_key AS stableFactKey, reason, revoked, chapter_number AS chapterNumber
      FROM consistency_exemptions ORDER BY stable_fact_key, chapter_number
    `).all() as Array<{ stableFactKey: string; reason: string; revoked: number; chapterNumber: number | null }>
    return rows.map(row => ({ ...row, revoked: row.revoked === 1 }))
  }

  static save(stableFactKey: string, reason: string, chapterNumber: number | null = null): void {
    const db = getProjectDb()
    if (!db) throw new Error('PROJECT_NOT_OPEN')
    const target = chapterNumber === null ? '(stable_fact_key) WHERE chapter_number IS NULL' : '(stable_fact_key, chapter_number)'
    db.prepare(`
      INSERT INTO consistency_exemptions (stable_fact_key, chapter_number, reason, revoked)
      VALUES (?, ?, ?, 0)
      ON CONFLICT${target} DO UPDATE SET reason = excluded.reason, revoked = 0
    `).run(requireText(stableFactKey, 'CONSISTENCY_EXEMPTION_KEY_INVALID'), requireChapter(chapterNumber), requireText(reason, 'CONSISTENCY_EXEMPTION_REASON_INVALID'))
  }

  static revoke(stableFactKey: string, chapterNumber: number | null = null): void {
    const db = getProjectDb()
    if (!db) throw new Error('PROJECT_NOT_OPEN')
    db.prepare('UPDATE consistency_exemptions SET revoked = 1 WHERE stable_fact_key = ? AND chapter_number IS ?')
      .run(requireText(stableFactKey, 'CONSISTENCY_EXEMPTION_KEY_INVALID'), requireChapter(chapterNumber))
  }
}
