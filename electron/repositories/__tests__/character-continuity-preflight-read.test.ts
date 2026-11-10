import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findBlueprintContinuityRisks, type BlueprintForPreflight } from '../../../src/shared/consistency-preflight'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { closeProjectDatabase, getProjectDb } from '../../database'
import { insertCharacterRelationship, readContinuityNodesWithCurrentNames } from '../character-continuity-repository'
import { ConsistencyExemptionRepository } from '../consistency-exemption-repository'

let projectRoot = ''

function addCharacter(id: string, name: string): void {
  getProjectDb()!.prepare('INSERT INTO characters(name,character_id) VALUES(?,?)').run(name, id)
}

function addRelation(relation: string, effectiveChapter: number): void {
  const db = getProjectDb()!
  db.prepare("INSERT INTO character_identity_approvals VALUES(?,'h','{}')").run(`op-${relation}`)
  db.transaction(() => insertCharacterRelationship(db, {
    relationshipId: `line-${relation}`, sourceId: 'a', sourceName: '林晚', targetId: 'b', targetName: '沈舟', relation, provenanceJson: '{}',
  }, { operationId: `op-${relation}`, action: 'author-edit' }, effectiveChapter))()
}

const plan = (chapterNumber: number, from = '林晚'): BlueprintForPreflight => ({
  chapterNumber, title: '', role: '', purpose: '', keyEvents: '', characters: [from, '沈舟'], suspenseHook: '', userGuidance: '', notes: '',
  relationshipHints: [{ from, to: '沈舟', relation: '亲密同伴' }],
})

const check = (chapter: number, from?: string) => findBlueprintContinuityRisks(
  [], plan(chapter, from), ConsistencyExemptionRepository.list(), readContinuityNodesWithCurrentNames(getProjectDb()!))

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-continuity-preflight-'))
  initProjectDatabase(projectRoot)
  addCharacter('a', '林晚')
  addCharacter('b', '沈舟')
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('真实库里的关系节点进预检', () => {
  it('第 8 章起决裂：第 12 章提示并写明章号和原文，第 7 章不提示', () => {
    addRelation('决裂', 8)
    expect(check(12)).toMatchObject([{ sourceChapter: 8, evidence: '决裂' }])
    expect(check(7)).toEqual([])
  })

  it('没有节点的旧项目不提示', () => {
    expect(readContinuityNodesWithCurrentNames(getProjectDb()!)).toEqual([])
    expect(check(12)).toEqual([])
  })

  it('改名后按现在的名字对上，蓝图还写旧名就不报', () => {
    addRelation('决裂', 8)
    getProjectDb()!.prepare("UPDATE characters SET name='林晚晴' WHERE character_id='a'").run()
    expect(check(12, '林晚晴')).toHaveLength(1)
    expect(check(12, '林晚')).toEqual([])
  })

  it('按章豁免只管那一章，撤销后恢复；全书豁免各章都不提示', () => {
    addRelation('决裂', 8)
    const key = check(12)[0]!.stableFactKey
    ConsistencyExemptionRepository.save(key, '作者确认是有意安排', 12)
    expect(check(12)).toEqual([])
    expect(check(13)).toHaveLength(1)
    ConsistencyExemptionRepository.revoke(key, 12)
    expect(check(12)).toHaveLength(1)
    ConsistencyExemptionRepository.save(key, '全书如此')
    expect(check(12)).toEqual([])
    expect(check(30)).toEqual([])
  })
})
