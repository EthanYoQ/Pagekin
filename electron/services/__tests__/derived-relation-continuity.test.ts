import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getCurrentProjectPath, getProjectDb, initProjectDatabase } from '../../database'
import { registerDatabaseController } from '../../controllers/db-controller'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { appendDerivedRelationNode, deleteCharacterRelationship, insertCharacterRelationship, readCharacterContinuityNodes, readCharacterContinuityTimeline } from '../../repositories/character-continuity-repository'
import { commitCharacterIdentities, refreshCharacterIdentityProjection } from '../../repositories/character-roster-repository'
import { ConsistencyExemptionRepository } from '../../repositories/consistency-exemption-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { invalidateContinuityProjectionFrom, SummaryRepository } from '../../repositories/summary-repository'
import { captureFinalizationGenerationContext, finalizationGenerationTask } from '../finalization-generation-source'
import { captureReviewRevisionContext } from '../review-revision-context'
import { projectAccess } from '../project-access'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { characterTimeline, latestNodesBefore, type CharacterRelationNode, type ContinuityNode } from '../../../src/shared/character-continuity'
import { characterTimelinePromptLines } from '../../../src/shared/character-timeline-prompt'
import { findBlueprintContinuityRisks, type BlueprintForPreflight } from '../../../src/shared/consistency-preflight'
import { parseFinalizedCharacterStateResponse, type FinalizedCharacterContext } from '../../../src/shared/finalized-continuity'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'
import { buildProjectTemplate, createProjectFromTemplate, removeProjectTemplate } from './project-template-fixture'

type IpcHandler = (...args: unknown[]) => unknown
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ app: { getLocale: () => 'zh-CN', getPath: () => '' }, ipcMain: { handle: (channel: string, handler: IpcHandler) => ipcHandlers.set(channel, handler) } }))

function continuityNodesHandler(): IpcHandler {
  if (!ipcHandlers.size) registerDatabaseController()
  vi.spyOn(projectAccess, 'assertCurrentProjectContext').mockReturnValue({} as never)
  return ipcHandlers.get('db:character-continuity-nodes')!
}

const roots: string[] = []
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const LIN = '66666666-6666-4666-8666-666666666666'
const SHEN = '77777777-7777-4777-8777-777777777777'
const PROJECT_ID = randomUUID()
const scope = { projectId: PROJECT_ID, epoch: 'session' }
const db = () => getProjectDb()!

const BREAK_UP = '林岚当众折断师门信物，与沈砚恩断义绝。'
const CHAPTER_EIGHT = `第八章：雨夜。${BREAK_UP}`

beforeAll(buildProjectTemplate)
afterAll(removeProjectTemplate)

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) await removeDirectoryWithWindowsRetry(root)
})

function openProject(): void {
  const root = createProjectFromTemplate('derived-relation-', PROJECT_ID)
  roots.push(root)
  initProjectDatabase(root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  db().prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','关系','zh-CN')").run()
  const insert = db().prepare(`INSERT INTO characters(character_id,static_provenance,identity_revision,retired,name,role)
    VALUES(?,'{"kind":"author"}',0,0,?,'protagonist')`)
  insert.run(LIN, '林岚')
  insert.run(SHEN, '沈砚')
  db().transaction(() => refreshCharacterIdentityProjection(db()))()
}

const NAMES: Record<string, string> = { [LIN]: '林岚', [SHEN]: '沈砚' }

function authorRelation(relation: string, sourceId = LIN, targetId = SHEN): void {
  db().transaction(() => {
    db().prepare("INSERT OR IGNORE INTO character_identity_approvals VALUES('seed-approval','hash','{}')").run()
    insertCharacterRelationship(db(), { relationshipId: sourceId === LIN ? 'author-line' : 'reverse-line', sourceId, sourceName: NAMES[sourceId], targetId, targetName: NAMES[targetId],
      relation, provenanceJson: '{"kind":"author"}' }, { operationId: 'seed-approval', action: 'author-edit' }, 1)
    refreshCharacterIdentityProjection(db())
  })()
}

function commitFinal(draftId: number, chapterNumber: number, body: string): void {
  db().prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapterNumber, `第${chapterNumber}章`)
  FinalizationRepository.commit({ finalizationId: `finalization-${randomUUID()}`, draftId, chapterNumber,
    chapterTitle: `第${chapterNumber}章`, content: body, contentHash: sha256(body), contentRevision: 1, targetFileName: `${chapterNumber}-${draftId}.md` })
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
  SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber, chapterNotes: `第${chapterNumber}章摘要`, facts: [],
    source: context.source, projectionGeneration: context.projectionGeneration }, db())
}

function finalizeNew(chapterNumber: number, body: string): number {
  const draftId = DraftRepository.create({ chapterNumber, source: 'write', content: body, wordCount: body.length })
  commitFinal(draftId, chapterNumber, body)
  return draftId
}

function finalizeWithoutNotes(chapterNumber: number, body: string): number {
  const draftId = DraftRepository.create({ chapterNumber, source: 'write', content: body, wordCount: body.length })
  db().prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapterNumber, `第${chapterNumber}章`)
  FinalizationRepository.commit({ finalizationId: `finalization-${randomUUID()}`, draftId, chapterNumber,
    chapterTitle: `第${chapterNumber}章`, content: body, contentHash: sha256(body), contentRevision: 1, targetFileName: `${chapterNumber}-${draftId}.md` })
  return draftId
}

function replaceFinal(chapterNumber: number, body: string): number {
  const opened = FinalizationRepository.reopen({ chapterNumber })
  if (!opened.success) throw new Error('reopen failed')
  DraftRepository.updateContent(opened.draftId, body, body.length)
  commitFinal(opened.draftId, chapterNumber, body)
  return opened.draftId
}

const relationChange = (relation: string, quote: string, source = LIN, target = SHEN) => ({ source, target, relation, evidence: { text: quote } })

function commitModelOutput(draftId: number, output: Record<string, unknown>) {
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
  return SummaryRepository.commitFinalizedCharacterStates(context, parseFinalizedCharacterStateResponse(JSON.stringify(output), context), db())
}

const relationNodes = () => readCharacterContinuityNodes(db()).filter((node): node is CharacterRelationNode => node.aspect === 'relation' && node.subjectId === LIN)
const derivedNodes = () => relationNodes().filter(node => node.provenance.kind === 'derived')
const authorRows = () => db().prepare('SELECT relation FROM character_relationships WHERE source_character_id=? AND target_character_id=?').pluck().all(LIN, SHEN)
const pending = () => SummaryRepository.listPendingFinalizedRelationCandidates(db())
const eventCount = () => db().prepare('SELECT COUNT(*) FROM character_continuity_events').pluck().get()

function reviseAuthorRelation(relation: string, sourceId = LIN, targetId = SHEN): void {
  db().transaction(() => {
    const rows = db().prepare('SELECT relationship_id AS id,source_character_id AS source,target_character_id AS target FROM character_relationships').all() as Array<{ id: string; source: string; target: string }>
    for (const row of rows) deleteCharacterRelationship(db(), { relationshipId: row.id, sourceId: row.source, sourceName: NAMES[row.source], targetId: row.target, targetName: NAMES[row.target] }, 'seed-approval')
    insertCharacterRelationship(db(), { relationshipId: `author-${randomUUID()}`, sourceId, sourceName: NAMES[sourceId], targetId, targetName: NAMES[targetId],
      relation, provenanceJson: '{"kind":"author"}' }, { operationId: 'seed-approval', action: 'author-edit' })
    refreshCharacterIdentityProjection(db())
  })()
}

function reviseAuthorRelationThroughRoster(relation: string): void {
  db().transaction(() => {
    const operationId = `author-edit-${randomUUID()}`
    const revision = db().prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get() as number
    const rows = db().prepare('SELECT relationship_id AS id,source_character_id AS source,target_character_id AS target FROM character_relationships').all() as Array<{ id: string; source: string; target: string }>
    for (const row of rows) deleteCharacterRelationship(db(), { relationshipId: row.id, sourceId: row.source, sourceName: NAMES[row.source], targetId: row.target, targetName: NAMES[row.target] }, operationId)
    commitCharacterIdentities(db(), { approval: { operationId, expectedRevision: revision, action: 'author-edit',
      source: { kind: 'author', source: { projectId: PROJECT_ID, epoch: scope.epoch, sourceId: operationId, revision, contentHash: sha256(relation) } } },
    changes: [], creations: [], retireIds: [], resolutions: [], relationships: [{ sourceCharacterId: LIN, targetCharacterId: SHEN, relation }] }, () => true)
    refreshCharacterIdentityProjection(db())
  })()
}

function saveNotes(draftId: number, chapterNotes: string): void {
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
  SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber: context.source.chapterNumber, chapterNotes, facts: [],
    source: context.source, projectionGeneration: context.projectionGeneration }, db())
}

const NOTES_REQUIRED = 'GENERATION_FINALIZATION_PREDECESSOR_REQUIRED'

function frozenSubmission(draftId: number, output: Record<string, unknown>) {
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
  return () => SummaryRepository.commitFinalizedCharacterStates(context, parseFinalizedCharacterStateResponse(JSON.stringify(output), context), db())
}

function decide(decision: 'accept' | 'decline') {
  const [candidate] = pending()
  return SummaryRepository.decideFinalizedRelationCandidate({ draftId: candidate.source.draftId, candidateKey: candidate.candidateKey,
    expectedAuthorRelations: candidate.authorRelations, operationId: `relation-${decision}-${candidate.candidateKey}`, decision }, scope, db())
}

describe('定稿后自动记录人物关系变化', () => {
  it('结果带关系变化时，时间线上出现该章节点，来源是定稿并带原文', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })

    const chapters = characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes)
    expect(chapters.map(item => item.chapter)).toEqual([8])
    expect(chapters[0].changes).toHaveLength(1)
    expect(chapters[0].changes[0]).toMatchObject({ source: 'finalized', value: '恩断义绝', node: { aspect: 'relation', targetId: SHEN, targetName: '沈砚', draftId, quote: { text: BREAK_UP } } })
  })

  it('用精确角色名也能对上，对方没有作者关系时只记节点不打扰作者', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP, '林岚', '沈砚')] })

    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])
    expect(pending()).toEqual([])
  })

  it('结果没有 relations 或 relations 畸形时，状态照常更新，不报错', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const update = { characterId: LIN, currentState: { recentEvents: '折断信物' }, evidence: { text: BREAK_UP } }

    expect(commitModelOutput(draftId, { updates: [update] })).toMatchObject({ applied: 1 })
    expect(commitModelOutput(draftId, { updates: [{ ...update, currentState: { recentEvents: '再折一次' } }], relations: '没有变化' })).toMatchObject({ applied: 1 })
    expect(commitModelOutput(draftId, { updates: [{ ...update, currentState: { recentEvents: '第三次' } }], relations: [null, 3, { source: LIN }] })).toMatchObject({ applied: 1 })
    expect(derivedNodes()).toEqual([])
  })

  it('对不上角色、没有原文、原文不在正文、关系为空或指向自己的条目不写，其余条目照写', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const receipt = commitModelOutput(draftId, { updates: [], relations: [
      relationChange('决裂', BREAK_UP, '无名路人', SHEN),
      relationChange('决裂', BREAK_UP, LIN, '不存在的人'),
      { source: LIN, target: SHEN, relation: '决裂' },
      relationChange('决裂', '这句话不在本章正文里'),
      relationChange('   ', BREAK_UP),
      relationChange('自省', BREAK_UP, LIN, LIN),
      relationChange('恩断义绝', BREAK_UP),
    ] })

    expect(receipt.applied).toBe(0)
    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])
  })

  it('和作者关系不一致时出现待确认项，派生节点不改写作者关系当前值', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })

    expect(authorRows()).toEqual(['师徒'])
    expect(pending()).toMatchObject([{ sourceId: LIN, sourceName: '林岚', targetId: SHEN, targetName: '沈砚', value: '恩断义绝',
      authorRelations: ['师徒'], evidence: { text: BREAK_UP }, source: { draftId, chapterNumber: 8 } }])
  })

  it('章节要点还没落库时角色那步被拒，状态和关系都不落库；要点落库后重新提交同一份结果，待确认项出现，也能采用', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const submit = frozenSubmission(draftId, { updates: [{ characterId: LIN, currentState: { recentEvents: '折断信物' }, evidence: { text: BREAK_UP } }],
      relations: [relationChange('恩断义绝', BREAK_UP)] })
    const before = eventCount()

    expect(submit).toThrow(NOTES_REQUIRED)
    expect(eventCount()).toBe(before)
    saveNotes(draftId, '第8章摘要')
    expect(pending()).toEqual([])

    expect(submit()).toMatchObject({ applied: 1 })
    expect(pending()).toMatchObject([{ sourceId: LIN, targetId: SHEN, value: '恩断义绝', authorRelations: ['师徒'], evidence: { text: BREAK_UP }, source: { draftId, chapterNumber: 8 } }])
    expect(decide('accept')).toMatchObject({ decision: 'accept', idempotent: false })
    expect(authorRows()).toEqual(['恩断义绝'])
  })

  it('新数据已有待确认项，投影代号变了再存要点：待确认项不被清掉', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    invalidateContinuityProjectionFrom(db(), 8)

    saveNotes(draftId, '第8章摘要又一版')
    expect(pending().map(card => card.value)).toEqual(['恩断义绝'])
  })

  it('角色那步被拒后作者改了关系：要点落库后重新提交同一份结果，旧建议不出现，作者的改动不被覆盖', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const submit = frozenSubmission(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(submit).toThrow(NOTES_REQUIRED)
    reviseAuthorRelation('同门')

    saveNotes(draftId, '第8章摘要')
    submit()

    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])
    expect(pending()).toEqual([])
    expect(authorRows()).toEqual(['同门'])
  })

  it('角色那步被拒后作者改了关系，要点落库前又重试了一次：仍然被拒，要点落库后重新提交，旧建议不出现', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const submit = frozenSubmission(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(submit).toThrow(NOTES_REQUIRED)
    reviseAuthorRelation('同门')
    expect(submit).toThrow(NOTES_REQUIRED)

    saveNotes(draftId, '第8章摘要')
    submit()

    expect(pending()).toEqual([])
  })

  it('抽取时作者还没写这对关系、之后才写：要点补上后不出现待确认项', () => {
    openProject()
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    authorRelation('师徒')

    saveNotes(draftId, '第8章摘要')

    expect(pending()).toEqual([])
  })

  it('角色那步被拒后作者调换关系方向：要点落库后重新提交同一份结果，不出现待确认项，方向不被翻回去', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const submit = frozenSubmission(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(submit).toThrow(NOTES_REQUIRED)
    reviseAuthorRelation('师徒', SHEN, LIN)

    saveNotes(draftId, '第8章摘要')
    submit()

    expect(pending()).toEqual([])
    expect(db().prepare('SELECT source_character_id AS source,target_character_id AS target,relation FROM character_relationships').all())
      .toEqual([{ source: SHEN, target: LIN, relation: '师徒' }])
  })

  it.each([
    ['先林后沈', [relationChange('恩断义绝', BREAK_UP), relationChange('势不两立', BREAK_UP, SHEN, LIN)]],
    ['先沈后林', [relationChange('势不两立', BREAK_UP, SHEN, LIN), relationChange('恩断义绝', BREAK_UP)]],
  ])('作者两个方向都写了，模型两个方向给出不同新值（%s）：角色那步被拒、要点落库后重新提交，同一对只有一张卡，与要点先到时一样', (_label, relations) => {
    const cardsAfter = (notesFirst: boolean) => {
      openProject()
      authorRelation('同门')
      authorRelation('同门', SHEN, LIN)
      const draftId = notesFirst ? finalizeNew(8, CHAPTER_EIGHT) : finalizeWithoutNotes(8, CHAPTER_EIGHT)
      const submit = frozenSubmission(draftId, { updates: [], relations })
      if (!notesFirst) {
        expect(submit).toThrow(NOTES_REQUIRED)
        saveNotes(draftId, '第8章摘要')
      }
      submit()
      const cards = pending().map(({ sourceId, targetId, value }) => ({ sourceId, targetId, value }))
      closeProjectDatabase()
      return cards
    }
    const notesFirst = cardsAfter(true)

    expect(notesFirst).toHaveLength(1)
    expect(cardsAfter(false)).toEqual(notesFirst)
  })

  it('作者两个方向都写了，重跑把一个方向改回作者设定：另一方向的旧值随同一对的卡一起撤下', () => {
    openProject()
    authorRelation('同门')
    authorRelation('同门', SHEN, LIN)
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP), relationChange('势不两立', BREAK_UP, SHEN, LIN)] })
    expect(pending()).toHaveLength(1)

    commitModelOutput(draftId, { updates: [], relations: [relationChange('同门', BREAK_UP)] })

    expect(pending()).toEqual([])
  })

  it('抽取开始后、提交前作者改了关系，要点还没落库：被拒，要点落库后重新提交，旧结论不对着作者新写的关系出现', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const submit = frozenSubmission(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    reviseAuthorRelation('同门')
    expect(submit).toThrow(NOTES_REQUIRED)

    saveNotes(draftId, '第8章摘要')
    submit()

    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])
    expect(pending()).toEqual([])
    expect(authorRows()).toEqual(['同门'])
  })

  it('要点已在时抽取期间作者改了关系：旧结论不对着作者新写的关系出现', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
    reviseAuthorRelation('同门')
    SummaryRepository.commitFinalizedCharacterStates(context, parseFinalizedCharacterStateResponse(JSON.stringify(
      { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] }), context), db())

    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])
    expect(pending()).toEqual([])
    expect(authorRows()).toEqual(['同门'])
  })

  it('要点已在时抽取期间作者改了关系，而定稿写的正是改之前的设定：不把旧设定当建议放出', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
    reviseAuthorRelation('同门')
    SummaryRepository.commitFinalizedCharacterStates(context, parseFinalizedCharacterStateResponse(JSON.stringify(
      { updates: [], relations: [relationChange('师徒', BREAK_UP)] }), context), db())

    expect(latestNodesBefore(relationNodes(), 9).relations.map(pair => [pair.conflict, pair.lines.map(line => [line.value, line.provenance.kind])])).toEqual([[false, [['同门', 'author']]]])
    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).flatMap(group => group.changes.map(change => change.source))).not.toContain('finalized')
    expect(pending()).toEqual([])
    expect(authorRows()).toEqual(['同门'])
  })

  it('升级前冻结的在途定稿没有作者关系快照，要点已在：记下节点但不放建议', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const context = { ...SummaryRepository.readFinalizedCharacterContext(draftId, scope, db()), authorRelations: undefined }
    SummaryRepository.commitFinalizedCharacterStates(context, parseFinalizedCharacterStateResponse(JSON.stringify(
      { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] }), context), db())

    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])
    expect(pending()).toEqual([])
  })

  it('升级前冻结的在途定稿没有作者关系快照：提交后要点补上时不补待确认项', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const context = { ...SummaryRepository.readFinalizedCharacterContext(draftId, scope, db()), authorRelations: undefined }
    SummaryRepository.commitFinalizedCharacterStates(context, parseFinalizedCharacterStateResponse(JSON.stringify(
      { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] }), context), db())
    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])

    expect(() => saveNotes(draftId, '第8章摘要')).not.toThrow()
    expect(pending()).toEqual([])
  })

  it('保留原设定后要点再存一次：待确认项不回来', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('decline')
    const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
    SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber: 8, chapterNotes: '第8章摘要又一版', facts: [],
      source: context.source, projectionGeneration: context.projectionGeneration }, db())
    expect(pending()).toEqual([])
    expect(authorRows()).toEqual(['师徒'])
  })

  it('作者自己改成建议值后重存要点，再改成别的再存：旧建议不回来', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(pending()).toHaveLength(1)

    reviseAuthorRelation('恩断义绝')
    saveNotes(draftId, '第8章摘要又一版')
    reviseAuthorRelation('同门')
    saveNotes(draftId, '第8章摘要第三版')

    expect(pending()).toEqual([])
  })

  it('作者调换关系方向后重存要点：时间线不多出事件', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    reviseAuthorRelation('师徒', SHEN, LIN)
    const before = eventCount()

    saveNotes(draftId, '第8章摘要又一版')

    expect(eventCount()).toBe(before)
    expect(readCharacterContinuityNodes(db()).filter(node => node.provenance.kind === 'derived')).toHaveLength(1)
    expect(pending()).toEqual([])
  })

  it('作者改成建议值后同一份定稿重跑，再改成别的并重存要点：旧建议不回来', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    reviseAuthorRelation('恩断义绝')
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    reviseAuthorRelation('同门')

    saveNotes(draftId, '第8章摘要又一版')

    expect(pending()).toEqual([])
  })

  it('只存要点、不改关系时时间线事件数不变', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    const before = eventCount()

    saveNotes(draftId, '第8章摘要又一版')

    expect(eventCount()).toBe(before)
    expect(pending()).toMatchObject([{ value: '恩断义绝', authorRelations: ['师徒'] }])
  })

  it('模型重述作者已有的关系不算变化：时间线没有这一章，生效的只有作者设定，也不提示', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('师徒', BREAK_UP)] })

    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).map(group => group.chapter)).toEqual([1])
    expect(latestNodesBefore(relationNodes(), 9).relations.flatMap(pair => pair.lines.map(line => line.provenance.kind))).toEqual(['author'])
    expect(pending()).toEqual([])
  })

  it('作者设定从第 8 章起生效，第 8 章定稿重述它：时间线这一章只有作者设定一行', () => {
    openProject()
    finalizeNew(7, '第七章：林岚独自下山。')
    db().prepare("INSERT OR IGNORE INTO character_identity_approvals VALUES('seed-approval','hash','{}')").run()
    reviseAuthorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('师徒', BREAK_UP)] })

    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).flatMap(group => group.changes.map(change => [group.chapter, change.source, change.value])))
      .toEqual([[8, 'author', '师徒']])
  })

  it('定稿改变关系后下一章又回到作者设定：记下恢复，不再和旧的派生值打架，也不提示', () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('decline')
    const reconciled = '沈砚扶起林岚，重新认她为徒。'
    commitModelOutput(finalizeNew(9, `第九章：${reconciled}`), { updates: [], relations: [relationChange('师徒', reconciled)] })

    expect(derivedNodes().map(node => [node.effectiveChapter, node.value]).sort()).toEqual([[8, '恩断义绝'], [9, '师徒']])
    expect(latestNodesBefore(relationNodes(), 10).relations[0]).toMatchObject({ conflict: false })
    expect(pending()).toEqual([])
  })

  it('作者写的关系超过 80 字，定稿回到它时照抄的原词照样记下；模型自己写的超长关系仍不记', () => {
    openProject()
    const long = `自幼在同一座山门下长大、${'一起走过风雨'.repeat(12)}的师徒`
    expect(long.length).toBeGreaterThan(80)
    authorRelation(long)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('decline')
    const reconciled = '沈砚扶起林岚，重新认她为徒。'
    commitModelOutput(finalizeNew(9, `第九章：${reconciled}`), { updates: [], relations: [relationChange(long, reconciled)] })
    const invented = '十章：两人反目。'
    commitModelOutput(finalizeNew(10, `第${invented}`), { updates: [], relations: [relationChange(`${long}之后又反目`, invented)] })

    expect(derivedNodes().map(node => [node.effectiveChapter, node.value, !!node.matchedAuthor]).sort()).toEqual([[8, '恩断义绝', false], [9, long, true]])
    expect(pending()).toEqual([])
  })

  it('作者设定盟友，第 5 章定稿写成仇敌，第 7 章定稿回到盟友：时间线记下第 7 章的和好', () => {
    openProject()
    authorRelation('盟友')
    commitModelOutput(finalizeNew(5, '第五章：林岚视沈砚为仇敌。'), { updates: [], relations: [relationChange('仇敌', '视沈砚为仇敌')] })
    commitModelOutput(finalizeNew(7, '第七章：两人重新结为盟友。'), { updates: [], relations: [relationChange('盟友', '重新结为盟友')] })

    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).flatMap(group => group.changes.map(change => [group.chapter, change.source, change.value])))
      .toEqual([[7, 'finalized', '盟友'], [5, 'finalized', '仇敌'], [1, 'author', '盟友']])
  })

  it('同一份定稿重跑后关系回到作者设定：这一章旧的待确认项撤下，别的章不受影响', () => {
    openProject()
    authorRelation('师徒')
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    const quote = '沈砚望着断裂的信物'
    const nine = finalizeNew(9, `第九章：${quote}，一言不发。`)
    commitModelOutput(nine, { updates: [], relations: [relationChange('反目', quote)] })
    expect(pending().map(item => item.value)).toEqual(['恩断义绝', '反目'])

    commitModelOutput(nine, { updates: [], relations: [relationChange('师徒', quote)] })
    expect(pending().map(item => item.value)).toEqual(['恩断义绝'])
  })

  it('采用后变成作者节点，自该章起生效，作者关系当前值随之更新', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('accept')

    expect(pending()).toEqual([])
    expect(authorRows()).toEqual(['恩断义绝'])
    const authored = (chapter: number) => latestNodesBefore(relationNodes(), chapter).relations
      .flatMap(pair => pair.lines.filter(line => line.provenance.kind !== 'derived').map(line => line.value))
    expect(authored(8)).toEqual(['恩断义绝'])
    expect(authored(7)).toEqual(['师徒'])
    expect(latestNodesBefore(relationNodes(), 9).relations[0].conflict).toBe(false)
  })

  it('保留原设定后不再出现，重跑同一份定稿也不再提示', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const output = { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] }
    commitModelOutput(draftId, output)
    decide('decline')

    expect(pending()).toEqual([])
    expect(authorRows()).toEqual(['师徒'])
    commitModelOutput(draftId, output)
    expect(pending()).toEqual([])
    expect(derivedNodes()).toHaveLength(1)
  })

  it('以后再说：不做决定时一直留在列表', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })

    expect(pending()).toHaveLength(1)
    expect(pending()).toHaveLength(1)
  })

  it('作者在决定前改过这对角色的关系时，建议作废，采用被拒绝，不覆盖作者的改动', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    const [candidate] = pending()
    db().prepare("UPDATE character_relationships SET relation='宿敌' WHERE relationship_id='author-line'").run()

    expect(pending()).toEqual([])
    expect(() => SummaryRepository.decideFinalizedRelationCandidate({ draftId, candidateKey: candidate.candidateKey,
      expectedAuthorRelations: candidate.authorRelations, operationId: 'late-accept', decision: 'accept' }, scope, db()))
      .toThrow('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
    expect(authorRows()).toEqual(['宿敌'])
  })

  it('重开并替换该章后，旧派生节点失效，待确认项消失，新定稿的节点生效', () => {
    openProject()
    authorRelation('师徒')
    const original = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(original, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(pending()).toHaveLength(1)

    const reconciled = '林岚跪在雨里，求沈砚重新收她为徒。'
    const replacement = replaceFinal(8, `第八章改：${reconciled}`)
    expect(derivedNodes()).toEqual([])
    expect(pending()).toEqual([])

    commitModelOutput(replacement, { updates: [], relations: [relationChange('求师门原谅', reconciled)] })
    expect(derivedNodes().map(node => [node.value, node.draftId, node.effectiveChapter])).toEqual([['求师门原谅', replacement, 8]])
    expect(pending().map(item => item.value)).toEqual(['求师门原谅'])
  })

  it('同一对角色后续章重述同样的派生关系不算变化：时间线没有这一章，也不提示', () => {
    openProject()
    authorRelation('师徒')
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('decline')
    const nine = finalizeNew(9, '第九章：沈砚望着断裂的信物，一言不发。')
    commitModelOutput(nine, { updates: [], relations: [relationChange('恩断义绝', '沈砚望着断裂的信物')] })

    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).map(group => group.chapter)).toEqual([8, 1])
    expect(pending()).toEqual([])
  })

  it('后续章重述同样的关系之后同一份定稿重跑：不重复记节点', () => {
    openProject()
    commitModelOutput(finalizeNew(3, '第三章：林岚与沈砚结为盟友。'), { updates: [], relations: [relationChange('盟友', '结为盟友')] })
    const seven = finalizeNew(7, '第七章：两人仍是盟友。')
    const restated = { updates: [], relations: [relationChange('盟友', '仍是盟友')] }
    commitModelOutput(seven, restated)
    const before = eventCount()

    commitModelOutput(seven, restated)
    expect(eventCount()).toBe(before)
  })

  it('写第 N 章时看不到第 N 章的派生关系，写第 N+1 章时看得到', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })

    expect(latestNodesBefore(relationNodes(), 8).relations).toEqual([])
    expect(latestNodesBefore(relationNodes(), 9).relations[0].lines[0]).toMatchObject({ value: '恩断义绝', quote: { text: BREAK_UP } })
  })

  it('先改第 8 章再改第 5 章时，第 5 章的节点仍记在第 5 章，不把第 8 章的值盖掉', () => {
    openProject()
    const five = finalizeNew(5, '第五章：林岚与沈砚结为同盟。')
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    commitModelOutput(five, { updates: [], relations: [relationChange('同盟', '结为同盟')] })

    expect(latestNodesBefore(relationNodes(), 6).relations[0].lines.map(line => line.value)).toEqual(['同盟'])
    expect(latestNodesBefore(relationNodes(), 9).relations[0].lines.map(line => line.value)).toEqual(['恩断义绝'])
  })
})

describe('章节要点还没落库时角色那步被拒，要点落库后重跑', () => {
  const FORWARD_B = relationChange('恩断义绝', BREAK_UP), REVERSE_C = relationChange('势不两立', BREAK_UP, SHEN, LIN)
  const cards = () => pending().map(({ sourceId, targetId, value }) => ({ sourceId, targetId, value }))
  const rejected = (draftId: number, relations: unknown[]) => {
    try { commitModelOutput(draftId, { updates: [], relations }); return false } catch (error) {
      if ((error as Error).message !== NOTES_REQUIRED) throw error
      return true
    }
  }
  function bothDirectionsAuthored(): void {
    openProject()
    authorRelation('同门')
    authorRelation('同门', SHEN, LIN)
  }

  it('作者两个方向都有值，抽出正反两个新值后只重跑正向且值没变，要点之后才落库：被取代的反向值不出现，重跑后留下正向那一条', () => {
    bothDirectionsAuthored()
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const attempts = [rejected(draftId, [FORWARD_B, REVERSE_C]), rejected(draftId, [FORWARD_B])]
    saveNotes(draftId, '第8章摘要')

    expect(cards()).toEqual([])
    expect(attempts).toEqual([true, true])
    commitModelOutput(draftId, { updates: [], relations: [FORWARD_B] })
    expect(cards()).toEqual([{ sourceId: LIN, targetId: SHEN, value: '恩断义绝' }])
  })

  it('作者两个方向同值，先抽出正向 B、反向 C，重跑抽出正向 D、反向回到作者设定，要点之后才落库：结果与要点先到时一样，D 可以采用', () => {
    const FORWARD_D = relationChange('反目', BREAK_UP), REVERSE_AUTHOR = relationChange('同门', BREAK_UP, SHEN, LIN)
    const outcome = (notesFirst: boolean) => {
      bothDirectionsAuthored()
      const draftId = notesFirst ? finalizeNew(8, CHAPTER_EIGHT) : finalizeWithoutNotes(8, CHAPTER_EIGHT)
      const attempts = [rejected(draftId, [FORWARD_B, REVERSE_C]), rejected(draftId, [FORWARD_D, REVERSE_AUTHOR])]
      if (!notesFirst) {
        saveNotes(draftId, '第8章摘要')
        commitModelOutput(draftId, { updates: [], relations: [FORWARD_D, REVERSE_AUTHOR] })
      }
      const pendingCards = cards()
      decide('accept')
      const result = { attempts, pendingCards, forward: authorRows() }
      closeProjectDatabase()
      return result
    }

    expect(outcome(true)).toEqual({ attempts: [false, false], pendingCards: [{ sourceId: LIN, targetId: SHEN, value: '反目' }], forward: ['反目'] })
    expect(outcome(false)).toEqual({ attempts: [true, true], pendingCards: [{ sourceId: LIN, targetId: SHEN, value: '反目' }], forward: ['反目'] })
  })
})

describe('采用后的时间线只留一行', () => {
  const timeline = (characterId = LIN) => characterTimeline(readCharacterContinuityTimeline(db(), characterId).nodes)
  const chapterChanges = (chapter: number, characterId = LIN) => timeline(characterId).find(group => group.chapter === chapter)?.changes ?? []
  const changeCount = (characterId = LIN) => timeline(characterId).reduce((sum, group) => sum + group.changes.length, 0)

  it('采用后该章一行：旧值到新值，来源作者设定，带原文，底层节点都还在', () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('accept')

    expect(chapterChanges(8)).toHaveLength(1)
    expect(chapterChanges(8)[0]).toMatchObject({ source: 'author', removed: false, value: '恩断义绝', replaced: ['师徒'], node: { quote: { text: BREAK_UP } } })
    expect(changeCount()).toBe(2)
    expect(relationNodes().filter(node => node.effectiveChapter === 8).map(node => node.value).sort()).toEqual(['', '恩断义绝', '恩断义绝'])
  })

  it('没有采用时定稿记录和作者设定分开显示', () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })

    expect(chapterChanges(8).map(change => [change.source, change.value])).toEqual([['finalized', '恩断义绝']])
    expect(chapterChanges(1).map(change => [change.source, change.value])).toEqual([['author', '师徒']])
    decide('decline')
    expect(chapterChanges(8).map(change => [change.source, change.value])).toEqual([['finalized', '恩断义绝']])
    expect(changeCount()).toBe(2)
  })

  it('作者设定在反向时，采用后新设定记在定稿说的那个方向，作者原来那一边记解除', () => {
    openProject()
    authorRelation('素不相识', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('彼此信任', BREAK_UP)] })
    decide('accept')

    expect(chapterChanges(8, SHEN).map(change => [change.source, change.removed, change.value])).toEqual([['author', true, '素不相识']])
    expect(chapterChanges(8, LIN).map(change => [change.node.subjectId, change.source, change.value])).toContainEqual([LIN, 'author', '彼此信任'])
  })
})

describe('关系比对查两个方向', () => {
  const allAuthorRows = () => db().prepare('SELECT source_character_id AS source,target_character_id AS target,relation FROM character_relationships ORDER BY relation').all()
  const allDerived = () => readCharacterContinuityNodes(db()).filter(node => node.provenance.kind === 'derived')

  it('作者只写反向且不一致：出现一条待确认项，采用后换掉作者写的那一行，新行照定稿的方向', () => {
    openProject()
    authorRelation('素不相识', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('彼此信任', BREAK_UP)] })

    expect(pending()).toMatchObject([{ value: '彼此信任', authorRelations: ['素不相识'], evidence: { text: BREAK_UP } }])
    decide('accept')
    expect(pending()).toEqual([])
    expect(allAuthorRows()).toEqual([{ source: LIN, target: SHEN, relation: '彼此信任' }])
  })

  it('模型反写作者已有的关系不算变化：生效的只有作者设定，也不提示', () => {
    openProject()
    authorRelation('师徒', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('师徒', BREAK_UP)] })

    expect(latestNodesBefore(readCharacterContinuityNodes(db()), 9).relations.flatMap(pair => pair.lines.map(line => [line.subjectId, line.provenance.kind]))).toEqual([[SHEN, 'author']])
    expect(pending()).toEqual([])
  })

  it.each([
    ['作者写正向', [[LIN, SHEN]]],
    ['作者写反向', [[SHEN, LIN]]],
    ['作者两个方向都写了', [[LIN, SHEN], [SHEN, LIN]]],
  ])('同一章模型同时给出两个方向：只有一条建议（%s）', (_name, lines) => {
    openProject()
    lines.forEach(([source, target], index) => authorRelation(`旧设定${index}`, source, target))
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('彼此信任', BREAK_UP), relationChange('彼此信任', BREAK_UP, SHEN, LIN)] })

    expect(pending().map(item => item.value)).toEqual(['彼此信任'])
  })

  it('保留原设定后，重跑时模型换了方向也不再提示', () => {
    openProject()
    authorRelation('师徒', LIN, SHEN)
    authorRelation('徒弟', SHEN, LIN)
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const forward = relationChange('恩断义绝', BREAK_UP), backward = relationChange('恩断义绝', BREAK_UP, SHEN, LIN)
    commitModelOutput(draftId, { updates: [], relations: [forward, backward] })
    decide('decline')
    commitModelOutput(draftId, { updates: [], relations: [backward, forward] })

    expect(pending()).toEqual([])
  })

  it('作者两个方向都写了：采用只换卡片上那一行，另一个方向的作者行不动', () => {
    openProject()
    authorRelation('师父', LIN, SHEN)
    authorRelation('徒弟', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })

    expect(pending()).toMatchObject([{ sourceId: LIN, targetId: SHEN, authorRelations: ['师父'] }])
    decide('accept')
    expect(allAuthorRows()).toEqual(expect.arrayContaining([{ source: LIN, target: SHEN, relation: '恩断义绝' }, { source: SHEN, target: LIN, relation: '徒弟' }]))
    expect(allAuthorRows()).toHaveLength(2)
  })

  it('作者两个方向都写了：作者中途改了另一个方向，建议同样作废', () => {
    openProject()
    authorRelation('师父', LIN, SHEN)
    authorRelation('徒弟', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })

    db().prepare("UPDATE character_relationships SET relation='宿敌' WHERE relationship_id='reverse-line'").run()
    expect(pending()).toEqual([])
    expect(allAuthorRows()).toEqual(expect.arrayContaining([{ source: LIN, target: SHEN, relation: '师父' }, { source: SHEN, target: LIN, relation: '宿敌' }]))
  })

  it('反向的待确认项在重开并替换该章后失效', () => {
    openProject()
    authorRelation('素不相识', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('彼此信任', BREAK_UP)] })
    expect(pending()).toHaveLength(1)

    replaceFinal(8, '第八章改：林岚独自离开。')
    expect(pending()).toEqual([])
    expect(allDerived()).toEqual([])
  })
})

describe('待确认项和写稿提示跟着作者的决定走', () => {
  const AUTHOR_LINE = '作者设定（自第1章起）与沈砚的关系：师徒'
  const REWRITE = '沈砚冷眼旁观，林岚与他形同陌路。'
  const BOTH_READINGS = `${CHAPTER_EIGHT}${REWRITE}`
  const breakUp = relationChange('恩断义绝', BREAK_UP), estranged = relationChange('形同陌路', REWRITE)
  const output = (...relations: unknown[]) => ({ updates: [], relations })

  async function promptLines(chapter: number, characterId = LIN): Promise<string[]> {
    const nodes = await continuityNodesHandler()({}, [LIN, SHEN], getCurrentProjectPath()) as ContinuityNode[]
    return characterTimelinePromptLines({ nodes, chapter, characterIds: [LIN, SHEN], currentNames: new Map(Object.entries(NAMES)), language: 'zh-CN' })[characterId]
  }

  it('拒绝 A、重跑出待确认 B、再重跑回 A：列表没有 B，也无法采用 B', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, BOTH_READINGS)
    commitModelOutput(draftId, output(breakUp))
    decide('decline')
    commitModelOutput(draftId, output(estranged))
    const [stale] = pending()
    expect(stale.value).toBe('形同陌路')

    commitModelOutput(draftId, output(breakUp))
    expect(pending()).toEqual([])
    expect(() => SummaryRepository.decideFinalizedRelationCandidate({ draftId, candidateKey: stale.candidateKey, expectedAuthorRelations: stale.authorRelations,
      operationId: 'accept-stale', decision: 'accept' }, scope, db())).toThrow('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
    expect(authorRows()).toEqual(['师徒'])
  })

  it('保留原设定后，写下一章的提示只有作者设定，没有原文和待作者裁定', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(breakUp))
    decide('decline')

    expect(await promptLines(9)).toEqual([AUTHOR_LINE])
  })

  it('重跑回到拒绝过的值，提示同样只有作者设定', async () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, BOTH_READINGS)
    commitModelOutput(draftId, output(breakUp))
    decide('decline')
    commitModelOutput(draftId, output(estranged))
    commitModelOutput(draftId, output(breakUp))

    expect(await promptLines(9)).toEqual([AUTHOR_LINE])
  })

  it('作者设定在反向时，保留原设定后提示也只有作者写的那一边', async () => {
    openProject()
    authorRelation('师徒', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(breakUp))
    decide('decline')

    expect(await promptLines(9, SHEN)).toEqual(['作者设定（自第1章起）与林岚的关系：师徒'])
  })

  it('拒绝的是最新一条时，更早的定稿记录不会冒出来顶替；写更早的章仍看得到它', async () => {
    openProject()
    authorRelation('师徒')
    const quote = '林岚与沈砚渐生嫌隙。'
    commitModelOutput(finalizeNew(5, `第五章：${quote}`), output(relationChange('渐生嫌隙', quote)))
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(breakUp))
    const eighth = pending().find(item => item.value === '恩断义绝')!
    SummaryRepository.decideFinalizedRelationCandidate({ draftId: eighth.source.draftId, candidateKey: eighth.candidateKey, expectedAuthorRelations: eighth.authorRelations,
      operationId: 'decline-eighth', decision: 'decline' }, scope, db())

    expect(await promptLines(9)).toEqual([AUTHOR_LINE])
    expect((await promptLines(7)).join()).toContain(quote)
  })

  it('后续章重述拒绝过的值，提示仍只有作者设定', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(breakUp))
    decide('decline')
    const quote = '沈砚望着断裂的信物'
    commitModelOutput(finalizeNew(9, `第九章：${quote}，一言不发。`), output(relationChange('恩断义绝', quote)))

    expect(await promptLines(10)).toEqual([AUTHOR_LINE])
  })

  it('定稿重述作者设定之后作者手改了设定：下一章的提示只有新设定，没有待作者裁定，也没有建议', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(relationChange('师徒', BREAK_UP)))
    reviseAuthorRelation('同门')

    expect(await promptLines(9)).toEqual(['作者设定（自第9章起）与沈砚的关系：同门'])
    expect(pending()).toEqual([])
  })

  it('更早的章写过别的关系、之后定稿回到作者设定，作者再手改设定：下一章的提示同样只有新设定', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(5, '第五章：林岚视沈砚为仇敌。'), output(relationChange('仇敌', '视沈砚为仇敌')))
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(relationChange('师徒', BREAK_UP)))
    reviseAuthorRelation('同门')

    expect(await promptLines(9)).toEqual(['作者设定（自第9章起）与沈砚的关系：同门'])
    expect(pending()).toEqual([])
  })

  it('上一个开发版存下的定稿关系没记抽取时是否和作者设定一致：读出来不报错，作者手改设定之后照旧和新设定并存待作者裁定', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(5, '第五章：林岚视沈砚为仇敌。'), output(relationChange('仇敌', '视沈砚为仇敌')))
    const { source } = SummaryRepository.readFinalizedCharacterContext(finalizeNew(8, CHAPTER_EIGHT), scope, db())
    db().transaction(() => appendDerivedRelationNode(db(), { sourceId: LIN, sourceName: '林岚', targetId: SHEN, targetName: '沈砚', relation: '师徒', source,
      quote: { start: CHAPTER_EIGHT.indexOf(BREAK_UP), end: CHAPTER_EIGHT.length, text: BREAK_UP }, matchedAuthor: false }))()
    reviseAuthorRelation('同门')

    const lines = await promptLines(9)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(`定稿记录·与沈砚的关系（第8章，原文：${BREAK_UP}）`)
    expect(lines.every(line => line.includes('待作者裁定'))).toBe(true)
  })

  it('先定稿第 7 章再定稿第 5 章，和按顺序定稿一样：写第 9 章只有作者设定，第 5 章的说法只在写第 6 章时待作者裁定', async () => {
    const outcome = async (firstExtracted: 5 | 7) => {
      openProject()
      authorRelation('盟友')
      const five = finalizeNew(5, '第五章：林岚视沈砚为仇敌。'), seven = finalizeNew(7, '第七章：两人重新结为盟友。')
      const extract = {
        5: () => commitModelOutput(five, output(relationChange('仇敌', '视沈砚为仇敌'))),
        7: () => commitModelOutput(seven, output(relationChange('盟友', '重新结为盟友'))),
      }
      extract[firstExtracted]()
      extract[firstExtracted === 5 ? 7 : 5]()
      const result = {
        six: await promptLines(6), nine: await promptLines(9),
        cards: pending().map(card => [card.source.chapterNumber, card.value]),
        timeline: characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).flatMap(group => group.changes.map(change => [group.chapter, change.source, change.value])),
      }
      closeProjectDatabase()
      return result
    }

    const laterChapterFirst = await outcome(7)
    expect(laterChapterFirst.nine).toEqual(['作者设定（自第1章起）与沈砚的关系：盟友'])
    expect(laterChapterFirst.six).toHaveLength(2)
    expect(laterChapterFirst.six.every(line => line.includes('待作者裁定'))).toBe(true)
    expect(laterChapterFirst.cards).toEqual([[5, '仇敌']])
    expect(laterChapterFirst.timeline).toEqual([[7, 'finalized', '盟友'], [5, 'finalized', '仇敌'], [1, 'author', '盟友']])
    expect(laterChapterFirst).toEqual(await outcome(5))
  })

  it('定稿重述作者设定之后作者手改了设定，下一章定稿仍写旧关系：写第 9 章只有新设定，写第 10 章两条并存待作者裁定，有第 9 章的建议，时间线记下第 9 章', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(relationChange('师徒', BREAK_UP)))
    reviseAuthorRelation('同门')
    commitModelOutput(finalizeNew(9, '第九章：沈砚仍把林岚当徒弟。'), output(relationChange('师徒', '仍把林岚当徒弟')))

    expect(await promptLines(9)).toEqual(['作者设定（自第9章起）与沈砚的关系：同门'])
    const lines = await promptLines(10)
    expect(lines).toHaveLength(2)
    expect(lines.every(line => line.includes('待作者裁定'))).toBe(true)
    expect(lines[1]).toContain('定稿记录·与沈砚的关系（第9章，原文：仍把林岚当徒弟）')
    expect(pending().map(card => [card.source.chapterNumber, card.value])).toEqual([[9, '师徒']])
    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).flatMap(group => group.changes
      .filter(change => change.source === 'finalized').map(change => [group.chapter, change.value]))).toEqual([[9, '师徒']])
  })

  it.each([
    ['又写回旧关系：时间线记下这一章', '师徒', [[10, '师徒']]],
    ['照着新设定写：时间线不记', '同门', []],
  ])('定稿重述作者设定之后作者手改了设定，隔一章定稿%s', (_label, relation, finalizedRows) => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(relationChange('师徒', BREAK_UP)))
    reviseAuthorRelation('同门')
    commitModelOutput(finalizeNew(10, '第十章：沈砚仍把林岚当徒弟。'), output(relationChange(relation, '仍把林岚当徒弟')))

    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).flatMap(group => group.changes
      .filter(change => change.source === 'finalized').map(change => [group.chapter, change.value]))).toEqual(finalizedRows)
  })

  it('定稿重述作者设定之后作者手改了设定，再替换这一章写成别的关系：两条并存待作者裁定，有这一章的建议', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(relationChange('师徒', BREAK_UP)))
    reviseAuthorRelation('同门')
    commitModelOutput(replaceFinal(8, '第八章改：林岚视沈砚为仇敌。'), output(relationChange('仇敌', '视沈砚为仇敌')))

    const lines = await promptLines(9)
    expect(lines).toHaveLength(2)
    expect(lines.every(line => line.includes('待作者裁定'))).toBe(true)
    expect(lines[1]).toContain('定稿记录·与沈砚的关系（第8章，原文：视沈砚为仇敌）')
    expect(pending().map(card => [card.source.chapterNumber, card.value])).toEqual([[8, '仇敌']])
  })

  it('定稿重述作者设定之后作者手改了设定，同一份定稿重跑仍报旧关系：两条并存待作者裁定，有这一章的建议', async () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, output(relationChange('师徒', BREAK_UP)))
    reviseAuthorRelation('同门')
    commitModelOutput(draftId, output(relationChange('师徒', BREAK_UP)))

    const lines = await promptLines(9)
    expect(lines).toHaveLength(2)
    expect(lines.every(line => line.includes('待作者裁定'))).toBe(true)
    expect(pending().map(card => [card.source.chapterNumber, card.value])).toEqual([[8, '师徒']])
  })

  it('采用第 5 章的建议之后，第 7 章回到原设定的说法还在提示里，和采用的设定并存待作者裁定', async () => {
    openProject()
    authorRelation('盟友')
    commitModelOutput(finalizeNew(5, '第五章：林岚视沈砚为仇敌。'), output(relationChange('仇敌', '视沈砚为仇敌')))
    commitModelOutput(finalizeNew(7, '第七章：两人重新结为盟友。'), output(relationChange('盟友', '重新结为盟友')))
    decide('accept')

    const lines = await promptLines(9)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('作者设定（自第5章起）与沈砚的关系：仇敌')
    expect(lines[1]).toContain('定稿记录·与沈砚的关系（第7章，原文：重新结为盟友）')
    expect(lines.every(line => line.includes('待作者裁定'))).toBe(true)
  })

  it('第 5 章写成仇敌、第 7 章回到作者设定之后作者删掉了这条设定：写第 9 章用第 7 章的定稿记录', async () => {
    openProject()
    authorRelation('盟友')
    commitModelOutput(finalizeNew(5, '第五章：林岚视沈砚为仇敌。'), output(relationChange('仇敌', '视沈砚为仇敌')))
    commitModelOutput(finalizeNew(7, '第七章：两人重新结为盟友。'), output(relationChange('盟友', '重新结为盟友')))
    db().transaction(() => {
      deleteCharacterRelationship(db(), { relationshipId: 'author-line', sourceId: LIN, sourceName: '林岚', targetId: SHEN, targetName: '沈砚' }, 'seed-approval')
      refreshCharacterIdentityProjection(db())
    })()

    expect(await promptLines(9)).toEqual(['定稿记录·与沈砚的关系（第7章，原文：重新结为盟友）'])
  })

  it('后续章重述同样的关系：提示里的章号和原文仍是关系变成这样的那一章', async () => {
    openProject()
    commitModelOutput(finalizeNew(3, '第三章：林岚与沈砚结为盟友。'), output(relationChange('盟友', '结为盟友')))
    commitModelOutput(finalizeNew(7, '第七章：两人仍是盟友。'), output(relationChange('盟友', '仍是盟友')))

    expect(await promptLines(8)).toEqual(['定稿记录·与沈砚的关系（第3章，原文：结为盟友）'])
  })

  it('作者还没决定时，提示同时放作者设定和原文', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(breakUp))
    expect(pending()).toHaveLength(1)

    const lines = await promptLines(9)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(`${AUTHOR_LINE}（与沈砚有多条关系并存，待作者裁定`)
    expect(lines[1]).toContain(`定稿记录·与沈砚的关系（第8章，原文：${BREAK_UP}）`)
    expect(lines[1]).toContain('待作者裁定')
  })

  it('拒绝之后时间线仍显示这一行，计数不变', () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(breakUp))
    const before = characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes)
    decide('decline')

    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes)).toEqual(before)
    expect(before.flatMap(chapter => chapter.changes.map(change => [chapter.chapter, change.source, change.value])))
      .toEqual([[8, 'finalized', '恩断义绝'], [1, 'author', '师徒']])
  })

  it('拒绝之后后续章出现不同的新值：仍生成待确认项，提示按未决定处理', async () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(breakUp))
    decide('decline')
    const quote = '林岚提剑直指沈砚。'
    commitModelOutput(finalizeNew(9, `第九章：${quote}`), output(relationChange('不共戴天', quote)))

    expect(pending().map(item => item.value)).toEqual(['不共戴天'])
    const lines = await promptLines(10)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(`原文：${quote}`)
    expect(lines.every(line => line.includes('待作者裁定'))).toBe(true)
  })
})

describe('定稿后处理的提示词', () => {
  function prompt(draftId: number, language: 'zh-CN' | 'en-US', frozen?: Parameters<typeof captureFinalizationGenerationContext>[5]) {
    const { source } = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
    const context = captureFinalizationGenerationContext(db(), { source, stepKey: 'character_cards' }, scope, language,
      getBuiltinPromptTemplate('update_character_cards', language)!, frozen)
    return { context, task: finalizationGenerationTask(context) }
  }

  it.each([
    ['zh-CN', /relations[\s\S]*只写本章正文明确写出[\s\S]*确实发生变化/u],
    ['en-US', /relations[\s\S]*only[\s\S]*actually changed in this chapter/iu],
  ] as const)('%s 合同要求 relations，并列出作者已有关系，请求仍是同一次', (language, expected) => {
    openProject()
    authorRelation('师徒')
    const { task } = prompt(finalizeNew(8, CHAPTER_EIGHT), language)

    expect(task.messages.map(message => message.role)).toEqual(['system', 'user'])
    const content = String(task.messages[1].content)
    expect(content).toMatch(expected)
    expect(content).toContain('"relation": "师徒"')
    expect(content).toContain(SHEN)
  })

  it('自定义模板也带上关系合同', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const { source } = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
    const custom = { ...getBuiltinPromptTemplate('update_character_cards', 'zh-CN')!, content: '作者自己的模板：{{chapter_content}}' }
    const task = finalizationGenerationTask(captureFinalizationGenerationContext(db(), { source, stepKey: 'character_cards' }, scope, 'zh-CN', custom))

    expect(String(task.messages[1].content)).toContain('"relations"')
  })

  it('升级前冻结的在途定稿没有作者关系快照：重建不判身份变化，提示词照常生成', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const { context } = prompt(draftId, 'zh-CN')
    const { authorRelations: _dropped, ...oldIdentity } = context.identity as FinalizedCharacterContext
    void _dropped

    const { context: rebuilt, task } = prompt(draftId, 'zh-CN', { ...context, identity: oldIdentity })
    expect(rebuilt.identity).toEqual(oldIdentity)
    expect(String(task.messages[1].content)).not.toContain('"relation": "师徒"')
  })

  it('上一个开发版冻结的在途定稿带着作者关系修订号：续跑不判身份变化', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const { context } = prompt(draftId, 'zh-CN')
    const frozen = { ...context, identity: { ...context.identity, authorRelationsRevision: 3 } }

    expect(() => prompt(draftId, 'zh-CN', frozen)).not.toThrow()
  })

  it('作者关系在定稿后处理途中被改，不算身份变化', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const { context } = prompt(draftId, 'zh-CN')
    db().prepare("UPDATE character_relationships SET relation='宿敌' WHERE relationship_id='author-line'").run()

    expect(() => prompt(draftId, 'zh-CN', context)).not.toThrow()
    expect(prompt(draftId, 'zh-CN', context).context.identity).toEqual(context.identity)
  })

  it('定稿后处理途中作者采纳了较早章的建议，续跑不算身份变化，仍用开始时读到的作者关系', () => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, '第五章：山门。林岚与沈砚在山门前反目。')
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', '林岚与沈砚在山门前反目。')] })
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const { context } = prompt(draftId, 'zh-CN')
    decide('accept')

    expect(() => prompt(draftId, 'zh-CN', context)).not.toThrow()
    expect(prompt(draftId, 'zh-CN', context).context.identity).toEqual(context.identity)
  })
})

describe('作者对派生关系的决定，预检和建议说法一致', () => {
  const output = (...relations: unknown[]) => ({ updates: [], relations })
  const plan = (chapterNumber: number, relation: string | null, characters = ['林岚', '沈砚']): BlueprintForPreflight => ({
    chapterNumber, title: '', role: '', purpose: '', keyEvents: '', characters, suspenseHook: '', userGuidance: '', notes: '',
    relationshipHints: relation ? [{ from: '林岚', to: '沈砚', relation }] : [],
  })

  async function preflight(blueprint: BlueprintForPreflight) {
    continuityNodesHandler()
    const nodes = await ipcHandlers.get('db:character-continuity-preflight-nodes')!({}, getCurrentProjectPath()) as ContinuityNode[]
    return findBlueprintContinuityRisks([], blueprint, ConsistencyExemptionRepository.list(db()), nodes, pending())
  }

  function removeAuthorLine(chapter: number): void {
    db().transaction(() => {
      deleteCharacterRelationship(db(), { relationshipId: 'author-line', sourceId: LIN, sourceName: '林岚', targetId: SHEN, targetName: '沈砚' }, 'seed-approval', chapter)
      refreshCharacterIdentityProjection(db())
    })()
  }

  const setupPending = (relation = '恩断义绝') => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, output(relationChange(relation, BREAK_UP)))
    return draftId
  }

  describe('拒绝', () => {
    it('拒绝「仇敌」并保留「好友」：蓝图写仇敌时提示依据是作者设定，写好友时不提示', async () => {
      openProject()
      authorRelation('好友')
      commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(relationChange('仇敌', BREAK_UP)))
      decide('decline')

      expect(await preflight(plan(9, '仇敌'))).toMatchObject([{ stableFactKey: expect.stringMatching(/^relation:/u), evidence: '好友' }])
      expect(await preflight(plan(9, '好友'))).toEqual([])
    })

    it('被拒的关系是唯一依据时不报；没拒绝时同样的蓝图照常报', async () => {
      openProject()
      authorRelation('好友')
      commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(relationChange('仇敌', BREAK_UP)))
      decide('decline')
      removeAuthorLine(9)
      expect(await preflight(plan(12, '好友'))).toEqual([])

      closeProjectDatabase()
      openProject()
      commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), output(relationChange('仇敌', BREAK_UP)))
      expect(await preflight(plan(12, '好友'))).toMatchObject([{ sourceChapter: 8, evidence: BREAK_UP }])
    })
  })

  describe('后续章重述同样的关系', () => {
    it('全书豁免之后后续章重述：豁免仍管用，提示不回来', async () => {
      openProject()
      commitModelOutput(finalizeNew(3, '第三章：林岚与沈砚结为盟友。'), output(relationChange('盟友', '结为盟友')))
      const [finding, ...rest] = await preflight(plan(8, '仇敌'))
      expect(rest).toEqual([])
      ConsistencyExemptionRepository.save(finding.stableFactKey, '有意安排')
      expect(await preflight(plan(8, '仇敌'))).toEqual([])

      commitModelOutput(finalizeNew(7, '第七章：两人仍是盟友。'), output(relationChange('盟友', '仍是盟友')))
      expect(await preflight(plan(8, '仇敌'))).toEqual([])
    })

    it('作者在两次定稿之间写了设定，后一章只是重述：提示的依据是作者设定', async () => {
      openProject()
      commitModelOutput(finalizeNew(3, '第三章：林岚视沈砚为仇敌。'), output(relationChange('仇敌', '视沈砚为仇敌')))
      db().transaction(() => {
        db().prepare("INSERT OR IGNORE INTO character_identity_approvals VALUES('seed-approval','hash','{}')").run()
        insertCharacterRelationship(db(), { relationshipId: 'author-line', sourceId: LIN, sourceName: '林岚', targetId: SHEN, targetName: '沈砚', relation: '死敌', provenanceJson: '{"kind":"author"}' },
          { operationId: 'seed-approval', action: 'author-edit' }, 5)
        refreshCharacterIdentityProjection(db())
      })()
      commitModelOutput(finalizeNew(7, '第七章：两人仍是仇敌。'), output(relationChange('仇敌', '仍是仇敌')))

      expect((await preflight(plan(8, '盟友'))).filter(finding => finding.stableFactKey.startsWith('relation:'))).toMatchObject([{ authorSetting: true, sourceChapter: 5, evidence: '死敌' }])
    })
  })

  describe('待决定的警告', () => {
    it('本章出场人物包含这对人物：一条警告，放作者设定和原文，中英文都有', async () => {
      setupPending()

      const [finding, ...rest] = await preflight(plan(9, null))
      expect(rest).toEqual([])
      expect(finding).toMatchObject({ severity: 'warning', sourceChapter: 8, evidence: BREAK_UP, stableFactKey: `relation-pending:${pending()[0].candidateKey}` })
      for (const copy of [finding.issue.zhCN, finding.issue.enUS]) {
        expect(copy).toContain('师徒')
        expect(copy).toContain('恩断义绝')
      }
    })

    it('本章不含这对人物、或写的是定稿那一章及之前：没有警告', async () => {
      setupPending()

      expect(await preflight(plan(9, null, ['林岚', '路人']))).toEqual([])
      expect(await preflight(plan(8, null))).toEqual([])
      expect(await preflight(plan(3, null))).toEqual([])
    })

    it('同一对人物连着几章都待决定：只提示最新的一条', async () => {
      setupPending()
      const quote = '沈砚望着断裂的信物'
      commitModelOutput(finalizeNew(9, `第九章：${quote}，一言不发。`), output(relationChange('反目', quote)))

      expect(await preflight(plan(10, null))).toMatchObject([{ sourceChapter: 9, evidence: quote }])
      expect(await preflight(plan(9, null))).toMatchObject([{ sourceChapter: 8, evidence: BREAK_UP }])
    })

    it('改名后按现在的名字对上，卡片也显示现在的名字', async () => {
      setupPending()
      db().prepare("UPDATE characters SET name='林晚晴' WHERE character_id=?").run(LIN)

      expect(pending()).toMatchObject([{ sourceName: '林晚晴', targetName: '沈砚' }])
      expect(await preflight(plan(9, null, ['林晚晴', '沈砚']))).toHaveLength(1)
      expect(await preflight(plan(9, null))).toEqual([])
    })

    it.each(['accept', 'decline'] as const)('作者决定之后（%s）警告消失', async (decision) => {
      setupPending()
      expect(await preflight(plan(9, null))).toHaveLength(1)

      decide(decision)
      expect((await preflight(plan(9, null))).filter(finding => finding.stableFactKey.startsWith('relation-pending:'))).toEqual([])
    })

    it('按章豁免只管那一章，全书豁免各章都不提示', async () => {
      setupPending()
      const [{ stableFactKey }] = await preflight(plan(9, null))

      ConsistencyExemptionRepository.save(stableFactKey, '作者确认是有意安排', 9)
      expect(await preflight(plan(9, null))).toEqual([])
      expect(await preflight(plan(10, null))).toHaveLength(1)
      ConsistencyExemptionRepository.save(stableFactKey, '全书如此')
      expect(await preflight(plan(10, null))).toEqual([])
    })

    it('审稿入口冻结的结果不多出这条警告', async () => {
      setupPending()
      const body = '第九章：林岚独自上路。'
      db().prepare("INSERT INTO blueprints(chapter_number,title,characters) VALUES(9,'第9章',?)").run(JSON.stringify(['林岚', '沈砚']))
      const draftId = DraftRepository.create({ chapterNumber: 9, source: 'write', content: body, wordCount: body.length })
      expect(await preflight(plan(9, null))).toHaveLength(1)

      const context = captureReviewRevisionContext(db(), { operation: 'review-chapter', draftId, authorInputs: [], uiLocale: 'zh-CN',
        expectedDraft: { chapterNumber: 9, version: 1, status: 'draft', contentHash: sha256(body) } }, PROJECT_ID).materials
      expect(context.preflightFindings).toEqual([])
    })
  })

  describe('建议创建后作者又改了这一对', () => {
    const acceptStale = (candidate: ReturnType<typeof pending>[number]) => () => SummaryRepository.decideFinalizedRelationCandidate({
      draftId: candidate.source.draftId, candidateKey: candidate.candidateKey, expectedAuthorRelations: candidate.authorRelations,
      operationId: 'accept-stale', decision: 'accept' }, scope, db())
    const allRows = () => db().prepare('SELECT source_character_id AS source,target_character_id AS target,relation FROM character_relationships ORDER BY relation').all()

    it('改了值：卡片和警告都消失，决定入口拒绝，关系表不动', async () => {
      setupPending()
      const [stale] = pending()
      db().prepare("UPDATE character_relationships SET relation='宿敌' WHERE relationship_id='author-line'").run()

      expect(pending()).toEqual([])
      expect(await preflight(plan(9, null))).toEqual([])
      expect(acceptStale(stale)).toThrow('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
      expect(allRows()).toEqual([{ source: LIN, target: SHEN, relation: '宿敌' }])
    })

    it('只改了方向、值没变：同样作废，方向不被翻回去', () => {
      setupPending()
      const [stale] = pending()
      db().prepare('UPDATE character_relationships SET source_character_id=?,target_character_id=? WHERE relationship_id=?').run(SHEN, LIN, 'author-line')

      expect(pending()).toEqual([])
      expect(acceptStale(stale)).toThrow('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
      expect(allRows()).toEqual([{ source: SHEN, target: LIN, relation: '师徒' }])
    })

    it('同一份定稿重跑不会让作废的建议复活', () => {
      const draftId = setupPending()
      db().prepare("UPDATE character_relationships SET relation='宿敌' WHERE relationship_id='author-line'").run()

      commitModelOutput(draftId, output(relationChange('恩断义绝', BREAK_UP)))
      expect(pending()).toEqual([])
    })

    it('旧候选没有快照字段：列表、改动拒绝和采用都照旧', () => {
      const draftId = setupPending()
      const row = db().prepare('SELECT id,character_state_candidates AS candidates FROM summary_snapshots WHERE draft_id=?').get(draftId) as { id: number; candidates: string }
      const store = JSON.parse(row.candidates) as { relationPending: Array<Record<string, unknown>> }
      for (const candidate of store.relationPending) delete candidate.authorLinesAtCreation
      db().prepare('UPDATE summary_snapshots_all SET character_state_candidates=? WHERE id=?').run(JSON.stringify(store), row.id)

      const [legacy] = pending()
      expect(legacy).toMatchObject({ value: '恩断义绝', authorRelations: ['师徒'] })
      db().prepare("UPDATE character_relationships SET relation='宿敌' WHERE relationship_id='author-line'").run()
      expect(pending()).toMatchObject([{ authorRelations: ['宿敌'] }])
      expect(acceptStale(legacy)).toThrow('FINALIZED_CHARACTER_STATE_FIELD_CONFLICT')
      decide('accept')
      expect(authorRows()).toEqual(['恩断义绝'])
    })

    it('采用较早章的建议后，较晚章的建议还在，也还能采用', () => {
      setupPending()
      const quote = '沈砚望着断裂的信物'
      commitModelOutput(finalizeNew(9, `第九章：${quote}，一言不发。`), output(relationChange('反目', quote)))
      decide('accept')

      expect(pending()).toMatchObject([{ value: '反目', authorRelations: ['恩断义绝'] }])
      decide('accept')
      expect(authorRows()).toEqual(['反目'])
    })

    it('采用较晚章的建议后，较早章的建议作废，不会把旧值采用回来', () => {
      setupPending()
      const quote = '沈砚望着断裂的信物'
      commitModelOutput(finalizeNew(9, `第九章：${quote}，一言不发。`), output(relationChange('反目', quote)))
      const ninth = pending().find(item => item.value === '反目')!
      SummaryRepository.decideFinalizedRelationCandidate({ draftId: ninth.source.draftId, candidateKey: ninth.candidateKey,
        expectedAuthorRelations: ninth.authorRelations, operationId: 'accept-ninth', decision: 'accept' }, scope, db())

      expect(pending()).toEqual([])
      expect(authorRows()).toEqual(['反目'])
    })
  })
})

describe('较早章建议被采纳后，较晚章的建议是否还有效', () => {
  const FIVE_QUOTE = '林岚与沈砚在山门前反目。'
  const SIX_QUOTE = '林岚与沈砚在断桥决裂。'
  const cards = () => pending().map(({ value, source }) => ({ value, chapter: source.chapterNumber }))

  it('第 8 章抽取开始后作者采纳第 5 章建议，第 8 章的建议照样出现', () => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    const context = SummaryRepository.readFinalizedCharacterContext(eight, scope, db())
    decide('accept')
    SummaryRepository.commitFinalizedCharacterStates(context, parseFinalizedCharacterStateResponse(JSON.stringify({ updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] }), context), db())

    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])
  })

  it('作者先手改、再采纳一张较早章的新建议：第 8 章的旧建议不复活', () => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    reviseAuthorRelation('同门')
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    expect(cards()).toEqual([{ value: '反目', chapter: 5 }])

    decide('accept')
    expect(authorRows()).toEqual(['反目'])
    expect(cards()).toEqual([])
  })

  it('第 8 章要点已存、之后第 9 章起的连续性记录作废：第 8 章角色那步提交的建议照样出现', () => {
    openProject()
    authorRelation('师徒')
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    invalidateContinuityProjectionFrom(db(), 9)
    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })

    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])
  })

  it('先后采纳第 5 章、第 6 章的建议，第 8 章的建议还在', () => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    const six = finalizeNew(6, `第六章：断桥。${SIX_QUOTE}`)
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('accept')
    commitModelOutput(six, { updates: [], relations: [relationChange('决裂', SIX_QUOTE)] })
    expect(cards()).toEqual([{ value: '决裂', chapter: 6 }, { value: '恩断义绝', chapter: 8 }])

    decide('accept')
    expect(authorRows()).toEqual(['决裂'])
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])
  })

  it.each([
    ['直接改关系表', reviseAuthorRelation],
    ['按角色页保存的写法改', reviseAuthorRelationThroughRoster],
  ])('第 8 章抽出建议后先后采纳第 5 章、第 6 章的建议，作者再手改回第 5 章采纳的值（%s）：第 8 章的建议作废，采用入口拒绝', (_label, revise) => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    const six = finalizeNew(6, `第六章：断桥。${SIX_QUOTE}`)
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('accept')
    commitModelOutput(six, { updates: [], relations: [relationChange('决裂', SIX_QUOTE)] })
    decide('accept')
    const [eighth] = pending()
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])

    revise('反目')

    expect(cards()).toEqual([])
    expect(() => SummaryRepository.decideFinalizedRelationCandidate({ draftId: eighth.source.draftId, candidateKey: eighth.candidateKey,
      expectedAuthorRelations: ['反目'], operationId: 'accept-eighth-after-manual-edit', decision: 'accept' }, scope, db())).toThrow('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
    expect(authorRows()).toEqual(['反目'])
  })

  it('采纳第 5 章的建议后关系又变了、却没有留下写入记录：采纳后的作者行接不上现在的，第 8 章的建议作废', () => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('accept')
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])

    db().prepare("UPDATE character_relationships SET relation='宿敌'").run()

    expect(cards()).toEqual([])
  })

  it('较早章的采纳把关系改回过以前的值，第 8 章的建议照样认得出', () => {
    const SEVEN_QUOTE = '林岚与沈砚在渡口再度反目。'
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    const six = finalizeNew(6, `第六章：断桥。${SIX_QUOTE}`)
    const seven = finalizeNew(7, `第七章：渡口。${SEVEN_QUOTE}`)
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    decide('accept')
    commitModelOutput(six, { updates: [], relations: [relationChange('决裂', SIX_QUOTE)] })
    decide('accept')
    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    commitModelOutput(seven, { updates: [], relations: [relationChange('反目', SEVEN_QUOTE)] })
    expect(cards()).toEqual([{ value: '反目', chapter: 7 }, { value: '恩断义绝', chapter: 8 }])

    decide('accept')
    expect(authorRows()).toEqual(['反目'])
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])
  })

  it('第 5 章采纳后作者手改回原值，第 8 章抽出建议后作者又手改：第 8 章的建议作废', () => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    decide('accept')
    reviseAuthorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])

    reviseAuthorRelation('反目')
    expect(cards()).toEqual([])
  })

  it('第 8 章先定稿，第 5 章采纳、作者手改回原值之后才抽取，作者再手改：第 8 章的建议作废', () => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    decide('accept')
    reviseAuthorRelation('师徒')
    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])

    reviseAuthorRelation('反目')
    expect(cards()).toEqual([])
  })

  it('第 8 章角色那步因要点没落库被拒，第 5 章的采纳早于抽取：要点落库后重新提交，作者再手改，第 8 章的建议作废', () => {
    openProject()
    authorRelation('师徒')
    const five = finalizeNew(5, `第五章：山门。${FIVE_QUOTE}`)
    commitModelOutput(five, { updates: [], relations: [relationChange('反目', FIVE_QUOTE)] })
    decide('accept')
    reviseAuthorRelation('师徒')
    const eight = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const submit = frozenSubmission(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(submit).toThrow(NOTES_REQUIRED)
    saveNotes(eight, '第8章摘要')
    submit()
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])

    reviseAuthorRelation('反目')
    expect(cards()).toEqual([])
  })
})

describe('几章连着写同一个和作者设定不同的关系：一段说法一张建议', () => {
  const THREE_QUOTE = '林岚与沈砚在山门前反目。', SEVEN_QUOTE = '两人依旧反目。'
  const NINE_QUOTE = '沈砚望着断裂的信物'
  const cards = () => pending().map(({ value, source }) => ({ value, chapter: source.chapterNumber }))
  const restated = { updates: [], relations: [relationChange('恩断义绝', NINE_QUOTE)] }

  it('第 3 章和第 7 章都写反目：只有第 3 章那张；替换第 3 章之后第 7 章的建议顶上来，重存要点也还在，可以采用', () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(3, `第三章：${THREE_QUOTE}`), { updates: [], relations: [relationChange('反目', THREE_QUOTE)] })
    const seven = finalizeNew(7, `第七章：${SEVEN_QUOTE}`)
    commitModelOutput(seven, { updates: [], relations: [relationChange('反目', SEVEN_QUOTE)] })
    expect(cards()).toEqual([{ value: '反目', chapter: 3 }])

    replaceFinal(3, '第三章改：林岚独自下山。')
    expect(cards()).toEqual([{ value: '反目', chapter: 7 }])
    saveNotes(seven, '第7章摘要又一版')
    expect(cards()).toEqual([{ value: '反目', chapter: 7 }])
    decide('accept')
    expect(authorRows()).toEqual(['反目'])
  })

  it('较晚的章先出了建议，之后较早的章定稿写了同样的关系：建议换成较早那章的，原来那张不能再采用', () => {
    openProject()
    authorRelation('师徒')
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(finalizeNew(9, `第九章：${NINE_QUOTE}，一言不发。`), restated)
    const [late] = pending()
    expect(late.source.chapterNumber).toBe(9)

    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])
    expect(() => SummaryRepository.decideFinalizedRelationCandidate({ draftId: late.source.draftId, candidateKey: late.candidateKey, expectedAuthorRelations: late.authorRelations,
      operationId: 'accept-late', decision: 'accept' }, scope, db())).toThrow('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
    expect(authorRows()).toEqual(['师徒'])
  })

  it('保留原设定之后较早的章定稿写了同样的关系：不再出建议', () => {
    openProject()
    authorRelation('师徒')
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(finalizeNew(9, `第九章：${NINE_QUOTE}，一言不发。`), restated)
    decide('decline')

    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(cards()).toEqual([])
    expect(latestNodesBefore(SummaryRepository.readContinuityNodesForPreflight(db()), 9).relations.flatMap(pair => pair.lines.map(line => line.value))).toEqual(['师徒'])
  })

  it('后续章重述时章节要点还没落库：角色那步被拒、什么都不落库，要点落库后重新提交，仍只有最早那张建议', () => {
    openProject()
    authorRelation('师徒')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    const nine = finalizeWithoutNotes(9, `第九章：${NINE_QUOTE}，一言不发。`)
    const submit = frozenSubmission(nine, restated)
    const before = eventCount()

    expect(submit).toThrow(NOTES_REQUIRED)
    expect(eventCount()).toBe(before)
    saveNotes(nine, '第9章摘要')
    submit()
    expect(eventCount()).toBe(Number(before) + 1)
    expect(cards()).toEqual([{ value: '恩断义绝', chapter: 8 }])
  })
})

describe('没有作者关系时，同一对角色的定稿关系不分方向', () => {
  const ALLY = '第三章：林岚与沈砚结为盟友。', FOE = '第七章：沈砚视林岚为仇敌。'
  const inForce = (chapter: number) => latestNodesBefore(readCharacterContinuityNodes(db()), chapter).relations.flatMap(pair => pair.lines.map(line => line.value))
  const reversals = async (relation: string) => {
    continuityNodesHandler()
    const nodes = await ipcHandlers.get('db:character-continuity-preflight-nodes')!({}, getCurrentProjectPath()) as ContinuityNode[]
    return findBlueprintContinuityRisks([], { chapterNumber: 8, title: '', role: '', purpose: '', keyEvents: '', characters: ['林岚', '沈砚'],
      suspenseHook: '', userGuidance: '', notes: '', relationshipHints: [{ from: '林岚', to: '沈砚', relation }] }, [], nodes, pending())
  }

  it.each([
    ['先林岚→沈砚，后反向', LIN, SHEN],
    ['先沈砚→林岚，后反向', SHEN, LIN],
  ])('%s：第 8 章只剩后报告的一条，蓝图写回旧关系时提示', async (_label, first, second) => {
    openProject()
    commitModelOutput(finalizeNew(3, ALLY), { updates: [], relations: [relationChange('盟友', '结为盟友', first, second)] })
    commitModelOutput(finalizeNew(7, FOE), { updates: [], relations: [relationChange('仇敌', '视林岚为仇敌', second, first)] })

    expect(inForce(8)).toEqual(['仇敌'])
    expect(await reversals('盟友')).toHaveLength(1)
  })

  it('先定稿后面的章再定稿前面的章：第 8 章仍只剩第 7 章那条', () => {
    openProject()
    const three = finalizeNew(3, ALLY), seven = finalizeNew(7, FOE)
    commitModelOutput(seven, { updates: [], relations: [relationChange('仇敌', '视林岚为仇敌', SHEN, LIN)] })
    commitModelOutput(three, { updates: [], relations: [relationChange('盟友', '结为盟友', LIN, SHEN)] })

    expect(inForce(4)).toEqual(['盟友'])
    expect(inForce(8)).toEqual(['仇敌'])
  })

  it('被替换的定稿稿上的旧方向不参与判断：替换稿落在反向后，后面的章仍并进替换稿那条', () => {
    openProject()
    commitModelOutput(finalizeNew(3, ALLY), { updates: [], relations: [relationChange('盟友', '结为盟友', LIN, SHEN)] })
    const replacement = replaceFinal(3, `第三章改：${FOE}`)
    authorRelation('盟友', SHEN, LIN)
    commitModelOutput(replacement, { updates: [], relations: [relationChange('仇敌', '视林岚为仇敌', LIN, SHEN)] })
    db().transaction(() => deleteCharacterRelationship(db(), { relationshipId: 'reverse-line', sourceId: SHEN, sourceName: '沈砚', targetId: LIN, targetName: '林岚' }, 'seed-approval', 4))()

    commitModelOutput(finalizeNew(7, '第七章：林岚与沈砚成了死敌。'), { updates: [], relations: [relationChange('死敌', '成了死敌', LIN, SHEN)] })

    expect(inForce(8).filter(Boolean)).toEqual(['死敌'])
  })
})

describe('派生关系的系列是这对人物，方向和说法照定稿原样', () => {
  const APPRENTICE = '第三章：林岚向沈砚拜师。', MASTER = '第七章：沈砚收林岚为徒。'
  const timelineRows = (characterId: string) => characterTimeline(readCharacterContinuityTimeline(db(), characterId).nodes)
    .flatMap(group => group.changes.map(({ node, value }) => node.aspect === 'relation' ? [node.subjectId, node.targetId, value] : []))
  const linesInForce = (chapter: number) => latestNodesBefore(readCharacterContinuityNodes(db()), chapter).relations
    .flatMap(pair => pair.lines.map(line => [line.subjectId, line.targetId, line.value]))

  it('第 3 章林岚→沈砚「盟友」，第 7 章沈砚→林岚「仇敌」：第 8 章只有一条，是沈砚对林岚的「仇敌」', async () => {
    openProject()
    commitModelOutput(finalizeNew(3, '第三章：林岚与沈砚结为盟友。'), { updates: [], relations: [relationChange('盟友', '结为盟友')] })
    commitModelOutput(finalizeNew(7, '第七章：沈砚视林岚为仇敌。'), { updates: [], relations: [relationChange('仇敌', '视林岚为仇敌', SHEN, LIN)] })

    expect(linesInForce(8)).toEqual([[SHEN, LIN, '仇敌']])
    const nodes = await continuityNodesHandler()({}, [LIN], getCurrentProjectPath()) as ContinuityNode[]
    const lines = characterTimelinePromptLines({ nodes, chapter: 8, characterIds: [LIN], currentNames: new Map(Object.entries(NAMES)), language: 'zh-CN' })
    expect(JSON.stringify(lines)).not.toContain('盟友')
  })

  it('同一份定稿重跑时方向和说法都换了：生效的是后一次的说法', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    commitModelOutput(draftId, { updates: [], relations: [relationChange('形同陌路', BREAK_UP, SHEN, LIN)] })

    expect(linesInForce(9)).toEqual([[SHEN, LIN, '形同陌路']])
  })

  it('林岚→沈砚「拜师」之后模型报沈砚→林岚「收徒」：时间线是沈砚对林岚「收徒」', () => {
    openProject()
    commitModelOutput(finalizeNew(3, APPRENTICE), { updates: [], relations: [relationChange('拜师', '向沈砚拜师')] })
    commitModelOutput(finalizeNew(7, MASTER), { updates: [], relations: [relationChange('收徒', '收林岚为徒', SHEN, LIN)] })

    expect(timelineRows(SHEN)).toEqual([[SHEN, LIN, '收徒']])
    expect(timelineRows(LIN)).toEqual([[LIN, SHEN, '拜师']])
    expect(linesInForce(8)).toEqual([[SHEN, LIN, '收徒']])
  })

  it('第 3 章林岚→沈砚「暗恋」，第 7 章沈砚→林岚「暗恋」：说法一样、方向换了也是变化，第 7 章进沈砚的时间线，写第 8 章用新方向', async () => {
    openProject()
    commitModelOutput(finalizeNew(3, '第三章：林岚暗恋沈砚。'), { updates: [], relations: [relationChange('暗恋', '林岚暗恋沈砚')] })
    commitModelOutput(finalizeNew(7, '第七章：沈砚暗恋林岚。'), { updates: [], relations: [relationChange('暗恋', '沈砚暗恋林岚', SHEN, LIN)] })

    const chapters = (characterId: string) => characterTimeline(readCharacterContinuityTimeline(db(), characterId).nodes).map(group => group.chapter)
    expect(chapters(SHEN)).toEqual([7])
    expect(chapters(LIN)).toEqual([3])
    expect(linesInForce(4)).toEqual([[LIN, SHEN, '暗恋']])
    expect(linesInForce(8)).toEqual([[SHEN, LIN, '暗恋']])
    const nodes = await continuityNodesHandler()({}, [SHEN], getCurrentProjectPath()) as ContinuityNode[]
    expect(characterTimelinePromptLines({ nodes, chapter: 8, characterIds: [SHEN], currentNames: new Map(Object.entries(NAMES)), language: 'zh-CN' }))
      .toEqual({ [SHEN]: ['定稿记录·与林岚的关系（第7章，原文：沈砚暗恋林岚）'] })
  })

  it('作者写了林岚→沈砚「拜师」，定稿报沈砚→林岚「收徒」：建议和采用都是沈砚对林岚「收徒」', () => {
    openProject()
    authorRelation('拜师')
    commitModelOutput(finalizeNew(7, MASTER), { updates: [], relations: [relationChange('收徒', '收林岚为徒', SHEN, LIN)] })

    expect(pending()).toMatchObject([{ sourceId: SHEN, targetId: LIN, sourceName: '沈砚', targetName: '林岚', value: '收徒', authorRelations: ['拜师'] }])
    expect(linesInForce(8)).toEqual(expect.arrayContaining([[SHEN, LIN, '收徒'], [LIN, SHEN, '拜师']]))
    decide('accept')
    expect(db().prepare('SELECT source_character_id AS source,target_character_id AS target,relation FROM character_relationships').all())
      .toEqual([{ source: SHEN, target: LIN, relation: '收徒' }])
  })
})

describe('时间线算不算变化，看这对人物两个方向的记录', () => {
  const relationRows = (characterId: string) => characterTimeline(readCharacterContinuityTimeline(db(), characterId).nodes)
    .flatMap(group => group.changes.map(change => [group.chapter, change.source, change.value]))

  it('第 3 章林岚→沈砚盟友，第 5 章沈砚→林岚仇敌，第 7 章林岚→沈砚盟友：林岚的时间线有第 3 章和第 7 章', () => {
    openProject()
    commitModelOutput(finalizeNew(3, '第三章：林岚与沈砚结为盟友。'), { updates: [], relations: [relationChange('盟友', '结为盟友')] })
    commitModelOutput(finalizeNew(5, '第五章：沈砚视林岚为仇敌。'), { updates: [], relations: [relationChange('仇敌', '视林岚为仇敌', SHEN, LIN)] })
    commitModelOutput(finalizeNew(7, '第七章：两人重新结为盟友。'), { updates: [], relations: [relationChange('盟友', '重新结为盟友')] })

    expect(relationRows(LIN)).toEqual([[7, 'finalized', '盟友'], [3, 'finalized', '盟友']])
    expect(relationRows(SHEN)).toEqual([[5, 'finalized', '仇敌']])
  })

  it('作者设定写在沈砚那边，替换掉中间那章之后林岚这边只剩对作者设定的重述：林岚的时间线不记', () => {
    openProject()
    authorRelation('师徒', SHEN, LIN)
    commitModelOutput(finalizeNew(5, '第五章：林岚视沈砚为仇敌。'), { updates: [], relations: [relationChange('仇敌', '视沈砚为仇敌')] })
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('师徒', BREAK_UP)] })
    expect(relationRows(LIN)).toEqual([[8, 'finalized', '师徒'], [5, 'finalized', '仇敌']])

    replaceFinal(5, '第五章改：林岚独自下山。')
    expect(relationRows(LIN)).toEqual([])
    expect(relationRows(SHEN)).toEqual([[1, 'author', '师徒']])
  })
})

describe('一次抽取对一对人物只记一条说法，方向也算说法的一部分', () => {
  const linesInForce = (chapter: number) => latestNodesBefore(readCharacterContinuityNodes(db()), chapter).relations
    .flatMap(pair => pair.lines.map(line => [line.subjectId, line.targetId, line.value]))
  const timelineRows = (characterId: string) => characterTimeline(readCharacterContinuityTimeline(db(), characterId).nodes)
    .flatMap(group => group.changes.map(change => [group.chapter, change.value]))
  const cards = () => pending().map(({ sourceId, targetId, value }) => [sourceId, targetId, value])

  it('同一份定稿重跑时说法没变、方向改了：生效的关系和时间线都换成改后的方向', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('崇拜', BREAK_UP)] })
    commitModelOutput(draftId, { updates: [], relations: [relationChange('崇拜', BREAK_UP, SHEN, LIN)] })

    expect(linesInForce(9)).toEqual([[SHEN, LIN, '崇拜']])
    expect(timelineRows(SHEN)).toEqual([[8, '崇拜']])
    expect(timelineRows(LIN)).toEqual([])
  })

  it('和作者设定不同的建议在重跑时改了方向：建议卡跟着换方向，采用后关系表是改后的方向', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('暗恋', BREAK_UP)] })
    expect(cards()).toEqual([[LIN, SHEN, '暗恋']])

    commitModelOutput(draftId, { updates: [], relations: [relationChange('暗恋', BREAK_UP, SHEN, LIN)] })
    expect(cards()).toEqual([[SHEN, LIN, '暗恋']])
    decide('accept')
    expect(db().prepare('SELECT source_character_id AS source,target_character_id AS target,relation FROM character_relationships').all())
      .toEqual([{ source: SHEN, target: LIN, relation: '暗恋' }])
  })

  it('作者打开建议卡之后同一份定稿重跑改了方向：原来那张卡不能再采用，关系表不动，改后的是另一张卡', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('暗恋', BREAK_UP)] })
    const [opened] = pending()

    commitModelOutput(draftId, { updates: [], relations: [relationChange('暗恋', BREAK_UP, SHEN, LIN)] })
    expect(() => SummaryRepository.decideFinalizedRelationCandidate({ draftId, candidateKey: opened.candidateKey, expectedAuthorRelations: opened.authorRelations,
      operationId: 'accept-opened-before-rerun', decision: 'accept' }, scope, db())).toThrow('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
    expect(authorRows()).toEqual(['师徒'])
    expect(cards()).toEqual([[SHEN, LIN, '暗恋']])
    expect(pending()[0].candidateKey).not.toBe(opened.candidateKey)
  })

  it('保留原设定之后同一份定稿重跑改了方向：不再出建议，生效的只有作者设定', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('暗恋', BREAK_UP)] })
    decide('decline')

    commitModelOutput(draftId, { updates: [], relations: [relationChange('暗恋', BREAK_UP, SHEN, LIN)] })
    expect(cards()).toEqual([])
    expect(latestNodesBefore(SummaryRepository.readContinuityNodesForPreflight(db()), 9).relations.flatMap(pair => pair.lines.map(line => line.value))).toEqual(['师徒'])
  })

  it('作者改了设定、建议作废之后同一份定稿重跑改了方向：作废的建议不复活', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('暗恋', BREAK_UP)] })
    db().prepare("UPDATE character_relationships SET relation='宿敌' WHERE relationship_id='author-line'").run()
    expect(cards()).toEqual([])

    commitModelOutput(draftId, { updates: [], relations: [relationChange('暗恋', BREAK_UP, SHEN, LIN)] })
    expect(cards()).toEqual([])
  })

  it('作者设定盟友，同一次抽取报林岚→沈砚「仇敌」和沈砚→林岚「盟友」：生效的关系里有建议卡上的「仇敌」，待作者裁定', () => {
    openProject()
    authorRelation('盟友')
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('仇敌', BREAK_UP), relationChange('盟友', BREAK_UP, SHEN, LIN)] })

    expect(cards()).toEqual([[LIN, SHEN, '仇敌']])
    expect(latestNodesBefore(readCharacterContinuityNodes(db()), 9).relations.map(pair => [pair.conflict, pair.lines.map(line => line.value).sort()])).toEqual([[true, ['仇敌', '盟友']]])
  })

  it('同一次抽取两个方向各报一种说法：只记后报的一条，重跑同一份结果不再多记', () => {
    openProject()
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const output = { updates: [], relations: [relationChange('拜师', BREAK_UP), relationChange('收徒', BREAK_UP, SHEN, LIN)] }
    commitModelOutput(draftId, output)
    const before = eventCount()

    commitModelOutput(draftId, output)
    expect(eventCount()).toBe(before)
    expect(linesInForce(9)).toEqual([[SHEN, LIN, '收徒']])
    expect(timelineRows(LIN)).toEqual([])
  })
})

describe('后续章重述同样的关系，之后再定稿更早的章', () => {
  const inForce = (chapter: number) => latestNodesBefore(readCharacterContinuityNodes(db()), chapter).relations.flatMap(pair => pair.lines.map(line => line.value)).sort()

  it.each([
    ['同向重述', LIN, SHEN, [7, 5, 3]],
    ['反向重述', SHEN, LIN, [5, 3]],
  ])('第 3 章盟友、第 7 章%s盟友，之后定稿第 5 章仇敌：第 8 章仍是盟友；同向重述时林岚的时间线记下第 7 章变回盟友，反向重述记在沈砚那边', (_label, source, target, linChapters) => {
    openProject()
    commitModelOutput(finalizeNew(3, '第三章：林岚与沈砚结为盟友。'), { updates: [], relations: [relationChange('盟友', '结为盟友')] })
    commitModelOutput(finalizeNew(7, '第七章：两人仍是盟友。'), { updates: [], relations: [relationChange('盟友', '仍是盟友', source, target)] })
    commitModelOutput(finalizeNew(5, '第五章：林岚视沈砚为仇敌。'), { updates: [], relations: [relationChange('仇敌', '视沈砚为仇敌')] })

    expect(inForce(6)).toEqual(['仇敌'])
    expect(inForce(8)).toEqual(['盟友'])
    expect(characterTimeline(readCharacterContinuityTimeline(db(), LIN).nodes).map(group => group.chapter)).toEqual(linChapters)
  })
})
