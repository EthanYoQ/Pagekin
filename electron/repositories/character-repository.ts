/**
 * CharacterRepository — 角色卡 (characters 表)
 *
 * currentState 子结构已拍平为 cs_* 前缀列，杜绝 JSON 大字段。
 */
import { getProjectDb } from '../database'
import type Database from 'better-sqlite3'
export function hasCharacterIdentitySchema(db: Database.Database): boolean {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='character_identity_meta'").get())
}
import {
    normalizeCharacterRole,
    type CharacterRole,
} from '../../src/shared/character-role'
import type {
    CharacterRosterCharacterState,
    CharacterStateFieldProvenance,
    CharacterStateTextField,
} from '../../src/shared/character-roster'

/** 角色卡动态状态 */
export type CharacterStateData = CharacterRosterCharacterState

function parseProvenance(value: unknown): Partial<Record<CharacterStateTextField, CharacterStateFieldProvenance>> {
    if (typeof value !== 'string' || !value.trim()) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Partial<Record<CharacterStateTextField, CharacterStateFieldProvenance>>
            : {}
    } catch {
        return {}
    }
}

/** 角色卡完整数据（前端驼峰接口） */
export interface CharacterData {
    characterId?: string
    name: string
    role: CharacterRole
    gender: string
    age: string
    appearance: string
    personality: string
    background: string
    abilities: string
    motivation: string
    relationships: string
    arc: string
    notes: string
    currentState?: CharacterStateData
}

export interface CharacterRenameData {
    characterId?: string
    originalName: string
    newName: string
}

function rowToData(row: Record<string, unknown>): CharacterData {
    const data: CharacterData = {
        ...(typeof row.character_id === 'string' ? { characterId: row.character_id } : {}),
        name: row.name as string,
        role: normalizeCharacterRole(row.role),
        gender: (row.gender as string) || '',
        age: (row.age as string) || '',
        appearance: (row.appearance as string) || '',
        personality: (row.personality as string) || '',
        background: (row.background as string) || '',
        abilities: (row.abilities as string) || '',
        motivation: (row.motivation as string) || '',
        relationships: (row.relationships as string) || '',
        arc: (row.arc as string) || '',
        notes: (row.notes as string) || '',
    }

    // currentState 存在与否由列是否为 NULL 决定（chapter 0 为合法状态）
    const updatedChapter = row.cs_updated_at_chapter as number | null
    if (updatedChapter !== null && updatedChapter !== undefined) {
        const provenance = parseProvenance(row.cs_provenance)
        data.currentState = {
            location: (row.cs_location as string) || '',
            powerLevel: (row.cs_power_level as string) || '',
            physicalState: (row.cs_physical_state as string) || '',
            mentalState: (row.cs_mental_state as string) || '',
            keyItems: (row.cs_key_items as string) || '',
            recentEvents: (row.cs_recent_events as string) || '',
            updatedAtChapter: updatedChapter,
            // Pre-provenance ready rosters hashed the state without this key.
            // Keep an empty migrated column serialized in that legacy shape.
            ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
        }
    }

    return data
}

export class CharacterRepository {
    static getById(characterId: string): CharacterData | null {
        const db = getProjectDb()
        if (!db) return null
        const row = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(characterId) as Record<string, unknown> | undefined
        return row ? rowToData(row) : null
    }

    /** 获取所有角色（按角色定位排序：主角→配角→反派→龙套） */
    static getAll(capturedDatabase?: import('better-sqlite3').Database): CharacterData[] {
        const db = capturedDatabase ?? getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      SELECT * FROM characters
      ${hasCharacterIdentitySchema(db) ? 'WHERE retired=0' : ''}
      ORDER BY
        CASE role
          WHEN 'protagonist' THEN 0
          WHEN 'supporting' THEN 1
          WHEN 'antagonist' THEN 2
          WHEN 'minor' THEN 3
          ELSE 9
        END ASC
    `).all() as Record<string, unknown>[]

        return rows.map(rowToData)
    }

    /** 获取单个角色 */
    static getByName(name: string, sourceKey?: string): CharacterData | null {
        const db = getProjectDb()
        if (!db) return null

        if (hasCharacterIdentitySchema(db)) {
            if (!sourceKey) return null
            const rows = db.prepare('SELECT c.* FROM characters c JOIN character_aliases a ON a.character_id=c.character_id WHERE a.name=? AND a.source_key=? AND a.valid_through IS NULL AND c.retired=0').all(name, sourceKey) as Record<string, unknown>[]
            return rows.length === 1 ? rowToData(rows[0]) : null
        }
        const row = db.prepare(
            'SELECT * FROM characters WHERE name = ?'
        ).get(name) as Record<string, unknown> | undefined

        return row ? rowToData(row) : null
    }

    /** 获取角色数量 */
    static count(): number {
        const db = getProjectDb()
        if (!db) return 0

        const row = db.prepare(
            'SELECT COUNT(*) as cnt FROM characters'
        ).get() as { cnt: number }

        return row.cnt
    }
}
