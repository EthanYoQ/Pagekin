import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import { getProjectDb } from '../../database'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { textHash } from '../../repositories/generation-run-repository'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

vi.mock('../../database', async original => ({ ...await original<typeof import('../../database')>(), getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })

type Dispatch = GenerationRunServiceDependencies['dispatch']
const ORIGINAL = '沈舟与林岚并肩作战'
const FIXED = '沈舟与林岚在城门对峙'
const suggestion = (over: Record<string, unknown> = {}) => ({ chapterNumber: 2, eventIds: ['e1'], issue: '两人已决裂，蓝图却写并肩作战。', patch: { keyEvents: FIXED }, ...over })
const reply = (body: unknown) => JSON.stringify({ suggestions: body })

function fixture({ postprocess = 'done' }: { postprocess?: 'done' | 'running' | 'failed' | 'none' } = {}) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/graph-owner-tests'); fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, '项目-')); prepareCanonicalStorageFixture(root)
  const file = path.join(root, '.ai-novel', 'project.db'); let db = new Database(file); vi.mocked(getProjectDb).mockReturnValue(db)
  db.exec("INSERT INTO project_core(id,project_name,total_chapters,synopsis) VALUES('main','铜钥匙',10,'寻找北塔'); INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'雨夜','发现铜钥匙'); INSERT INTO contents(id,body) VALUES(1,'原稿'); INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
  const prose = '林岚找到铜钥匙，与沈舟决裂。'
  FinalizationRepository.commit({ finalizationId: '定稿1', draftId: 1, chapterNumber: 1, chapterTitle: '雨夜', content: prose, contentHash: textHash(prose), contentRevision: 1, targetFileName: '第一章.txt' })
  if (postprocess !== 'none') {
    db.prepare("INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id,source_label) VALUES('后处理1','chapter_finalize','finalization:定稿1','第一章')").run()
    const step = db.prepare("INSERT INTO post_process_steps(run_id,step_key,label,critical,ok,error_msg,attempt_count) VALUES('后处理1',?,?,0,?,?,?)")
    for (const key of ['kb_import', 'chapter_notes']) step.run(key, key, 1, '', 1)
    if (postprocess === 'done') step.run('character_cards', 'character_cards', 1, '', 1)
    if (postprocess === 'running') step.run('character_cards', 'character_cards', 0, '', 0)
    if (postprocess === 'failed') step.run('character_cards', 'character_cards', 0, 'GENERATION_FAILED', 2)
  }
  const blueprint = db.prepare('INSERT INTO blueprints(chapter_number,title,key_events,notes) VALUES(?,?,?,?)')
  blueprint.run(2, '并肩', ORIGINAL, '作者备注'); blueprint.run(3, '北塔', '林岚独自登塔', '')
  db.prepare(`INSERT INTO character_continuity_events(event_id,subject_id,subject_name,target_id,target_name,aspect,value,effective_chapter,provenance_json,draft_id,evidence_json)
    VALUES('relation:add:关系1','甲','林岚','乙','沈舟','relation','决裂',1,?,NULL,?)`).run(JSON.stringify({ kind: 'author', operationId: '操作1' }), JSON.stringify({ seq: 1, relationshipId: '关系1' }))
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'fixture-only', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 1024, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 1024, reasoning: false, structuredOutput: true, usage: true } }
  let text = reply([suggestion()])
  const spy = vi.fn<Dispatch>(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason: 'stop', usage: null } })
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({ key, systemRole: '图谱编辑', content: '合成模板' }) }
  const make = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, receipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt: receipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, receipt) => rebuildGenerationSourceBinding(deps, previous, epoch, receipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  const owners = [make('epoch-1')]
  const owner = () => owners.at(-1)!
  cleanup.push(() => { owners.forEach(item => item.suspendForProjectClose()); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  let nonce = 0
  return {
    owner, spy, get db() { return db },
    reply: (next: string) => { text = next },
    check: async () => {
      const begun = owner().beginGraphGeneration({ input: { kind: 'continuity-suggest', finalizationId: '定稿1' }, modelId: 'synthetic', uiActionNonce: `检查${++nonce}` })
      await owner().executeGraphGeneration({ handle: begun.view.handle })
      return begun
    },
    list: () => owner().listContinuitySuggestions({ finalizationId: '定稿1' }),
    decide: (suggestionId: string, decision: 'accept' | 'reject') => owner().decideContinuitySuggestion({ suggestionId, decision }),
    keyEvents: (chapter = 2) => db.prepare('SELECT key_events FROM blueprints WHERE chapter_number=?').pluck().get(chapter),
    rows: () => db.prepare('SELECT chapter_number AS chapterNumber,status FROM blueprint_continuity_suggestions ORDER BY rowid').all(),
    reopen: () => { owner().suspendForProjectClose(); db.close(); db = new Database(file); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); owners.push(make('epoch-2')) },
  }
}

it('一次请求只看替换章之后未定稿的蓝图，每章一条建议，依据是冻结的节点', async () => {
  const f = fixture()
  const begun = await f.check()
  expect(begun.view.operation).toBe('blueprint-continuity-suggest')
  expect(begun.context).toMatchObject({ kind: 'continuity-suggest', chapters: [{ chapterNumber: 2 }, { chapterNumber: 3 }] })
  expect(f.spy).toHaveBeenCalledTimes(1)
  const list = f.list()
  expect(list).toMatchObject({ checkedChapters: [2, 3], droppedSuggestions: 0, suggestions: [{
    chapterNumber: 2, status: 'pending', issues: [suggestion().issue], before: { keyEvents: ORIGINAL }, after: { keyEvents: FIXED },
    basis: [{ eventId: 'relation:add:关系1', subjectName: '林岚', targetName: '沈舟', value: '决裂' }],
  }] })
  expect(f.rows()).toEqual([{ chapterNumber: 2, status: 'pending' }])
})

it('后处理还在跑：不建运行、不发请求', () => {
  const f = fixture({ postprocess: 'running' })
  expect(() => f.owner().beginGraphGeneration({ input: { kind: 'continuity-suggest', finalizationId: '定稿1' }, modelId: 'synthetic', uiActionNonce: '早了' }))
    .toThrow('GENERATION_GRAPH_POSTPROCESS_PENDING')
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  expect(f.spy).not.toHaveBeenCalled()
})

it.each([['角色状态那步失败', 'failed'], ['没有后处理记录', 'none']] as const)('%s：照样能检查，出建议', async (_, postprocess) => {
  const f = fixture({ postprocess })
  await f.check()
  expect(f.list()!.suggestions.map(item => item.chapterNumber)).toEqual([2])
})

it('编造节点、越界章号、白名单外字段、空改动只丢那一条，运行记录有计数', async () => {
  const f = fixture()
  f.reply(reply([
    suggestion(),
    suggestion({ chapterNumber: 3, eventIds: ['e9'] }),
    suggestion({ chapterNumber: 1 }),
    suggestion({ chapterNumber: 3, patch: { notes: '改备注' } }),
    suggestion({ chapterNumber: 3, patch: {} }),
    suggestion({ chapterNumber: 3, patch: { keyEvents: '林岚独自登塔' } }),
  ]))
  const { view } = await f.check()
  expect(f.owner().readGraphGeneration({ handle: view.handle }).result).toMatchObject({ kind: 'continuity-suggest', droppedSuggestions: 5 })
  expect(f.list()?.suggestions.map(item => item.chapterNumber)).toEqual([2])
})

it('同一章两条改同一字段：整章丢掉；改不同字段：合成一条', async () => {
  const f = fixture()
  f.reply(reply([suggestion(), suggestion({ patch: { keyEvents: '另一种改法' } }), suggestion({ chapterNumber: 3, patch: { title: '独行' } }), suggestion({ chapterNumber: 3, issue: '第二处', patch: { purpose: '独自查案' } })]))
  await f.check()
  const list = f.list()!
  expect(list.droppedSuggestions).toBe(2)
  expect(list.suggestions).toMatchObject([{ chapterNumber: 3, issues: [suggestion().issue, '第二处'], after: { title: '独行', purpose: '独自查案' } }])
})

it('模型输出不是 JSON：不写建议表', async () => {
  const f = fixture()
  f.reply('这不是JSON')
  await f.check()
  expect(f.list()).toBeNull()
  expect(f.rows()).toEqual([])
})

it('接受：蓝图按对比里的新文字写入，其他字段和备注不动；重复点不再改', async () => {
  const f = fixture()
  await f.check()
  const [card] = f.list()!.suggestions
  expect(f.decide(card!.suggestionId, 'accept')).toEqual({ status: 'accepted' })
  expect(f.keyEvents()).toBe(card!.after.keyEvents)
  expect(f.db.prepare('SELECT title,notes FROM blueprints WHERE chapter_number=2').get()).toEqual({ title: '并肩', notes: '作者备注' })
  expect(JSON.parse(f.db.prepare('SELECT decision_receipt_json FROM blueprint_continuity_suggestions').pluck().get() as string))
    .toEqual({ before: { keyEvents: ORIGINAL }, after: { keyEvents: FIXED } })
  f.db.prepare('UPDATE blueprints SET key_events=? WHERE chapter_number=2').run('作者又改了')
  expect(f.decide(card!.suggestionId, 'accept')).toEqual({ status: 'accepted' })
  expect(f.keyEvents()).toBe('作者又改了')
})

it('建议生成后作者改过这章蓝图：不写入，这条作废', async () => {
  const f = fixture()
  await f.check()
  const [card] = f.list()!.suggestions
  f.db.prepare('UPDATE blueprints SET key_events=? WHERE chapter_number=2').run('作者自己改的')
  expect(f.decide(card!.suggestionId, 'accept')).toEqual({ status: 'stale' })
  expect(f.keyEvents()).toBe('作者自己改的')
  expect(f.list()!.suggestions[0]!.status).toBe('stale')
})

it('不用：蓝图不变；再检查一次是新的一条，不把不用的那条改回待处理', async () => {
  const f = fixture()
  await f.check()
  const first = f.list()!.suggestions[0]!
  expect(f.decide(first.suggestionId, 'reject')).toEqual({ status: 'rejected' })
  expect(f.keyEvents()).toBe(ORIGINAL)
  await f.check()
  const second = f.list()!.suggestions[0]!
  expect(second.suggestionId).not.toBe(first.suggestionId)
  expect(second.status).toBe('pending')
  expect(f.rows()).toEqual([{ chapterNumber: 2, status: 'rejected' }, { chapterNumber: 2, status: 'pending' }])
})

it('同一替换重跑：上一轮待处理的作废，只列新一轮；新一轮没建议也一样', async () => {
  const f = fixture()
  await f.check()
  f.list()
  f.reply(reply([suggestion({ chapterNumber: 3, patch: { title: '独行' } })]))
  await f.check()
  expect(f.list()!.suggestions.map(item => item.chapterNumber)).toEqual([3])
  expect(f.rows()).toEqual([{ chapterNumber: 2, status: 'stale' }, { chapterNumber: 3, status: 'pending' }])
  f.reply(reply([]))
  await f.check()
  expect(f.list()).toMatchObject({ suggestions: [], checkedChapters: [2, 3] })
  expect(f.rows()).toEqual([{ chapterNumber: 2, status: 'stale' }, { chapterNumber: 3, status: 'stale' }])
})

it('运行完成但还没落表就重启：重开后补齐同一份，重复读取不多写', async () => {
  const f = fixture()
  await f.check()
  f.reopen()
  expect(f.rows()).toEqual([])
  expect(f.list()!.suggestions).toHaveLength(1)
  f.list()
  expect(f.rows()).toEqual([{ chapterNumber: 2, status: 'pending' }])
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('这次替换的定稿记录删掉后，建议跟着删除', async () => {
  const f = fixture()
  await f.check()
  f.list()
  f.db.pragma('foreign_keys = ON')
  f.db.prepare("DELETE FROM finalization_outbox_all WHERE finalization_id='定稿1'").run()
  expect(f.rows()).toEqual([])
})

it('替换章进了回收站：不再列出建议，接受也不写蓝图', async () => {
  const f = fixture()
  await f.check()
  const [card] = f.list()!.suggestions
  f.db.prepare("UPDATE drafts_all SET status='deleted',deletion_id='删除1',deleted_from_status='finalized',deleted_at='2026-11-11' WHERE id=1").run()
  expect(f.list()).toBeNull()
  expect(f.decide(card!.suggestionId, 'accept')).toEqual({ status: 'stale' })
  expect(f.keyEvents()).toBe(ORIGINAL)
})

it('替换章又被新的定稿取代：接受判作废，不写蓝图', async () => {
  const f = fixture()
  await f.check()
  const [card] = f.list()!.suggestions
  f.db.exec("INSERT INTO contents(id,body) VALUES(2,'又一稿'); INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(2,1,2,'draft',2,3)")
  const prose = '林岚与沈舟和好。'
  FinalizationRepository.demoteToSuperseded(f.db, [1])
  FinalizationRepository.commit({ finalizationId: '定稿2', draftId: 2, chapterNumber: 1, chapterTitle: '雨夜', content: prose, contentHash: textHash(prose), contentRevision: 1, targetFileName: '第一章.txt' })
  expect(f.decide(card!.suggestionId, 'accept')).toEqual({ status: 'stale' })
  expect(f.keyEvents()).toBe(ORIGINAL)
})
