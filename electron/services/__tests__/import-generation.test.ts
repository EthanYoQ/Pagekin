import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { projectAccess } from '../project-access'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getProjectDb, getCurrentProjectPath } from '../../database'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { admitGenerationLedger } from '../../repositories/generation-ledger-admission'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/import-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  const project = projectAccess.probeExistingProject(root)
  if (project.kind !== 'manifest') throw new Error('fixture project identity missing')
  const projectId = project.projectId
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  let db = new Database(path.join(root, '.ai-novel', 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)

  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
  db.exec("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => { options.onVisible({ kind: 'delta', text: '我会检查。<tool_call>{"name":"read_project_state","arguments":{}}</tool_call>' }); return { finishReason: 'stop', usage: null } }))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({key,content:'冻结的合成提示词',systemRole:'写作助手'}) }
  const makeOwner = (epoch: string) => createMainGenerationOwner({ database: db, projectId, epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId, epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  const owner = makeOwner('epoch-1')
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const reopenStorage = () => { owner.suspendForProjectClose(); db.close(); db = new Database(path.join(root, '.ai-novel', 'project.db')); admitGenerationLedger(db); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); const next=makeOwner('epoch-2'); cleanup.unshift(()=>next.suspendForProjectClose()); return next }
  const content='第一章 海港\r\n林岚在港口找到了信。'
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
  const chapterOf=(text:string)=>({number:1,title:'海港',content:text,contentSize:Buffer.byteLength(text),contentFingerprint:hash(text)})
  const importAtGlobal=(runId:string,sourceFingerprint:string,text=content)=>{
    const chapter=chapterOf(text)
    ImportRunRepository.prepare({runId,purpose:'reference',sourceFingerprint,locale:'zh-CN',sourceDisplay:[{displayName:'参考小说.txt',mediaType:'text/plain',size:chapter.contentSize}],chapters:[chapter]})
    const execution=ImportRunRepository.startOrResume(runId,'合成执行器').execution
    const number=db.prepare('SELECT chapter_number FROM import_run_chapters WHERE run_id=?').pluck().get(runId) as number
    const binding=ImportRunRepository.resolveReferenceImportAuthority(runId,execution,number)
    const documentId=hash(`reference-import:${binding.stableKey}`)
    db.prepare("INSERT INTO import_reference_documents(document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state) VALUES(?,?,?,?,1,'reference','committed')").run(documentId,hash(binding.stableKey),binding.contentFingerprint,hash('合成块'))
    ImportRunRepository.commitReferenceImportReceipt(runId,execution,number,documentId)
    ImportRunRepository.completeBatch(runId,'knowledge',createImportRunChapterBatchCheckpointId([{...chapter,number}]),execution)
    ImportRunRepository.advanceStage(runId,'knowledge','global',execution)
    const slot={runId,stage:'global' as const,batchId:'done'}
    const selection:BeginGenerationRequest={operation:'import-global-facts',uiActionNonce:`首次导入:${runId}`,modelId:model.id,promptKeys:['infer_novel_config_with_vectors','infer_novel_config'],skillStages:['planning'],selectedDraftIds:[],selectedFinalizedDraftIds:[],output:'structured-data',importSlot:slot,importExecution:{owner:execution.owner,epoch:execution.epoch}}
    return {slot,selection,execution}
  }
  const {slot,selection,execution}=importAtGlobal('导入任务','a'.repeat(64))
  const batchId=createImportRunChapterBatchCheckpointId([chapterOf(content)])
  return {get db(){return db},owner,spy,reopenStorage,selection,slot,content,execution,importAtGlobal,batchId}
}

import { createHash } from 'node:crypto'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
const task={purpose:'import-global-facts',output:'structured-data' as const,messages:[{role:'user' as const,content:'归纳参考小说事实'}]}

it('freezes manifest-wide counts together when only one overlapping-import chapter is new', () => {
  const f = fixture()
  f.db.exec('UPDATE import_runs SET manifest_chapter_count=4,manifest_word_count=3200,total_chapters=1')
  f.owner.begin(f.selection)
  const frozen = f.owner.readImportGeneration(f.slot)!.frozenContext
  expect(frozen).toMatchObject({ totalChapters: 4, totalWords: 3200 })
  expect(frozen.chapters).toHaveLength(1)
  expect(f.spy).not.toHaveBeenCalled()
})

it('ADR-0030 导入运行的绑定被封存后，同槽位不能另开新运行',()=>{
 const f=fixture()
 const first=f.owner.begin(f.selection)
 vi.spyOn(console,'warn').mockImplementation(()=>{})
 f.db.prepare("UPDATE generation_runs SET binding_json='{坏' WHERE run_id=?").run(first.handle.runId)
 admitGenerationLedger(f.db)
 expect(()=>f.owner.begin({...f.selection,uiActionNonce:'封存后再点'})).toThrow('GENERATION_LEDGER_UNREADABLE')
 expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(1)
})
it('ADR-0030 一次导入的运行被封存：同一次导入的其他阶段、批次仍被拒绝，别的导入照常开始',()=>{
 const f=fixture()
 const first=f.owner.begin(f.selection)
 vi.spyOn(console,'warn').mockImplementation(()=>{})
 f.db.prepare("UPDATE generation_runs SET binding_json='{坏' WHERE run_id=?").run(first.handle.runId)
 admitGenerationLedger(f.db)
 expect(()=>f.owner.readImportGeneration({runId:'导入任务',stage:'style',batchId:'done'})).toThrow('GENERATION_LEDGER_UNREADABLE')
 expect(()=>f.owner.readImportGeneration({runId:'导入任务',stage:'blueprints',batchId:f.batchId})).toThrow('GENERATION_LEDGER_UNREADABLE')
 f.db.prepare("UPDATE import_runs SET status='cancelled' WHERE id='导入任务'").run()
 const other=f.importAtGlobal('另一次导入','b'.repeat(64),'第一章 山城\r\n林岚在山城读完了信。')
 expect(f.owner.readImportGeneration(other.slot)).toBeNull()
 expect(f.owner.begin(other.selection).handle.rootActionId).not.toBe(first.handle.rootActionId)
})
it('ADR-0030 已知限制：封存的导入树从蓝图批次开的根，认不出属于哪次导入，别的导入也被拒绝',()=>{
 const f=fixture()
 f.db.prepare("UPDATE import_runs SET stage='blueprints' WHERE id='导入任务'").run()
 const first=f.owner.begin({...f.selection,operation:'import-blueprints',promptKeys:['infer_single_chapter_blueprint'],importSlot:{runId:'导入任务',stage:'blueprints',batchId:f.batchId}})
 vi.spyOn(console,'warn').mockImplementation(()=>{})
 f.db.prepare("UPDATE generation_runs SET binding_json='{坏' WHERE run_id=?").run(first.handle.runId)
 admitGenerationLedger(f.db)
 f.db.prepare("UPDATE import_runs SET status='cancelled' WHERE id='导入任务'").run()
 const other=f.importAtGlobal('另一次导入','b'.repeat(64),'第一章 山城\r\n林岚在山城读完了信。')
 expect(()=>f.owner.readImportGeneration(other.slot)).toThrow('GENERATION_LEDGER_UNREADABLE')
})
it('ADR-0030 同槽位第一条导入运行的 open_key 读不出：报槽位不明',()=>{
 const f=fixture()
 const first=f.owner.begin(f.selection)
 f.db.prepare("UPDATE generation_runs SET open_key='{坏' WHERE run_id=?").run(first.handle.runId)
 expect(()=>f.owner.readImportGeneration(f.slot)).toThrow('GENERATION_IMPORT_SLOT_AMBIGUOUS')
 expect(()=>f.reopenStorage().readImportGeneration(f.slot)).toThrow('GENERATION_IMPORT_SLOT_AMBIGUOUS')
})
it("#702 同槽位后面一条导入运行的点击号读得出但属于别的槽位：仍报槽位不明",()=>{
 const f=fixture()
 const first=f.owner.begin(f.selection)
 forgeSlotRetry(f.db, first.handle.runId, "import:另一个槽位")
 expect(()=>f.reopenStorage().readImportGeneration(f.slot)).toThrow("GENERATION_IMPORT_SLOT_AMBIGUOUS")
})
it('同slot不同nonce加入同run，并冻结实际manifest正文',()=>{
 const f=fixture(),first=f.owner.begin(f.selection),second=f.owner.begin({...f.selection,uiActionNonce:'另一次点击'})
 expect(second.handle).toEqual(first.handle)
 expect(f.owner.readImportGeneration(f.slot)).toMatchObject({modelId:'synthetic',frozenContext:{chapters:[{content:f.content}]}})
 expect(f.spy).not.toHaveBeenCalled()
})
it.each(['stage','authority','hash'] as const)('首次begin拒绝错误%s',kind=>{
 const f=fixture()
 if(kind==='hash') f.db.exec("UPDATE import_run_chapters SET content_snapshot='篡改正文'")
 const request={...f.selection,...(kind==='stage'?{operation:'analyze-writing-style'}:{}),...(kind==='authority'?{importExecution:{owner:'伪执行器',epoch:1}}:{})}
 expect(()=>f.owner.begin(request)).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})
it('ordinal0并发只派发一次，持久请求重开仍读原artifact和model',async()=>{
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve})
 const f=fixture(async(_r,o)=>{await pending;o.onVisible({kind:'delta',text:'{"genre":"玄幻"}'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 const first=f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task}),second=f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 release();const receipt=await first
 expect(await second).toEqual(receipt);expect(f.spy).toHaveBeenCalledTimes(1)
 const stored=JSON.parse(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get() as string)
 expect(stored.replayTask).toEqual(task)
 const next=f.reopenStorage()
 expect(next.readImportGeneration(f.slot)?.modelId).toBe('synthetic')
 const replay=await next.executeImportGeneration({handle,ordinal:0,task:{...task,messages:[{role:'user',content:'后来改变的请求'}]}})
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome).toMatchObject({status:receipt.outcome.status,content:receipt.outcome.content,finishReason:receipt.outcome.finishReason})
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it('ordinal gap拒绝，unknown重开不自动重发且预算保留',async()=>{
 const f=fixture(async()=>{throw new Error('合成发送结果未知')}),handle=f.owner.begin(f.selection).handle
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:1,task})).rejects.toThrow('GENERATION_IMPORT_ORDINAL_GAP')
 const receipt=await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 const next=f.reopenStorage()
 const replay=await next.executeImportGeneration({handle,ordinal:0,task})
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome.status).toBe(receipt.outcome.status)
 expect(replay.run.ledger?.physicalRequests).toBe(1)
 expect(next.readImportGeneration(f.slot)).toBeNull()
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each(['stage','authority'] as const)('已有slot不能用错误%s冒充合法加入',kind=>{
 const f=fixture();f.owner.begin(f.selection)
 const forged={...f.selection,uiActionNonce:'伪加入',...(kind==='stage'?{operation:'analyze-writing-style'}:{importExecution:{owner:'伪执行器',epoch:1}})}
 expect(()=>f.owner.begin(forged)).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})

it('持久replayTask被篡改时拒绝回读，不新增派发',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'{"genre":"玄幻"}'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 f.db.exec("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.replayTask.purpose','篡改请求')")
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})).rejects.toThrow('GENERATION_IMPORT_TASK_INVALID')
 expect(f.spy).toHaveBeenCalledTimes(1)
})

async function globalEffect(kind: 'unproven' | 'inference' | 'retried' | 'needless-retry' | 'endpoint' | 'forged' | 'dropped' | 'rejected-delta' = 'unproven') {
 const core={genre:'现实',subGenre:'冒险',targetAudience:'通用',totalChapters:1,wordsPerChapter:900,plotStructure:'three_act',narrativePov:'third_limited',goldenFinger:'无',globalGuidance:'克制',premise:'海港来信',coreOutline:'寻找来信者',worldSetting:'海港',protagonistProfile:'林岚',worldbuilding:'海港街巷',synopsis:'找到信件'}
 const card = {name:'林岚',role:'protagonist',gender:'未知',age:'18',appearance:'朴素',personality:'谨慎',background:'港口居民',abilities:'观察',motivation:'寻信',relationships:[] as { target: string; relation: string }[],arc:'成长',notes:'待确认'}
 const generated = ['林岚','苏绾','顾岩'].map((name, index) => ({ ...card, name, role: index ? 'supporting' : 'protagonist',
   currentState: { location:'海港',powerLevel:'普通',physicalState:'正常',mentalState:'警觉',keyItems:'信件',recentEvents:'寻信',updatedAtChapter:0 } }))
 if (kind !== 'unproven' && kind !== 'inference' && kind !== 'retried' && kind !== 'needless-retry' && kind !== 'forged') generated[0].relationships = [{ target:'苏绾', relation:'同乡' }, { target:'掌柜', relation:'雇主' }]
 const delta = { ...generated[1], name:'掌柜' }
 const original = JSON.stringify({ novelConfig:{ ...core, narrativePOV:core.narrativePov }, architectureFiles:{ premise:core.premise,worldbuilding:core.worldbuilding,synopsis:core.synopsis }, characterCards:generated })
 let output = kind === 'unproven' ? '{"facts":"合成"}' : original
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:output});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 let ordinal = 0
 if (kind === 'retried' || kind === 'needless-retry') {
   output = kind === 'retried' ? original.replace('},"architectureFiles"', ',"architectureFiles"') : original.slice(0, -1)
   await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:ordinal++,task:{ ...task, purpose:'import-inference' }})
   output = original
   await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:ordinal++,task:{ ...task, purpose:'import-inference:structured-syntax-repair' }})
 }
 await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:ordinal++,task:kind === 'unproven' ? task : { ...task, purpose:'import-inference' }})
 if (kind === 'endpoint' || kind === 'rejected-delta') {
   output = JSON.stringify({ characterCards: kind === 'endpoint' ? [delta] : [delta, { ...delta, name:'任意新增' }] })
   await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:1,task:{ ...task, purpose:'import-inference:endpoint-card-recovery' }})
 }
 const characterEntries = kind === 'unproven' ? [card] : structuredClone(kind === 'endpoint' ? [...generated,delta] : generated)
 if (kind === 'dropped' || kind === 'rejected-delta') characterEntries[0].relationships = [{ target:'苏绾', relation:'同乡' }]
 if (kind === 'forged') characterEntries[0].notes = 'renderer伪造的字段'
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'global',batchId:'done',effectKey:'global-facts',kind:'project-global-facts',payload:{operationId:"novel-import-global-导入任务",expectedRosterRevision:0,core,characterEntries,generationRunHandle:handle}},f.execution)
 const committed=ImportRunRepository.commitEffectReceipt(f.slot.runId,'global','done',f.execution,Date.now(),f.owner.assertImportGenerationSources)
 expect(committed.receipt.state).toBe('committed')
 expect(f.db.prepare('SELECT genre FROM project_core').pluck().get()).toBe('现实')
 ImportRunRepository.advanceStage(f.slot.runId,'global','style',f.execution)
 const styleSlot={...f.slot,stage:'style' as const}
 const style=f.owner.begin({...f.selection,operation:'analyze-writing-style',promptKeys:['analyze_writing_style'],skillStages:[],output:'visible-text',modelId:'后来不同模型',importSlot:styleSlot})
 expect(style.handle.rootActionId).toBe(handle.rootActionId)
 expect(f.owner.readImportGeneration(styleSlot)?.modelId).toBe('synthetic')
 await f.owner.executeImportGeneration({execution:f.execution,handle:style.handle,ordinal:0,task:{...task,output:'visible-text'}})
 return Object.assign(f,{style,styleSlot})
}
it.each(['inference', 'retried', 'endpoint', 'dropped', 'rejected-delta'] as const)('导入角色提议从持久%s产物恢复来源并经作者批准采用', async kind => {
 const f = await globalEffect(kind)
 const stored = f.db.prepare("SELECT proposal_id,raw_value FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").get() as { proposal_id: string; raw_value: string }
 const envelope = JSON.parse(stored.raw_value); envelope.proof.provenance = null
 const legacy = JSON.stringify(envelope)
 f.db.prepare('UPDATE character_identity_proposals SET raw_value=?,source_hash=? WHERE proposal_id=?').run(legacy, createHash('sha256').update(legacy).digest('hex'), stored.proposal_id)
 const [summary] = f.owner.characterProposals.listPendingFinalized()
 expect(summary.importOperationId).toBe('novel-import-global-导入任务')
 const batch = f.owner.characterProposals.readPendingFinalized(summary.proposalBatchId)
 expect(batch.source.kind).toBe('import')
 const approved = f.owner.characterProposals.approve({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
   operationId: '作者采用导入角色', selections: batch.items.map(item => ({ selectionKey: item.selectionKey, action: 'create' })) })
 expect(approved.created).toHaveLength(kind === 'endpoint' ? 4 : 3)
 expect(f.db.prepare('SELECT name,static_provenance FROM characters WHERE retired=0').get()).toMatchObject({ name: '林岚', static_provenance: expect.stringContaining('generated') })
 expect(f.owner.characterProposals.listPendingFinalized()).toEqual([])
})
it('待处理的导入角色提议带上导入用途与角色人数，供界面写成作者看得懂的标题', async () => {
 const f = await globalEffect('inference')
 expect(f.owner.characterProposals.listPendingFinalized()).toEqual([expect.objectContaining({
   importOperationId: 'novel-import-global-导入任务', importPurpose: 'reference', itemCount: 3 })])
 f.db.prepare("UPDATE import_runs SET purpose='author-manuscript' WHERE id='导入任务'").run()
 expect(f.owner.characterProposals.listPendingFinalized()).toEqual([expect.objectContaining({ importPurpose: 'author-manuscript', itemCount: 3 })])
})
it.each(['unproven', 'forged', 'needless-retry'] as const)('拒绝把%s导入payload当作生成角色来源', async kind => {
 const f = await globalEffect(kind)
 expect(f.owner.characterProposals.listPendingFinalized()).toEqual([])
 const id = f.db.prepare('SELECT proposal_id FROM character_identity_proposals').pluck().get() as string
 const batch = f.owner.characterProposals.read(id)
 expect(() => f.owner.characterProposals.approve({ proposalBatchId:id, expectedRevision:batch.revision, operationId:'伪造来源采用',
   selections:batch.items.map(item => ({ selectionKey:item.selectionKey, action:'create' })) })).toThrow('CHARACTER_PROPOSAL_PROVENANCE_REQUIRED')
 expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
})
it('真实global effect后style继承原root/model，prepared旧epoch重开直接guard提交',async()=>{
 const f=await globalEffect(),handle=f.style.handle
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'style',batchId:'done',effectKey:'writing-style',kind:'project-writing-style',payload:{writingStyle:'克制而具体',generationRunHandle:handle}},f.execution)
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:1,task:{...task,output:'visible-text'}})).rejects.toThrow('GENERATION_IMPORT_EFFECT_SEALED')
 const artifact=f.owner.read(handle).artifacts[0]!
 expect(()=>f.owner.discardCandidate(handle,artifact.artifactId)).toThrow('GENERATION_IMPORT_EFFECT_SEALED')
 const next=f.reopenStorage()
 const saved=ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),next.assertImportGenerationSources)
 expect(saved.receipt.state).toBe('committed')
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('克制而具体')
 f.db.exec("UPDATE project_core SET writing_style='作者后来修改'")
 const replay=ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),()=>{throw new Error('ACK不得重验来源')})
 expect(replay.receipt).toEqual(saved.receipt)
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('作者后来修改')
 expect(f.spy).toHaveBeenCalledTimes(2)
})
it('prepared style在来源改变后拒绝提交且不污染作者值',async()=>{
 const f=await globalEffect(),handle=f.style.handle
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'style',batchId:'done',effectKey:'writing-style',kind:'project-writing-style',payload:{writingStyle:'模型文风',generationRunHandle:handle}},f.execution)
 f.db.exec("UPDATE project_core SET writing_style='作者新文风'")
 expect(()=>ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),f.owner.assertImportGenerationSources)).toThrow()
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('作者新文风')
 expect(ImportRunRepository.getEffectReceipt(f.slot.runId,'style','done')?.state).toBe('prepared')
})

it('拒绝与导入stage不符的模板和输出合同',()=>{
 const f=fixture()
 expect(()=>f.owner.begin({...f.selection,promptKeys:['analyze_writing_style']})).toThrow()
 expect(()=>f.owner.begin({...f.selection,output:'visible-text'})).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})

it.each(['missing','expired'] as const)('新ordinal拒绝%s导入执行权限，零派发',async kind=>{
 const f=fixture(),handle=f.owner.begin(f.selection).handle
 if(kind==='expired') f.db.exec('UPDATE import_runs SET lease_expires_at=0')
 await expect(f.owner.executeImportGeneration({handle,ordinal:0,task,...(kind==='expired'?{execution:f.execution}:{})})).rejects.toThrow()
 expect(f.spy).not.toHaveBeenCalled()
 expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
})

it('ADR-0030 导入运行的绑定读不出：「这一阶段绑过生成」查不到它，提交效果仍要求生成句柄，带上它的句柄被拒绝',()=>{
 const f=fixture()
 const handle=f.owner.begin(f.selection).handle
 vi.spyOn(console,'warn').mockImplementation(()=>{})
 f.owner.suspendForProjectClose()
 f.db.prepare("UPDATE generation_runs SET binding_json='{坏' WHERE run_id=?").run(handle.runId)
 const next=f.reopenStorage()
 const effect=(payload:Record<string,unknown>)=>()=>ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'global',batchId:'done',effectKey:'global-facts',kind:'project-global-facts',
  payload:{operationId:'novel-import-global-导入任务',expectedRosterRevision:0,core:{},characterEntries:[],...payload}},f.execution,Date.now(),next.assertImportGenerationSources)
 expect(effect({})).toThrow('GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED')
 expect(effect({generationRunHandle:handle})).toThrow('GENERATION_LEDGER_UNREADABLE')
 expect(f.db.prepare('SELECT COUNT(*) FROM import_run_receipts').pluck().get()).toBe(0)
})

/** 照抄一条运行，open_key 里的点击号换成别的槽位：绑定的槽位不变，键仍读得出。 */
function forgeSlotRetry(db: import("better-sqlite3").Database, runId: string, nonce: string) {
  const columns = (db.prepare("SELECT name FROM pragma_table_info('generation_runs')").pluck().all() as string[]).filter(name => name !== "run_id" && name !== "open_key")
  const [click, root] = JSON.parse(db.prepare("SELECT open_key FROM generation_runs WHERE run_id=?").pluck().get(runId) as string) as [string, string]
  const parts = JSON.parse(click) as string[]
  parts[2] = nonce
  db.prepare(`INSERT INTO generation_runs(run_id,open_key,${columns.join(",")}) SELECT ?,?,${columns.join(",")} FROM generation_runs WHERE run_id=?`)
    .run(`${runId}-forged`, JSON.stringify([JSON.stringify(parts), root]), runId)
}
