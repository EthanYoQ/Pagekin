import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { createLiveRowViews } from '../../../test/helpers/live-row-views'
import { CharacterRosterRepository, renderCharacterRosterMarkdown, validateLegacyRosterCandidate } from '../character-roster-repository'
import { ensureCharacterRosterSchema } from '../character-roster-schema'
import type { CharacterRosterEntry } from '../../../src/shared/character-roster'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database

function rosterEntries(): CharacterRosterEntry[] {
  return [
    {
      name: '林舟',
      role: 'protagonist',
      gender: '男',
      age: '十八岁',
      appearance: '灰袍少年',
      personality: '克制',
      background: '铁砧镇学徒',
      abilities: '锻造',
      motivation: '守住家人',
      relationships: [{ target: '苏绾', relation: '师徒' }],
      arc: '从学徒成长为守护者',
      notes: '左手有旧伤',
    },
    {
      name: '苏绾',
      role: 'supporting',
      gender: '女',
      age: '二十六岁',
      appearance: '青衣剑客',
      personality: '冷静',
      background: '游侠',
      abilities: '剑术',
      motivation: '偿还旧债',
      relationships: [{ target: '林舟', relation: '师徒' }],
      arc: '学会托付',
      notes: '',
    },
  ]
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE project_core (
      id TEXT PRIMARY KEY,
      writing_language TEXT NOT NULL DEFAULT 'zh-CN',
      characters_arch TEXT DEFAULT ''
    );
    INSERT INTO project_core (id, characters_arch) VALUES ('main', '');
    CREATE TABLE characters (
      name TEXT PRIMARY KEY,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      background TEXT DEFAULT '',
      abilities TEXT DEFAULT '',
      motivation TEXT DEFAULT '',
      relationships TEXT DEFAULT '',
      arc TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      cs_location TEXT DEFAULT '',
      cs_power_level TEXT DEFAULT '',
      cs_physical_state TEXT DEFAULT '',
      cs_mental_state TEXT DEFAULT '',
      cs_key_items TEXT DEFAULT '',
      cs_recent_events TEXT DEFAULT '',
      cs_updated_at_chapter INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE blueprints (
      chapter_number INTEGER PRIMARY KEY,
      characters TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY,
      chapter_number INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE finalization_outbox (
      finalization_id TEXT PRIMARY KEY,
      draft_id INTEGER NOT NULL UNIQUE,
      chapter_number INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    );
  `)
  ensureCharacterRosterSchema(db)
  createLiveRowViews(db)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => {
  db.close()
})


const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function seedReadyLegacyRoster(entries: CharacterRosterEntry[]): void {
  const insert = db.prepare(`
    INSERT INTO characters (
      name, role, gender, age, appearance, personality, background, abilities, motivation, relationships, arc, notes,
      cs_location, cs_power_level, cs_physical_state, cs_mental_state, cs_key_items, cs_recent_events, cs_updated_at_chapter, cs_provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const entry of entries) {
    const state = entry.currentState
    insert.run(entry.name, entry.role, entry.gender, entry.age, entry.appearance, entry.personality, entry.background,
      entry.abilities, entry.motivation, JSON.stringify(entry.relationships), entry.arc, entry.notes,
      state?.location ?? '', state?.powerLevel ?? '', state?.physicalState ?? '', state?.mentalState ?? '',
      state?.keyItems ?? '', state?.recentEvents ?? '', state?.updatedAtChapter ?? null, JSON.stringify(state?.provenance ?? {}))
  }
  const stored = CharacterRosterRepository.read().entries
  const projection = renderCharacterRosterMarkdown(stored)
  const byName = [...stored].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  db.prepare("UPDATE project_core SET characters_arch = ? WHERE id = 'main'").run(projection)
  db.prepare(`
    UPDATE character_roster_meta
    SET revision = 1, migration_state = 'ready', projection_hash = ?, fact_hash = ?
    WHERE id = 'main'
  `).run(sha256(projection), sha256(JSON.stringify(byName)))
}

describe('CharacterRosterRepository legacy read', () => {
  it('keeps a pre-provenance ready roster ready after adding the empty provenance column', () => {
    const [first, second] = rosterEntries()
    seedReadyLegacyRoster([{
      ...first,
      currentState: {
        location: '旧港口',
        powerLevel: '学徒',
        physicalState: '轻伤',
        mentalState: '警觉',
        keyItems: '旧剑',
        recentEvents: '刚抵达港口',
        updatedAtChapter: 1,
      },
    }, second])
    db.exec('ALTER TABLE characters DROP COLUMN cs_provenance')

    ensureCharacterRosterSchema(db)

    const upgraded = CharacterRosterRepository.read()
    expect(upgraded.status).toBe('ready')
    expect(upgraded.entries.find(entry => entry.name === '林舟')?.currentState).toMatchObject({ location: '旧港口' })
    expect(upgraded.entries[0]?.currentState).not.toHaveProperty('provenance')
  })

  it('keeps the persisted name-only factHash for a project without the identity schema', () => {
    seedReadyLegacyRoster(rosterEntries())
    const persisted = db.prepare("SELECT fact_hash FROM character_roster_meta WHERE id = 'main'").pluck().get()

    expect(CharacterRosterRepository.read()).toMatchObject({ status: 'ready', factHash: persisted, nameOnlyFactHash: persisted })
  })

  it('keeps a historical Chinese projection readable after a project switches to English', () => {
    seedReadyLegacyRoster(rosterEntries())
    const historical = CharacterRosterRepository.read()
    db.prepare("UPDATE project_core SET writing_language = 'en-US' WHERE id = 'main'").run()

    expect(CharacterRosterRepository.read()).toMatchObject({
      status: 'ready',
      renderedMarkdown: historical.renderedMarkdown,
      projectionHash: historical.projectionHash,
    })
    expect(historical.renderedMarkdown).toContain('# 角色图谱')
  })

  it('renders the canonical shared minor-role label in the deterministic roster projection', () => {
    const markdown = renderCharacterRosterMarkdown(rosterEntries().map(entry => (
      entry.name === '苏绾' ? { ...entry, role: 'minor' as const } : entry
    )))

    expect(markdown).toContain('## 龙套：苏绾')
    expect(markdown).not.toContain('## 次要角色：苏绾')
  })

  it('renders an English project roster without Chinese projection labels', () => {
    const entries = rosterEntries().map(entry => ({
      ...entry,
      name: entry.name === '林舟' ? 'Lin Zhou' : 'Su Wan',
      gender: entry.gender === '男' ? 'male' : 'female',
      age: entry.age === '十八岁' ? '18' : '26',
      appearance: 'plain travel clothes',
      personality: 'calm',
      background: 'harbor investigator',
      abilities: 'investigation',
      motivation: 'find the truth',
      relationships: [{
        target: entry.name === '林舟' ? 'Su Wan' : 'Lin Zhou',
        relation: 'trusted colleague',
      }],
      arc: 'learns to trust others',
      notes: '',
    }))
    const markdown = renderCharacterRosterMarkdown(entries, 'en-US')

    expect(markdown).toBe([
      '# Character graph',
      '',
      '## Protagonist: Lin Zhou',
      '- Gender: male',
      '- Age: 18',
      '- Appearance: plain travel clothes',
      '- Personality: calm',
      '- Background: harbor investigator',
      '- Abilities: investigation',
      '- Motivation: find the truth',
      '- Arc: learns to trust others',
      '- Relationship: Su Wan (trusted colleague)',
      '',
      '## Supporting character: Su Wan',
      '- Gender: female',
      '- Age: 26',
      '- Appearance: plain travel clothes',
      '- Personality: calm',
      '- Background: harbor investigator',
      '- Abilities: investigation',
      '- Motivation: find the truth',
      '- Arc: learns to trust others',
      '- Relationship: Lin Zhou (trusted colleague)',
    ].join('\n'))
    expect(markdown).not.toMatch(/[㐀-鿿]/u)

    const extraRoles = renderCharacterRosterMarkdown([
      ...entries,
      { ...entries[1], name: 'Rowan Vale', role: 'antagonist' as const, relationships: [] },
      { ...entries[1], name: 'Harbor Clerk', role: 'minor' as const, relationships: [] },
    ], 'en-US')
    expect(extraRoles).toContain('## Antagonist: Rowan Vale')
    expect(extraRoles).toContain('## Minor character: Harbor Clerk')
  })

  it('normalizes a finite numeric model age in legacy candidates without widening other roster fields', () => {
    const [first, second] = rosterEntries()
    expect(validateLegacyRosterCandidate({ schemaVersion: 1, entries: [{ ...first, age: 18 }, second] })[0]?.age).toBe('18')

    for (const invalidAge of [Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
      expect(() => validateLegacyRosterCandidate({ schemaVersion: 1, entries: [{ ...first, age: invalidAge }, second] }))
        .toThrow('CHARACTER_ROSTER_TEXT_INVALID')
    }
    expect(() => validateLegacyRosterCandidate({ schemaVersion: 1, entries: [{ ...first, name: 7 }, second] }))
      .toThrow('CHARACTER_ROSTER_TEXT_INVALID')
  })

  it('rejects legacy candidates with an unsupported schema, duplicate identity, invalid role or self relation', () => {
    const [first, second] = rosterEntries()
    const invalidCandidates: Array<{ candidate: unknown; error: string }> = [
      { candidate: { schemaVersion: 2, entries: [first, second] }, error: 'CHARACTER_ROSTER_SCHEMA_UNSUPPORTED' },
      { candidate: { schemaVersion: 1, entries: [first, { ...second, name: '林舟', relationships: [] }] }, error: 'CHARACTER_ROSTER_NAME_DUPLICATE' },
      { candidate: { schemaVersion: 1, entries: [{ ...first, role: 'villain' }] }, error: 'CHARACTER_ROSTER_ROLE_INVALID' },
      { candidate: { schemaVersion: 1, entries: [{ ...first, relationships: [{ target: '林舟', relation: '镜像' }] }] }, error: 'CHARACTER_ROSTER_RELATIONSHIP_SELF' },
    ]

    for (const { candidate, error } of invalidCandidates) {
      expect(() => validateLegacyRosterCandidate(candidate)).toThrow(error)
    }
  })

  it('validates legacy roster candidates as a closed cast without free-text relationships', () => {
    expect(validateLegacyRosterCandidate({ schemaVersion: 1, entries: rosterEntries() }).map(entry => entry.name))
      .toEqual(['林舟', '苏绾'])
    expect(() => validateLegacyRosterCandidate({ schemaVersion: 1, entries: [{
      ...rosterEntries()[0], relationships: [{ target: '不存在的角色', relation: '敌对' }],
    }] })).toThrow('CHARACTER_ROSTER_RELATIONSHIP_TARGET_UNKNOWN')
    expect(() => validateLegacyRosterCandidate({ schemaVersion: 1, entries: [{
      ...rosterEntries()[0], relationships: [], legacyRelationshipNotes: '自由文本',
    }] })).toThrow('CHARACTER_ROSTER_FREE_RELATIONSHIPS_FORBIDDEN')
    expect(() => validateLegacyRosterCandidate({ schemaVersion: 1, entries: [] }))
      .toThrow('CHARACTER_ROSTER_ENTRIES_REQUIRED')
  })

  it('archives legacy Markdown as migration evidence instead of parsing it as a roster', () => {
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core
      SET characters_arch = '## 主角：这段旧文本不能自动成为事实';
    `)
    ensureCharacterRosterSchema(db)

    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'legacy_markdown_pending',
      status: 'legacy_repair_required',
      entries: [],
      renderedMarkdown: '',
      legacyMarkdown: '## 主角：这段旧文本不能自动成为事实',
    })
  })

  it('classifies empty, existing-card, partial-card and damaged legacy projects without auto-writing', () => {
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'empty',
      status: 'empty',
      entries: [],
    })

    db.prepare("INSERT INTO characters (name, role, notes) VALUES ('已有角色', 'supporting', '用户已手工填写')").run()
    // #83 之前旧编辑入口还会直接写 characters；读取只把它当受保护事实，
    // 不触发任何 Markdown 解析或覆盖。
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'empty',
      status: 'inconsistent',
      entries: [expect.objectContaining({ name: '已有角色' })],
    })

    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core SET characters_arch = '旧图谱存在，但此前只保存了一张手工角色卡。';
    `)
    ensureCharacterRosterSchema(db)
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'legacy_cards_preserved',
      status: 'inconsistent',
      entries: [expect.objectContaining({ name: '已有角色', notes: '用户已手工填写' })],
    })

    // 将元数据刻意置为“待修复”而数据库已有卡，代表损坏/不一致状态。
    db.prepare("UPDATE character_roster_meta SET migration_state = 'legacy_markdown_pending'").run()
    expect(CharacterRosterRepository.read()).toMatchObject({ status: 'inconsistent' })
  })
})
