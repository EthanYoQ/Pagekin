import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getCurrentProjectPath, getProjectDb, initProjectDatabase } from '../../database'
import { registerDatabaseController } from '../../controllers/db-controller'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { deleteCharacterRelationship, derivedRelationSeries, insertCharacterRelationship, readCharacterContinuityNodes, readCharacterContinuityTimeline } from '../../repositories/character-continuity-repository'
import { refreshCharacterIdentityProjection } from '../../repositories/character-roster-repository'
import { ConsistencyExemptionRepository } from '../../repositories/consistency-exemption-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
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

const relationNodes = () => readCharacterContinuityNodes(db(), LIN).filter((node): node is CharacterRelationNode => node.aspect === 'relation')
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

function saveNotes(draftId: number, chapterNotes: string): void {
  const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
  SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber: context.source.chapterNumber, chapterNotes, facts: [],
    source: context.source, projectionGeneration: context.projectionGeneration }, db())
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

    const chapters = characterTimeline(readCharacterContinuityNodes(db(), LIN))
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

  it('章节要点还没落库时角色那步先提交：要点补上后，待确认项照样出现', () => {
    openProject()
    authorRelation('师徒')
    const draftId = DraftRepository.create({ chapterNumber: 8, source: 'write', content: CHAPTER_EIGHT, wordCount: CHAPTER_EIGHT.length })
    db().prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(8,?)').run('第8章')
    FinalizationRepository.commit({ finalizationId: `finalization-${randomUUID()}`, draftId, chapterNumber: 8,
      chapterTitle: '第8章', content: CHAPTER_EIGHT, contentHash: sha256(CHAPTER_EIGHT), contentRevision: 1, targetFileName: `8-${draftId}.md` })
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])

    const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
    SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber: 8, chapterNotes: '第8章摘要', facts: [],
      source: context.source, projectionGeneration: context.projectionGeneration }, db())

    expect(pending()).toMatchObject([{ sourceId: LIN, targetId: SHEN, value: '恩断义绝', authorRelations: ['师徒'], evidence: { text: BREAK_UP }, source: { draftId, chapterNumber: 8 } }])
    expect(decide('accept')).toMatchObject({ decision: 'accept', idempotent: false })
    expect(authorRows()).toEqual(['恩断义绝'])
  })

  it('角色那步先于要点提交、作者随后改了关系：要点补上后旧建议不出现，作者的改动不被覆盖', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    reviseAuthorRelation('同门')

    saveNotes(draftId, '第8章摘要')

    expect(pending()).toEqual([])
    expect(authorRows()).toEqual(['同门'])
  })

  it.each([
    ['改关系、补要点、再重跑角色那步', 'notes-then-rerun'],
    ['改关系、重跑角色那步、再补要点', 'rerun-then-notes'],
  ])('角色那步先于要点提交，作者随后改了关系，%s：旧建议都不出现', (_label, order) => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const extract = () => commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    extract()
    reviseAuthorRelation('同门')
    if (order === 'notes-then-rerun') { saveNotes(draftId, '第8章摘要'); extract() } else { extract(); saveNotes(draftId, '第8章摘要') }

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

  it('角色那步先于要点提交，作者随后调换关系方向：要点补上后不出现待确认项，时间线不多出事件', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    reviseAuthorRelation('师徒', SHEN, LIN)
    const before = eventCount()

    saveNotes(draftId, '第8章摘要')

    expect(eventCount()).toBe(before)
    expect(pending()).toEqual([])
  })

  it.each([
    ['先林后沈', [relationChange('恩断义绝', BREAK_UP), relationChange('势不两立', BREAK_UP, SHEN, LIN)]],
    ['先沈后林', [relationChange('势不两立', BREAK_UP, SHEN, LIN), relationChange('恩断义绝', BREAK_UP)]],
  ])('作者两个方向都写了，模型两个方向给出不同新值（%s）：角色那步先于要点时，补回后同一对只有一张卡，与要点先到时一样', (_label, relations) => {
    const cardsAfter = (notesFirst: boolean) => {
      openProject()
      authorRelation('同门')
      authorRelation('同门', SHEN, LIN)
      const draftId = notesFirst ? finalizeNew(8, CHAPTER_EIGHT) : finalizeWithoutNotes(8, CHAPTER_EIGHT)
      commitModelOutput(draftId, { updates: [], relations })
      if (!notesFirst) saveNotes(draftId, '第8章摘要')
      const cards = pending().map(({ sourceId, targetId, value }) => ({ sourceId, targetId, value }))
      closeProjectDatabase()
      return cards
    }
    const notesFirst = cardsAfter(true)

    expect(notesFirst).toHaveLength(1)
    expect(cardsAfter(false)).toEqual(notesFirst)
  })

  it('升级前写下的派生节点没有作者关系快照：要点补上时不补待确认项，也不报错', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const { source } = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
    const start = CHAPTER_EIGHT.indexOf(BREAK_UP)
    db().prepare(`INSERT INTO character_continuity_events(event_id,subject_id,subject_name,target_id,target_name,aspect,value,effective_chapter,provenance_json,draft_id,evidence_json)
      VALUES(?,?,'林岚',?,'沈砚','relation','恩断义绝',8,?,?,?)`).run(`derived:${source.finalizationId}:relation:legacy`, LIN, SHEN,
      JSON.stringify({ kind: 'derived', source }), draftId,
      JSON.stringify({ quote: { text: BREAK_UP, start, end: start + BREAK_UP.length }, relationshipId: derivedRelationSeries(LIN, SHEN), seq: 1 }))
    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])

    expect(() => saveNotes(draftId, '第8章摘要')).not.toThrow()
    expect(pending()).toEqual([])
  })

  it('抽取开始后、提交前作者改了关系：要点补上后旧结论不对着作者新写的关系出现', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    const context = SummaryRepository.readFinalizedCharacterContext(draftId, scope, db())
    reviseAuthorRelation('同门')
    SummaryRepository.commitFinalizedCharacterStates(context, parseFinalizedCharacterStateResponse(JSON.stringify(
      { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] }), context), db())
    expect(derivedNodes().map(node => node.value)).toEqual(['恩断义绝'])

    saveNotes(draftId, '第8章摘要')

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

    expect(derivedNodes()).toEqual([])
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

  it('同一份定稿重跑把关系改回作者设定后要点才补上：撤下的旧值不复活', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeWithoutNotes(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    commitModelOutput(draftId, { updates: [], relations: [relationChange('师徒', BREAK_UP)] })
    const before = derivedNodes().length
    saveNotes(draftId, '第8章摘要')
    expect(derivedNodes()).toHaveLength(before)
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

  it('模型重述作者已有的关系不算变化，不记节点也不提示', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(draftId, { updates: [], relations: [relationChange('师徒', BREAK_UP)] })

    expect(derivedNodes()).toEqual([])
    expect(pending()).toEqual([])
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

  it('同一对角色后续章重述同样的派生关系不算变化，不产生新节点', () => {
    openProject()
    authorRelation('师徒')
    const eight = finalizeNew(8, CHAPTER_EIGHT)
    commitModelOutput(eight, { updates: [], relations: [relationChange('恩断义绝', BREAK_UP)] })
    decide('decline')
    const nine = finalizeNew(9, '第九章：沈砚望着断裂的信物，一言不发。')
    commitModelOutput(nine, { updates: [], relations: [relationChange('恩断义绝', '沈砚望着断裂的信物')] })

    expect(derivedNodes()).toHaveLength(1)
    expect(pending()).toEqual([])
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

describe('采用后的时间线只留一行', () => {
  const timeline = (characterId = LIN) => characterTimeline(readCharacterContinuityNodes(db(), characterId))
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

  it('作者设定在反向时，采用后也在作者写的那一边合成一行', () => {
    openProject()
    authorRelation('素不相识', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('彼此信任', BREAK_UP)] })
    decide('accept')

    expect(chapterChanges(8, SHEN)).toHaveLength(1)
    expect(chapterChanges(8, SHEN)[0]).toMatchObject({ source: 'author', value: '彼此信任', replaced: ['素不相识'], node: { quote: { text: BREAK_UP } } })
  })
})

describe('关系比对查两个方向', () => {
  const allAuthorRows = () => db().prepare('SELECT source_character_id AS source,target_character_id AS target,relation FROM character_relationships ORDER BY relation').all()
  const allDerived = () => readCharacterContinuityNodes(db()).filter(node => node.provenance.kind === 'derived')

  it('作者只写反向且不一致：出现一条待确认项，采用后换掉作者写的那一行', () => {
    openProject()
    authorRelation('素不相识', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('彼此信任', BREAK_UP)] })

    expect(pending()).toMatchObject([{ value: '彼此信任', authorRelations: ['素不相识'], evidence: { text: BREAK_UP } }])
    decide('accept')
    expect(pending()).toEqual([])
    expect(allAuthorRows()).toEqual([{ source: SHEN, target: LIN, relation: '彼此信任' }])
  })

  it('模型反写作者已有的关系不算变化，不记节点也不提示', () => {
    openProject()
    authorRelation('师徒', SHEN, LIN)
    commitModelOutput(finalizeNew(8, CHAPTER_EIGHT), { updates: [], relations: [relationChange('师徒', BREAK_UP)] })

    expect(allDerived()).toEqual([])
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

  it('作者关系在定稿后处理途中被改，不算身份变化', () => {
    openProject()
    authorRelation('师徒')
    const draftId = finalizeNew(8, CHAPTER_EIGHT)
    const { context } = prompt(draftId, 'zh-CN')
    db().prepare("UPDATE character_relationships SET relation='宿敌' WHERE relationship_id='author-line'").run()

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
        expectedDraft: { chapterNumber: 9, version: 1, status: 'draft', contentHash: sha256(body) } }, PROJECT_ID)
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
