import type Database from 'better-sqlite3'
import { continuityCheckChapter, type ContinuityCheckChapter } from '../../src/shared/blueprint-continuity-check'
import {
  BLUEPRINT_PATCH_FIELDS, type BlueprintPatch, type ContinuitySuggestResult, type SuggestionDecision, type SuggestionStatus,
} from '../../src/shared/blueprint-continuity-suggest'
import { BlueprintRepository } from './blueprint-repository'
import { textHash } from './generation-run-repository'

const chapterHash = (chapter: ContinuityCheckChapter) => textHash(JSON.stringify(chapter))
const runPrefix = (runId: string) => `${runId}:`

export function patchedFields(chapter: ContinuityCheckChapter, patch: BlueprintPatch): BlueprintPatch {
  return Object.fromEntries(BLUEPRINT_PATCH_FIELDS.filter(field => patch[field] !== undefined).map(field => [field, chapter[field]]))
}

/** 建议表没有运行号列：suggestion_id 取「运行号:章号」，同一次检查重放时只补缺的行，作者处理过的行不会被改回。 */
export class BlueprintSuggestionRepository {
  static materialize(db: Database.Database, finalizationId: string, runId: string, chapters: readonly ContinuityCheckChapter[],
    result: ContinuitySuggestResult): Map<number, SuggestionStatus> {
    return db.transaction(() => {
      const statuses = new Map<number, SuggestionStatus>()
      if (!db.prepare('SELECT 1 FROM finalization_outbox_all WHERE finalization_id=?').get(finalizationId)) return statuses
      const insert = db.prepare(`INSERT OR IGNORE INTO blueprint_continuity_suggestions
        (suggestion_id,finalization_id,chapter_number,base_blueprint_hash,patch_json,evidence_event_ids) VALUES(?,?,?,?,?,?)`)
      for (const suggestion of result.suggestions) {
        const chapter = chapters.find(item => item.chapterNumber === suggestion.chapterNumber)!
        insert.run(`${runPrefix(runId)}${suggestion.chapterNumber}`, finalizationId, suggestion.chapterNumber, chapterHash(chapter),
          JSON.stringify(suggestion.patch), JSON.stringify(suggestion.eventIds))
      }
      db.prepare(`UPDATE blueprint_continuity_suggestions SET status='stale',decided_at=datetime('now')
        WHERE finalization_id=? AND status='pending' AND substr(suggestion_id,1,?)<>?`).run(finalizationId, runPrefix(runId).length, runPrefix(runId))
      const rows = db.prepare('SELECT chapter_number AS chapterNumber,status FROM blueprint_continuity_suggestions WHERE substr(suggestion_id,1,?)=?')
        .all(runPrefix(runId).length, runPrefix(runId)) as { chapterNumber: number; status: SuggestionStatus }[]
      for (const row of rows) statuses.set(row.chapterNumber, row.status)
      return statuses
    }).immediate()
  }

  /** 接受时这一章必须还是检查时那份蓝图，否则这条作废；作废和接受都在同一个事务里落定。 */
  static decide(db: Database.Database, suggestionId: string, decision: SuggestionDecision): { status: SuggestionStatus } {
    return db.transaction(() => {
      const row = db.prepare('SELECT chapter_number AS chapterNumber,base_blueprint_hash AS baseHash,patch_json AS patch,status FROM blueprint_continuity_suggestions WHERE suggestion_id=?')
        .get(suggestionId) as { chapterNumber: number; baseHash: string; patch: string; status: SuggestionStatus } | undefined
      if (!row) throw new Error('GENERATION_GRAPH_SELECTION_INVALID')
      if (row.status !== 'pending') return { status: row.status }
      const close = (status: SuggestionStatus, receipt: object) => {
        db.prepare("UPDATE blueprint_continuity_suggestions SET status=?,decided_at=datetime('now'),decision_receipt_json=? WHERE suggestion_id=?")
          .run(status, JSON.stringify(receipt), suggestionId)
        return { status }
      }
      if (decision === 'reject') return close('rejected', {})
      const current = BlueprintRepository.getAll(db).find(blueprint => blueprint.chapterNumber === row.chapterNumber)
      const finalized = db.prepare("SELECT 1 FROM drafts WHERE chapter_number=? AND status='finalized'").get(row.chapterNumber)
      if (!current || finalized || chapterHash(continuityCheckChapter(current)) !== row.baseHash) return close('stale', {})
      const patch = JSON.parse(row.patch) as BlueprintPatch
      BlueprintRepository.upsert({ ...current, ...patch }, db)
      return close('accepted', { before: patchedFields(continuityCheckChapter(current), patch), after: patch })
    }).immediate()
  }
}
