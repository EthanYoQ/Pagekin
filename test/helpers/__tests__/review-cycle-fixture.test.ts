import { describe, expect, it } from 'vitest'
import { verifyM03ReviewCycle } from '../../../electron/migrations/m03-review-cycle'
import { ReviewCycleRepository } from '../../../electron/repositories/review-cycle-repository'
import { attachStatementLedger, defaultGoals, generatedCycle, reviewCycleDatabase, seedReviewedBook } from '../review-cycle-fixture'

describe('语句账本', () => {
  it('报出的语句与次数和手数一致', () => {
    const db = reviewCycleDatabase()
    const ledger = attachStatementLedger(db)
    const insert = db.prepare('INSERT INTO contents(body) VALUES(?)')
    db.transaction(() => { insert.run('甲'); insert.run('乙') })()
    expect(db.prepare('SELECT body FROM contents WHERE body=?').pluck().get('乙')).toBe('乙')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.exec("DELETE FROM contents WHERE body IN ('甲','乙')")
    expect(Object.fromEntries(ledger.counts)).toEqual({
      'INSERT INTO contents(body) VALUES(?)': 2,
      'SELECT body FROM contents WHERE body=?': 1,
      'PRAGMA foreign_keys': 1,
      "DELETE FROM contents WHERE body IN ('甲','乙')": 1,
    })
    expect(ledger.total()).toBe(5)

    ledger.reset()
    expect(ReviewCycleRepository.getByReviewId(999, db)).toBeNull()
    expect(ledger.total()).toBe(1)

    const retained = db.prepare('SELECT 2')
    ledger.detach()
    db.prepare('SELECT 1').get()
    retained.get()
    expect(ledger.total()).toBe(1)
  })
})

describe('seedReviewedBook', () => {
  it('造出 K 章已合并的审修循环，且全书校验通过', () => {
    const db = reviewCycleDatabase()
    const book = seedReviewedBook(db, 3)
    expect(book.map(item => item.seeded.chapterNumber)).toEqual([1, 2, 3])
    expect(db.prepare("SELECT COUNT(*) FROM review_cycles WHERE revision_status='merge-committed'").pluck().get()).toBe(3)
    expect(db.prepare('SELECT COUNT(*) FROM review_cycle_merges').pluck().get()).toBe(3)
    expect(db.prepare('SELECT DISTINCT source_draft_chapter_number FROM reviews ORDER BY 1').pluck().all()).toEqual([1, 2, 3])
    expect(verifyM03ReviewCycle(db)).toBe(true)
  })
})

describe('generatedCycle', () => {
  it('复用同一稿时沿用那一稿的章号', () => {
    const db = reviewCycleDatabase()
    const first = generatedCycle(db, 'first', undefined, { chapterNumber: 2, frozenGoals: { ...defaultGoals, chapterNumber: 2 } })
    const second = generatedCycle(db, 'second', first.seeded, { frozenGoals: { ...defaultGoals, chapterNumber: 2 } })
    expect(second.seeded.chapterNumber).toBe(2)
    expect(db.prepare('SELECT source_draft_chapter_number FROM reviews WHERE id=?').pluck().get(second.seeded.reviewId)).toBe(2)
  })
})
