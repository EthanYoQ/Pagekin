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
const reply = (text: string): Dispatch => async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason: 'stop', usage: null } }
const finding = (over: Record<string, unknown> = {}) => ({ chapterNumber: 2, eventIds: ['e1'], issue: '蓝图写两人并肩作战，节点说两人已决裂。', suggestion: '改成对峙。', ...over })

function fixture(dispatch: Dispatch, { windowTokens = 32768, nodes = true, longKeyEvents = '沈舟与林岚并肩作战' } = {}) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/graph-owner-tests'); fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, '项目-')); prepareCanonicalStorageFixture(root)
  const file = path.join(root, '.ai-novel', 'project.db'); let db = new Database(file); vi.mocked(getProjectDb).mockReturnValue(db)
  db.exec("INSERT INTO project_core(id,project_name,total_chapters,synopsis) VALUES('main','铜钥匙',10,'寻找北塔'); INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'雨夜','发现铜钥匙'); INSERT INTO contents(id,body) VALUES(1,'原稿'); INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
  const prose = '林岚找到铜钥匙。'
  FinalizationRepository.commit({ finalizationId: '定稿1', draftId: 1, chapterNumber: 1, chapterTitle: '雨夜', content: prose, contentHash: textHash(prose), contentRevision: 1, targetFileName: '第一章.txt' })
  const blueprint = db.prepare('INSERT INTO blueprints(chapter_number,title,key_events) VALUES(?,?,?)')
  blueprint.run(2, '并肩', longKeyEvents); blueprint.run(3, '北塔', longKeyEvents)
  if (nodes) db.prepare(`INSERT INTO character_continuity_events(event_id,subject_id,subject_name,target_id,target_name,aspect,value,effective_chapter,provenance_json,draft_id,evidence_json)
    VALUES('relation:add:关系1','甲','林岚','乙','沈舟','relation','决裂',1,?,NULL,?)`).run(JSON.stringify({ kind: 'author', operationId: '操作1' }), JSON.stringify({ seq: 1, relationshipId: '关系1' }))
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'fixture-only', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 1024, purposes: ['generation'], capabilities: { contextWindowTokens: windowTokens, maxOutputTokens: 1024, reasoning: false, structuredOutput: true, usage: true } }
  const spy = vi.fn<Dispatch>(dispatch)
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({ key, systemRole: '图谱编辑', content: '合成模板' }) }
  const make = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, receipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt: receipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, receipt) => rebuildGenerationSourceBinding(deps, previous, epoch, receipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  const owner = make('epoch-1'); const owners = [owner]
  cleanup.push(() => { owners.forEach(item => item.suspendForProjectClose()); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { owner, get db() { return db }, spy,
    begin: () => owner.beginGraphGeneration({ input: { kind: 'continuity' }, modelId: 'synthetic', uiActionNonce: '检查动作' }),
    reopen: () => { owners.at(-1)!.suspendForProjectClose(); db.close(); db = new Database(file); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); const next = make('epoch-2'); owners.push(next); return next } }
}

it('一次请求，结论的依据是冻结的真实节点，已定稿章不进范围', async () => {
  const f = fixture(reply(JSON.stringify({ findings: [finding()] })))
  const begun = f.begin()
  expect(begun.view.operation).toBe('blueprint-continuity-check')
  expect(begun.context).toMatchObject({ kind: 'continuity', chapters: [{ chapterNumber: 2 }, { chapterNumber: 3 }] })
  await f.owner.executeGraphGeneration({ handle: begun.view.handle })
  expect(f.spy).toHaveBeenCalledTimes(1)
  const request = f.spy.mock.calls[0]![0] as { task: { messages: { content: string }[] } }
  expect(request.task.messages[1]!.content).toContain('沈舟与林岚并肩作战')
  expect(request.task.messages[1]!.content).toContain('决裂')
  expect(request.task.messages[1]!.content).not.toContain('发现铜钥匙')
  const read = f.owner.readGraphGeneration({ handle: begun.view.handle })
  expect(read.sourceStatus).toBe('current')
  expect(read.result).toEqual({ kind: 'continuity', checkedThroughChapter: 3, droppedFindings: 0,
    findings: [{ chapterNumber: 2, eventIds: ['relation:add:关系1'], issue: finding().issue, suggestion: finding().suggestion }] })
})

it('编造节点或范围外的章只丢那一条，运行记录有计数', async () => {
  const f = fixture(reply(JSON.stringify({ findings: [finding(), finding({ eventIds: ['e99'] }), finding({ chapterNumber: 1 }), finding({ chapterNumber: 3, eventIds: [] })] })))
  const { handle } = f.begin().view
  await f.owner.executeGraphGeneration({ handle })
  const result = f.owner.readGraphGeneration({ handle }).result
  expect(result).toMatchObject({ kind: 'continuity', droppedFindings: 3 })
  expect(result?.kind === 'continuity' && result.findings.map(item => item.chapterNumber)).toEqual([2])
})

it('模型输出不是 JSON：没有结果也没有效果，原文留在运行记录，不重发', async () => {
  const f = fixture(reply('这不是JSON'))
  const { handle } = f.begin().view
  await f.owner.executeGraphGeneration({ handle })
  const read = f.reopen().readGraphGeneration({ handle })
  expect(read.result).toBeUndefined()
  expect(read.attemptCount).toBe(1)
  expect(read.effects).toEqual([])
  expect((read.view.candidates ?? read.view.artifacts)[0]?.text).toBe('这不是JSON')
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('重开后取回最近一次读得出结论的运行，读不出的跳过', async () => {
  let text = JSON.stringify({ findings: [finding()] })
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason: 'stop', usage: null } })
  expect(f.owner.readLatestContinuityCheck()).toBeNull()
  await f.owner.executeGraphGeneration({ handle: f.begin().view.handle })
  text = '坏结果'
  const second = f.owner.beginGraphGeneration({ input: { kind: 'continuity' }, modelId: 'synthetic', uiActionNonce: '第二次' })
  await f.owner.executeGraphGeneration({ handle: second.view.handle })
  const latest = f.reopen().readLatestContinuityCheck()
  expect(latest?.result).toMatchObject({ kind: 'continuity', findings: [{ chapterNumber: 2 }] })
  expect(latest?.view.handle.runId).not.toBe(second.view.handle.runId)
  expect(f.spy).toHaveBeenCalledTimes(2)
})

it('成功之后连着三次读不出来，重开仍取回那次成功的结论', async () => {
  let text = JSON.stringify({ findings: [finding()] })
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason: 'stop', usage: null } })
  const first = f.begin()
  await f.owner.executeGraphGeneration({ handle: first.view.handle })
  text = '坏结果'
  for (const nonce of ['二', '三', '四']) {
    const next = f.owner.beginGraphGeneration({ input: { kind: 'continuity' }, modelId: 'synthetic', uiActionNonce: nonce })
    await f.owner.executeGraphGeneration({ handle: next.view.handle })
  }
  expect(f.spy).toHaveBeenCalledTimes(4)
  expect(f.reopen().readLatestContinuityCheck()?.view.handle.runId).toBe(first.view.handle.runId)
})

it('最新一次运行记录读取时抛错：跳过它，取回更早那次的结论', async () => {
  const f = fixture(reply(JSON.stringify({ findings: [finding()] })))
  const first = f.begin()
  await f.owner.executeGraphGeneration({ handle: first.view.handle })
  const broken = f.owner.beginGraphGeneration({ input: { kind: 'continuity' }, modelId: 'synthetic', uiActionNonce: '损坏' })
  await f.owner.executeGraphGeneration({ handle: broken.view.handle })
  const reopened = f.reopen()
  f.db.prepare(`UPDATE generation_runs SET binding_json=json_set(binding_json,'$.sourceManifest.graphGenerationContextHash','0') WHERE run_id=?`).run(broken.view.handle.runId)
  expect(() => reopened.readGraphGeneration({ handle: broken.view.handle })).toThrow()
  expect(reopened.readLatestContinuityCheck()?.view.handle.runId).toBe(first.view.handle.runId)
})

it('运行中蓝图被改：sourceStatus 变 conflict', async () => {
  const f = fixture(reply(JSON.stringify({ findings: [finding()] })))
  const { handle } = f.begin().view
  await f.owner.executeGraphGeneration({ handle })
  f.db.prepare('UPDATE blueprints SET key_events=? WHERE chapter_number=3').run('改过的事件')
  expect(f.owner.readGraphGeneration({ handle }).sourceStatus).toBe('conflict')
})

it('只读检查不能确认写入', async () => {
  const f = fixture(reply(JSON.stringify({ findings: [finding()] })))
  const { handle } = f.begin().view
  await f.owner.executeGraphGeneration({ handle })
  const artifact = f.owner.readGraphGeneration({ handle }).artifact!
  expect(() => f.owner.confirmGraphGeneration({ handle, artifact, index: 0 })).toThrow('GENERATION_GRAPH_SELECTION_INVALID')
})

it('没有时间线节点时不建运行、不发请求', () => {
  const f = fixture(reply('{}'), { nodes: false })
  expect(() => f.begin()).toThrow('GENERATION_GRAPH_CONTINUITY_TIMELINE_REQUIRED')
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  expect(f.spy).not.toHaveBeenCalled()
})

it('窗口放不下时按章截断，单章完整，重读不因窗口变成 conflict', () => {
  const longKeyEvents = '沈舟与林岚并肩作战。'.repeat(25)
  const f = fixture(reply('{}'), { windowTokens: 3000, longKeyEvents })
  const begun = f.begin()
  expect(begun.context).toMatchObject({ kind: 'continuity', chapters: [{ chapterNumber: 2, keyEvents: longKeyEvents }] })
  expect(f.owner.readGraphGeneration({ handle: begun.view.handle }).sourceStatus).toBe('current')
})

it('运行中退出：重启后没有半截结果，也不自动重发', async () => {
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: '{"findings":[' }); throw new Error('合成网络中断') })
  const { handle } = f.begin().view
  await f.owner.executeGraphGeneration({ handle })
  const read = f.reopen().readGraphGeneration({ handle })
  expect(read.result).toBeUndefined()
  expect(f.spy).toHaveBeenCalledTimes(1)
})
