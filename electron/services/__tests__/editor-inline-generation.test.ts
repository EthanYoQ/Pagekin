import { buildEditorInlineContext, editorInlineTask } from '../editor-inline-generation'
import { composePromptSystemRole, getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { editorInlineInsertsAfterSelection, type EditorInlineContext } from '../../../src/shared/editor-inline-generation'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, compareGenerationSourceBindings, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { getProjectDb, getCurrentProjectPath } from '../../database'
import { admitGenerationLedger } from '../../repositories/generation-ledger-admission'
import { damageLedger, enumerations, failingCalls, rootCount, type DamagedColumn } from './ledger-seal-fixture'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/editor-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  let db = new Database(path.join(root, '.ai-novel', 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)

  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
  db.exec("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
  let model: ModelProfile | null = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => { options.onVisible({ kind: 'delta', text: '我会检查。<tool_call>{"name":"read_project_state","arguments":{}}</tool_call>' }); return { finishReason: 'stop', usage: null } }))
  let templateBody='固定作者模板 {{edit_instruction}}：{{selected_text}}'
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({key,content:templateBody,systemRole:'写作助手'}) }
  const makeOwner = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  const owner = makeOwner('epoch-1')
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const reopenStorage = () => { owner.suspendForProjectClose(); db.close(); db = new Database(path.join(root, '.ai-novel', 'project.db')); admitGenerationLedger(db); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); const next=makeOwner('epoch-2'); cleanup.unshift(()=>next.suspendForProjectClose()); return next }
  return {get db(){return db},deps,owner,spy,reopenStorage,changeTemplate:()=>{templateBody='后来模板 {{selected_text}}'},removeModel:()=>{model=null},
    setContextWindow:(tokens:number)=>{model={...model!,capabilities:{...model!.capabilities!,contextWindowTokens:tokens}}},
    useLocalModelWithoutWindow:()=>{model={...model!,provider:'ollama',baseUrl:'http://127.0.0.1:11434/v1',apiKey:'',capabilities:{...model!.capabilities!,contextWindowTokens:null}}}}
}

import { createHash } from 'node:crypto'
const input={action:'refine' as const,documentText:'甲😀林岚\r\n乙',from:1,to:5,selectedText:'😀林岚'}
const request={input,modelId:'synthetic',uiActionNonce:'作者润色'}
it('main实际模板与UTF16原文hash冻结，不把草稿声称为canonical',()=>{
 const f=fixture(),recovery=f.owner.beginEditorInline(request)
 expect(recovery.context).toMatchObject({...input,kind:'author-draft',documentHash:createHash('sha256').update(input.documentText).digest('hex'),template:{key:'edit_selected_text',content:'固定作者模板 {{edit_instruction}}：{{selected_text}}'}})
 expect(f.spy).not.toHaveBeenCalled()
 expect(()=>f.owner.beginEditorInline({...request,input:{...input,from:2}})).toThrow()
})
const replying=(text:string,finishReason:'stop'|'length'):GenerationRunServiceDependencies['dispatch']=>async(_request,options)=>{options.onVisible({kind:'delta',text});return {finishReason,usage:null}}
it('半截建议和还没发出的选区任务列为选区恢复，不当作单章候选',async()=>{
 const f=fixture(replying('林岚停下','length'))
 const cut=f.owner.beginEditorInline({...request,uiActionNonce:'半截'}).view.handle
 await f.owner.executeEditorInline(cut)
 const pending=f.owner.beginEditorInline({...request,uiActionNonce:'没发出'}).view.handle
 const list=f.reopenStorage().listRecovery()
 expect(list.editors.map(item=>item.view.handle.runId).sort()).toEqual([cut.runId,pending.runId].sort())
 expect(list).toMatchObject({drafts:[],planning:[],reviews:[],partial:false})
})
it('气泡显示过的建议和作者拒绝过的建议不再列为可恢复（#686）',async()=>{
 const f=fixture(replying('林岚停下脚步。','stop'))
 const delivered=f.owner.beginEditorInline({...request,uiActionNonce:'送达'}).view.handle
 await f.owner.executeEditorInline(delivered)
 f.owner.acknowledgeEditorInline(delivered)
 const rejected=f.owner.beginEditorInline({...request,uiActionNonce:'拒绝'}).view.handle
 await f.owner.executeEditorInline(rejected)
 f.owner.cancel(rejected)
 const unsent=f.owner.beginEditorInline({...request,uiActionNonce:'没发就拒绝'}).view.handle
 f.owner.cancel(unsent)
 expect(f.reopenStorage().listRecovery()).toMatchObject({editors:[],partial:false})
})
it('生成完整但气泡没显示过（编辑器已卸载）：重开后仍列出，建议可从侧页复制',async()=>{
 const f=fixture(replying('林岚停下脚步。','stop'))
 const handle=f.owner.beginEditorInline(request).view.handle
 await f.owner.executeEditorInline(handle)
 const listed=f.reopenStorage().listRecovery().editors
 expect(listed.map(item=>item.view.handle.runId)).toEqual([handle.runId])
 expect((listed[0]!.view.candidates??listed[0]!.view.artifacts).map(item=>item.text)).toEqual(['林岚停下脚步。'])
})
it('升级前留下的完整建议没有待送达记录，按原判据不再列出',async()=>{
 const f=fixture(replying('林岚停下脚步。','stop'))
 const handle=f.owner.beginEditorInline(request).view.handle
 await f.owner.executeEditorInline(handle)
 f.db.prepare(`UPDATE generation_runs SET binding_json=json_remove(binding_json,'$."$editorInlineAwaitingDelivery"') WHERE run_id=?`).run(handle.runId)
 expect(f.reopenStorage().listRecovery()).toMatchObject({editors:[],partial:false})
})
it('发起时记下原稿身份，重开后从运行读得到；旧运行没有这项',async()=>{
 const f=fixture()
 const withOrigin=f.owner.beginEditorInline({...request,uiActionNonce:'带原稿',input:{...input,filePath:'drafts/3-1.md'}}).view.handle
 const legacy=f.owner.beginEditorInline({...request,uiActionNonce:'旧运行'}).view.handle
 const next=f.reopenStorage()
 expect(next.readEditorInlineRecovery(withOrigin).context.filePath).toBe('drafts/3-1.md')
 expect(next.readEditorInlineRecovery(legacy).context.filePath).toBeUndefined()
})
it('拒绝过的建议还有没落盘的文字时仍列出，那段文字只能从这里复制',async()=>{
 const f=fixture(replying('林岚停下脚步。','stop'))
 const handle=f.owner.beginEditorInline(request).view.handle
 f.db.exec("CREATE TRIGGER reject_snapshot BEFORE UPDATE OF artifact_json ON generation_artifacts BEGIN SELECT RAISE(FAIL,'synthetic disk failure'); END")
 const receipt=await f.owner.executeEditorInline(handle)
 f.db.exec('DROP TRIGGER reject_snapshot')
 expect(receipt.run.unsavedTails?.[0]?.text.trim()).toBeTruthy()
 f.owner.cancel(handle)
 expect(f.owner.listRecovery().editors.map(item=>item.view.handle.runId)).toEqual([handle.runId])
 f.owner.discardCandidate(handle,receipt.run.unsavedTails![0]!.artifactId)
})
it('同nonce不同作者输入拒绝，generic begin/execute不能绕过editor owner',async()=>{
 const f=fixture(),recovery=f.owner.beginEditorInline(request)
 expect(()=>f.owner.beginEditorInline({...request,input:{...input,action:'expand'}})).toThrow()
 expect(()=>f.owner.begin({operation:'editor-inline',uiActionNonce:'伪造',modelId:'synthetic',promptKeys:['edit_selected_text'],skillStages:[],selectedDraftIds:[],selectedFinalizedDraftIds:[],output:'visible-text'})).toThrow()
 await expect(f.owner.execute({handle:recovery.view.handle,invocationNonce:'伪请求',task:{purpose:'editor-ai-refine',output:'visible-text',messages:[]}})).rejects.toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})
it.each(['stop','unknown'] as const)('%s并发只发一次，重开改变模板删除模型仍读原候选',async mode=>{
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve})
 const f=fixture(async(_r,o)=>{await pending;o.onVisible({kind:'delta',text:'林岚停下脚步。'});if(mode==='unknown')throw new Error('合成网络中断');return {finishReason:'stop',usage:null}})
 const recovery=f.owner.beginEditorInline(request),handle=recovery.view.handle
 const a=f.owner.executeEditorInline(handle),b=f.owner.executeEditorInline(handle)
 release();const receipt=await a;expect(await b).toEqual(receipt)
 expect(f.spy).toHaveBeenCalledTimes(1)
 expect(JSON.stringify(f.spy.mock.calls[0]![0])).toContain('固定作者模板')
 expect(JSON.stringify(f.spy.mock.calls[0]![0])).toContain(input.selectedText)
 f.changeTemplate();f.removeModel();const next=f.reopenStorage()
 const read=next.readEditorInlineRecovery(handle)
 expect(read.modelId).toBe('synthetic');expect(read.context).toEqual(recovery.context)
 const replay=await next.executeEditorInline(handle)
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome.status).toBe(receipt.outcome.status)
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it('取消后晚回调不回写，未发送取消拒绝dispatch',async()=>{
 let release!:()=>void,started!:()=>void
 const pending=new Promise<void>(resolve=>{release=resolve}),visible=new Promise<void>(resolve=>{started=resolve})
 const f=fixture(async(_r,o)=>{started();await pending;o.onVisible({kind:'delta',text:'取消后的文字'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.beginEditorInline(request).view.handle
 const running=f.owner.executeEditorInline(handle);await visible
 f.owner.cancel(handle);release();await running
 expect(f.owner.read(handle).artifacts.every(item=>!item.text.includes('取消后的文字'))).toBe(true)
 const second=f.owner.beginEditorInline({...request,uiActionNonce:'第二作者动作'}).view.handle
 f.owner.cancel(second);await expect(f.owner.executeEditorInline(second)).rejects.toThrow()
 expect(f.spy).toHaveBeenCalledTimes(1)
})

const note='把林岚改成第一人称，语气更冷'
const noted={...request,uiActionNonce:'作者按意见改',input:{...input,action:'instruct' as const,instruction:note}}
it.each([
 ['缺少意见',{...input,action:'instruct'}],
 ['意见为空白',{...input,action:'instruct',instruction:' \n '}],
 ['意见不是字符串',{...input,action:'instruct',instruction:42}],
 ['意见超过2000字',{...input,action:'instruct',instruction:'冷'.repeat(2001)}],
 ['其他动作带意见',{...input,action:'refine',instruction:note}],
 ['动作不是字符串',{...input,action:['refine']}],
])('%s时拒绝开始运行',(_name,bad)=>{
 const f=fixture()
 expect(()=>f.owner.beginEditorInline({...request,input:bad as never})).toThrow('GENERATION_EDITOR_INPUT_INVALID')
 expect(f.spy).not.toHaveBeenCalled()
})
it('意见里的 $$、$& 与模板占位按字面进入模型请求',async()=>{
 const f=fixture(async()=>({finishReason:'stop',usage:null}))
 const instruction='价格写成 $$5，保留 $& 与 {{selected_text}} 原样'
 const handle=f.owner.beginEditorInline({...noted,input:{...noted.input,instruction}}).view.handle
 await f.owner.executeEditorInline(handle)
 const {task}=f.spy.mock.calls[0]![0] as {task:{messages:{role:string;content:string}[]}}
 const user=task.messages.find(m=>m.role==='user')!.content
 expect(user).toContain(instruction)
 expect(user.split(input.selectedText)).toHaveLength(2)
})
it('意见恰好2000字可以开始运行',()=>{
 const f=fixture(),instruction='冷'.repeat(2000)
 expect(f.owner.beginEditorInline({...noted,input:{...noted.input,instruction}}).context).toMatchObject({action:'instruct',instruction})
})
it('作者意见进入模型请求，并随运行冻结到重开之后',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'我停下脚步。'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.beginEditorInline(noted).view.handle
 await f.owner.executeEditorInline(handle)
 const sent=JSON.stringify(f.spy.mock.calls[0]![0])
 expect(sent).toContain(note)
 expect(sent).toContain(input.selectedText)
 const next=f.reopenStorage()
 expect(next.readEditorInlineRecovery(handle).context).toMatchObject({action:'instruct',instruction:note,selectedText:input.selectedText})
 expect(()=>next.beginEditorInline({...noted,input:{...noted.input,instruction:'改成对话'}})).toThrow()
})

const systemOf=(context:EditorInlineContext)=>editorInlineTask(context).messages.find(m=>m.role==='system')!.content
it.each([
 ['zh-CN','改成第一人称',['保留要求冲突','以作者意见为准','没提到','照常保留']],
 ['en-US','Rewrite it in first person',['conflicts with the preservation','follow the note','does not mention','keep']],
] as const)('%s 按意见改时，系统规则让作者意见压过内置模板的保留视角要求',(language,instruction,rule)=>{
 const template=getBuiltinPromptTemplate('edit_selected_text',language)!
 const system=systemOf(buildEditorInlineContext({...input,action:'instruct',instruction},language,template))
 expect(system).toContain(template.systemRole!)
 for(const phrase of rule) expect(system).toContain(phrase)
 for(const action of ['refine','expand','dialogue'] as const){
  const fixed=systemOf(buildEditorInlineContext({...input,action},language,template))
  expect(fixed).toBe(composePromptSystemRole(template,language))
 }
})

it.each([
 ['zh-CN','【不可变系统合同】',['下文合同','最新的作者明确事实']],
 ['en-US','[Immutable system contract]',['the contract below','newest explicit author fact']],
] as const)('%s 按意见删掉选区里的事实时，规则明确压过下文合同的明确事实条，合同本身逐字不变',(language,heading,rule)=>{
 const template=getBuiltinPromptTemplate('edit_selected_text',language)!
 const system=systemOf(buildEditorInlineContext({...input,action:'instruct',instruction:'删掉银镯这个细节'},language,template))
 const [role,contract]=system.split(heading)
 for(const phrase of rule) expect(role).toContain(phrase)
 expect(contract).toBe(composePromptSystemRole(template,language).split(heading)[1])
})


const batchDocument = input.documentText
const batchInput = {
 action: 'batch-instruct' as const,
 documentText: batchDocument,
 from: 0,
 to: batchDocument.length,
 selectedText: batchDocument,
 annotations: [
  { id: '批注一', from: input.from, to: input.to, selectedText: input.selectedText, instruction: '改成第一人称' },
  { id: '批注二', from: batchDocument.length - 1, to: batchDocument.length, selectedText: '乙', instruction: '删掉这个字' },
 ],
}
it('多处批注冻结为一个完整章节任务，一次执行并可在重开后恢复，原稿身份一并记下', async () => {
 const f = fixture(async (_r, o) => { o.onVisible({ kind: 'delta', text: '修改后的完整章节' }); return { finishReason: 'stop', usage: null } })
 const recovery = f.owner.beginEditorInline({ input: { ...batchInput, filePath: 'drafts/3-1.md' }, modelId: 'synthetic', uiActionNonce: '统一批注修改' })
 await f.owner.executeEditorInline(recovery.view.handle)
 expect(f.spy).toHaveBeenCalledTimes(1)
 const { task } = f.spy.mock.calls[0]![0] as { task: { messages: { role: string; content: string }[] } }
 const sent = task.messages.map(message => message.content).join('\n')
 for (const expected of ['改成第一人称', '删掉这个字', '完整章节', batchDocument]) expect(sent).toContain(expected)
 expect(f.reopenStorage().readEditorInlineRecovery(recovery.view.handle).context).toMatchObject({ ...batchInput, filePath: 'drafts/3-1.md' })
})
it('批注统一修改的结果没回执前留在恢复列表，回执后不再列出', async () => {
 const f = fixture(replying('修改后的完整章节', 'stop'))
 const handle = f.owner.beginEditorInline({ input: batchInput, modelId: 'synthetic', uiActionNonce: '统一修改待送达' }).view.handle
 await f.owner.executeEditorInline(handle)
 expect(f.owner.listRecovery().editors.map(item => item.view.handle.runId)).toEqual([handle.runId])
 f.owner.acknowledgeEditorInline(handle)
 expect(f.reopenStorage().listRecovery().editors).toEqual([])
})
it('同一段原文在章里出现多次时，提示词写明批注的是第几处', async () => {
 const repeated = '灯亮了。风停了。灯亮了。'
 const twice = { action: 'batch-instruct' as const, documentText: repeated, from: 0, to: repeated.length, selectedText: repeated,
  annotations: [{ id: '后一处', from: 8, to: 12, selectedText: '灯亮了。', instruction: '改成灯灭了' }] }
 const f = fixture(async (_r, o) => { o.onVisible({ kind: 'delta', text: '灯亮了。风停了。灯灭了。' }); return { finishReason: 'stop', usage: null } })
 const recovery = f.owner.beginEditorInline({ input: twice, modelId: 'synthetic', uiActionNonce: '重复原文' })
 await f.owner.executeEditorInline(recovery.view.handle)
 const { task } = f.spy.mock.calls[0]![0] as { task: { messages: { role: string; content: string }[] } }
 expect(task.messages.map(message => message.content).join('\n')).toContain('全文第 2 处（共 2 处）')
})
it.each([
 ['空批注', { ...batchInput, annotations: [] }],
 ['批注重叠', { ...batchInput, annotations: [batchInput.annotations[0], { ...batchInput.annotations[1], from: 2 }] }],
 ['批注原文不符', { ...batchInput, annotations: [batchInput.annotations[0], { ...batchInput.annotations[1], selectedText: '伪原文' }] }],
 ['不是整章目标', { ...batchInput, from: 1, selectedText: batchDocument.slice(1) }],
])('%s时拒绝批量运行', (_name, bad) => {
 const f = fixture()
 expect(() => f.owner.beginEditorInline({ input: bad, modelId: 'synthetic', uiActionNonce: '非法批注' })).toThrow('GENERATION_EDITOR_INPUT_INVALID')
 expect(f.spy).not.toHaveBeenCalled()
})

it.each<DamagedColumn>(['budget_json','action_json','binding_json'])('ADR-0030 选区建议 %s 读不出：恢复列表略去它、照列好的，同一次点击被拒绝，新的点击照常',async column=>{
 const f=fixture(replying('林岚停下','length'))
 vi.spyOn(console,'warn').mockImplementation(()=>{})
 const good=f.owner.beginEditorInline({...request,uiActionNonce:'好的'}).view.handle
 const bad=f.owner.beginEditorInline({...request,uiActionNonce:'坏的'}).view.handle
 f.owner.suspendForProjectClose()
 damageLedger(f.db,column,bad)
 const next=f.reopenStorage(),roots=rootCount(f.db)
 const list=next.listRecovery()
 expect(list.editors.map(item=>item.view.handle.runId)).toEqual([good.runId])
 expect(list.partial).toBe(true)
 expect(()=>next.beginEditorInline({...request,uiActionNonce:'坏的'})).toThrow('GENERATION_LEDGER_UNREADABLE')
 expect(rootCount(f.db)).toBe(roots)
 expect(await failingCalls(enumerations(next))).toEqual([])
 expect(next.beginEditorInline({...request,uiActionNonce:'新的'}).view.handle.rootActionId).not.toBe(bad.rootActionId)
})

const goldenTaskHashes: Record<string, string> = {
 'zh-CN:refine': '116ae4fe35271b4582088310ab93d047b61f4614a2199a3c9fc2aac11d5d5c55',
 'zh-CN:expand': '00ee948f9d1f2634d8ce337eb151700f257c912a76536e3841cb2c9816b60d0b',
 'zh-CN:dialogue': '01246c75d7f17f2472652668b99eaaf33db5be5e210897ad223cb869fe5b3c00',
 'zh-CN:instruct': 'ca9a0b6f9e4eb04110cd14ec3a85016edfbd16ec85b689446be94089921925e1',
 'zh-CN:batch-instruct': '17414d1a8ca7c0a1ad5c49ce088b2042224129e534ca8a4a74f2a7a0afafe235',
 'en-US:refine': '964d523853dc659450b0768711acd9ed1133539274855b6670e9d198b5235c1f',
 'en-US:expand': 'a386fc5ca0bc6144e3b5ea5b227910fd0f3a6a9c204804574d01337d2da373db',
 'en-US:dialogue': 'b46d32caa7d9baaa24d72da35da37e3b72c69f93f7097b1e023517b866d1e5cc',
 'en-US:instruct': '101431623ba5976f33c7cb85875a88378f66cf4e0cc3b35215a1050bf23a33f4',
 'en-US:batch-instruct': '850c6121820e28d1c392d81c1d1491be821e24579034cb4c26eb175d09a7abe8',
}
const goldenRequests = [{ action: 'refine' }, { action: 'expand' }, { action: 'dialogue' }, { action: 'instruct', instruction: '改成第一人称' },
 { action: 'batch-instruct', from: 0, to: input.documentText.length, selectedText: input.documentText, annotations: [{ id: 'a', from: 1, to: 5, selectedText: '😀林岚', instruction: '改冷' }] }] as const
it.each(['zh-CN', 'en-US'] as const)('%s 没有章号时（架构文档、恢复稿、升级前的运行），续写以外的任务与改动前逐字节相同', language => {
 for (const request of goldenRequests) {
  const context = buildEditorInlineContext({ ...input, ...request } as never, language, getBuiltinPromptTemplate('edit_selected_text', language)!)
  expect(createHash('sha256').update(JSON.stringify(editorInlineTask(context))).digest('hex'), request.action).toBe(goldenTaskHashes[`${language}:${request.action}`])
 }
})
it('没有章号的续写也告诉模型只写接续的新内容，接受时插在选区之后', async () => {
 const f = fixture(replying('乙丙', 'stop'))
 const recovery = f.owner.beginEditorInline({ input: { ...input, action: 'continue' }, modelId: 'synthetic', uiActionNonce: '无章号续写' })
 expect(editorInlineInsertsAfterSelection(recovery.context)).toBe(true)
 await f.owner.executeEditorInline(recovery.view.handle)
 const system = (f.spy.mock.calls.at(-1)![0] as { task: { messages: { role: string; content: string }[] } }).task.messages.find(m => m.role === 'system')!.content
 expect(system).toContain('只输出紧接在它后面的新内容')
})
it.each([
 ['zh-CN', 'e155a59b96e08e0045e656f667d27ff4dcba36b599fcb5d6ec21d265d39a8dfa'],
 ['en-US', 'd03af6cad6ca36c40195c4d8e0bd25cd9b2743f99be8a9abdafff00e988704b2'],
] as const)('%s 章内带后文的续写提示与改动前逐字节相同', (language, hash) => {
 const messages = editorInlineTask(buildEditorInlineContext({ action: 'continue', documentText: chapterDoc, from: selFrom, to: selFrom + sel.length,
  selectedText: sel, chapterContext: chapterContext() } as never, language, getBuiltinPromptTemplate('edit_selected_text', language)!)).messages
 expect(createHash('sha256').update(JSON.stringify(messages)).digest('hex')).toBe(hash)
})
it('改动前留下的运行清单重建后比较仍相等，建议仍可应用', () => {
 const f = fixture()
 const legacy = JSON.parse(fs.readFileSync('test/fixtures/editor-inline-v1-bindings.json', 'utf8')) as Record<string, Parameters<typeof rebuildGenerationSourceBinding>[1]>
 for (const binding of Object.values(legacy)) {
  const rebuilt = rebuildGenerationSourceBinding(f.deps, binding, 'epoch-2', undefined, readMainGenerationPolicy(binding.sourceManifest.policy)).binding
  expect(compareGenerationSourceBindings(binding, rebuilt)).toBe(true)
  expect(editorInlineInsertsAfterSelection(rebuilt.sourceManifest.editorInlineContext as never), JSON.stringify(binding.sourceManifest.editorInlineInput)).toBe(false)
 }
})

const sel = '林岚推开北塔的门。'
const chapterDoc = `${'第三十章前文铺垫。'.repeat(8)}${sel}${'门后是长廊。'.repeat(4)}`
const selFrom = chapterDoc.indexOf(sel)
const block = (kind: string, text: string, required: boolean) => ({ kind, text, required })
const chapterContext = (blocks = [block('style', 'STYLE_SENTINEL 第三人称', true), block('blueprint', 'BLUEPRINT_SENTINEL 林岚在北塔找到钥匙', true),
 block('characters', 'CHARACTER_SENTINEL 林岚左臂有伤', false), block('threads', 'THREAD_SENTINEL 青铜钥匙', false)], unreadable: string[] = []) =>
 ({ version: 1, chapterNumber: 30, blocks, unreadable })
const continued = (context = chapterContext(), nonce = '章内续写') => ({ modelId: 'synthetic', uiActionNonce: nonce,
 input: { action: 'continue' as const, documentText: chapterDoc, from: selFrom, to: selFrom + sel.length, selectedText: sel, chapterContext: context } as never })
const userOf = (f: ReturnType<typeof fixture>) => (f.spy.mock.calls.at(-1)![0] as { task: { messages: { role: string; content: string }[] } }).task.messages.find(m => m.role === 'user')!.content

it('章内续写把选区前的本章正文和本章蓝图放在模板段之前发给模型', async () => {
 const f = fixture(replying('钥匙在石缝里。', 'stop'))
 const handle = f.owner.beginEditorInline(continued()).view.handle
 await f.owner.executeEditorInline(handle)
 const user = userOf(f), template = user.indexOf('固定作者模板')
 for (const expected of ['第三十章前文铺垫。', 'BLUEPRINT_SENTINEL', 'STYLE_SENTINEL', 'CHARACTER_SENTINEL', 'THREAD_SENTINEL', '门后是长廊。']) {
  expect(user, expected).toContain(expected)
  expect(user.indexOf(expected), expected).toBeLessThan(template)
 }
})
it('没有章号的续写也从文档正文切选区前后文，后文第一句作为停止点，不带按章材料', async () => {
 const f = fixture(replying('钥匙在石缝里。', 'stop'))
 const recovery = f.owner.beginEditorInline({ modelId: 'synthetic', uiActionNonce: '无章号前后文', input: { action: 'continue' as const,
  documentText: chapterDoc, from: selFrom, to: selFrom + sel.length, selectedText: sel } as never })
 expect(recovery.context.materials!.included.map(item => item.kind)).toEqual(['preceding', 'following'])
 await f.owner.executeEditorInline(recovery.view.handle)
 const system = (f.spy.mock.calls.at(-1)![0] as { task: { messages: { role: string; content: string }[] } }).task.messages.find(m => m.role === 'system')!.content
 expect(userOf(f)).toContain('第三十章前文铺垫。')
 expect(userOf(f)).toContain('门后是长廊。')
 expect(system).toContain('后文第一句是「门后是长廊。」。续写停在这句之前')
 expect(userOf(f).endsWith('（提醒：续写停在后文第一句「门后是长廊。」之前。不换地方，不写后文和蓝图里后面的事；写一到两段，不超过选中正文的两倍长。）')).toBe(true)
})
it('选区后面还有本章正文时，续写规则与末尾提醒点名后文第一句作为停止点、不与后文矛盾；选区在章末时不提', async () => {
 const f = fixture(replying('钥匙在石缝里。', 'stop'))
 const systemOf = () => (f.spy.mock.calls.at(-1)![0] as { task: { messages: { role: string; content: string }[] } }).task.messages.find(m => m.role === 'system')!.content
 await f.owner.executeEditorInline(f.owner.beginEditorInline(continued()).view.handle)
 expect(systemOf()).toContain('后文第一句是「门后是长廊。」。续写停在这句之前')
 expect(systemOf()).toContain('不能与后文矛盾')
 expect(userOf(f).endsWith('（提醒：续写停在后文第一句「门后是长廊。」之前。不换地方，不写后文和蓝图里后面的事；写一到两段，不超过选中正文的两倍长。）')).toBe(true)
 const atEnd = { modelId: 'synthetic', uiActionNonce: '章末续写', input: { action: 'continue' as const, documentText: chapterDoc.slice(0, selFrom + sel.length),
  from: selFrom, to: selFrom + sel.length, selectedText: sel, chapterContext: chapterContext() } as never }
 await f.owner.executeEditorInline(f.owner.beginEditorInline(atEnd).view.handle)
 expect(systemOf()).not.toContain('后文')
 expect(userOf(f)).not.toContain('提醒')
})
it('后文太长只摘开头时，材料标明后面还有，续写规则仍以后文第一句为停止点', async () => {
 const f = fixture(replying('钥匙在石缝里。', 'stop'))
 const systemOf = () => (f.spy.mock.calls.at(-1)![0] as { task: { messages: { role: string; content: string }[] } }).task.messages.find(m => m.role === 'system')!.content
 const longDoc = `${chapterDoc}${'两人走到地下室楼梯口。'.repeat(80)}陈默在第一步前停下。`
 await f.owner.executeEditorInline(f.owner.beginEditorInline({ modelId: 'synthetic', uiActionNonce: '长后文续写', input: { action: 'continue' as const,
  documentText: longDoc, from: selFrom, to: selFrom + sel.length, selectedText: sel, chapterContext: chapterContext() } as never }).view.handle)
 const user = userOf(f), after = user.slice(user.indexOf('【选中正文之后的本章正文】'))
 expect(after).not.toContain('陈默在第一步前停下')
 expect(after).toContain('后面还有')
 expect(systemOf()).toContain('后文第一句是「门后是长廊。」')
 await f.owner.executeEditorInline(f.owner.beginEditorInline(continued(chapterContext(), '短后文续写')).view.handle)
 expect(userOf(f)).not.toContain('后面还有')
})
it('模型窗口小时可选材料按固定顺序被裁（先线索后人物），必需材料保留，被裁项记进运行记录并在重开后不变', async () => {
 const f = fixture(replying('钥匙在石缝里。', 'stop'))
 f.setContextWindow(8000)
 const hugeThreads = chapterContext([block('style', 'STYLE_SENTINEL', true), block('blueprint', 'BLUEPRINT_SENTINEL', true),
  block('characters', 'CHARACTER_SENTINEL', false), block('threads', `THREAD_SENTINEL${'线'.repeat(6000)}`, false)])
 const onlyThreads = f.owner.beginEditorInline(continued(hugeThreads, '只裁线索'))
 expect(onlyThreads.context.materials?.omitted).toEqual([{ kind: 'threads', reason: 'budget' }])
 await f.owner.executeEditorInline(onlyThreads.view.handle)
 expect(userOf(f)).toContain('CHARACTER_SENTINEL')
 expect(userOf(f)).not.toContain('THREAD_SENTINEL')
 const hugeCharacters = chapterContext([block('style', 'STYLE_SENTINEL', true), block('blueprint', `BLUEPRINT_SENTINEL${'蓝'.repeat(4000)}`, true),
  block('characters', `CHARACTER_SENTINEL${'人'.repeat(4000)}`, false), block('threads', 'THREAD_SENTINEL', false)])
 const both = f.owner.beginEditorInline(continued(hugeCharacters, '两项都裁'))
 expect(both.context.materials?.omitted).toEqual([{ kind: 'threads', reason: 'budget' }, { kind: 'characters', reason: 'budget' }])
 await f.owner.executeEditorInline(both.view.handle)
 expect(userOf(f)).toContain('BLUEPRINT_SENTINEL')
 const reopened = f.reopenStorage().readEditorInlineRecovery(both.view.handle)
 expect(reopened.sourceStatus).toBe('current')
 expect(reopened.context.materials).toEqual(both.context.materials)
 const binding = JSON.parse(f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(both.view.handle.runId) as string)
 const widerModel = { ...binding.sourceManifest.modelReceipt, capabilityEvidence: { ...binding.sourceManifest.modelReceipt.capabilityEvidence, contextWindowTokens: 200000 } }
 expect(rebuildGenerationSourceBinding(f.deps, binding, 'epoch-3', widerModel).binding.sourceManifest.editorInlineContext).toEqual(binding.sourceManifest.editorInlineContext)
})
it('本机模型没填窗口时按写正文同一份额度（本机默认窗口）裁可选材料，不按通用默认窗口多塞', async () => {
 const f = fixture(replying('钥匙在石缝里。', 'stop'))
 f.useLocalModelWithoutWindow()
 const recovery = f.owner.beginEditorInline(continued(chapterContext([block('style', 'STYLE_SENTINEL', true), block('blueprint', 'BLUEPRINT_SENTINEL', true),
  block('characters', 'CHARACTER_SENTINEL', false), block('threads', `THREAD_SENTINEL${'线'.repeat(3000)}`, false)])))
 expect(recovery.context.materials?.omitted).toEqual([{ kind: 'threads', reason: 'budget' }])
 await f.owner.executeEditorInline(recovery.view.handle)
 expect(userOf(f)).toContain('CHARACTER_SENTINEL')
})
it('某个人物或线索读不出时只略去该块并记进运行记录，生成照常', async () => {
 const f = fixture(replying('钥匙在石缝里。', 'stop'))
 const recovery = f.owner.beginEditorInline(continued(chapterContext([block('style', 'STYLE_SENTINEL', true), block('blueprint', 'BLUEPRINT_SENTINEL', true)], ['characters', 'threads'])))
 expect(recovery.context.materials?.omitted).toEqual([{ kind: 'characters', reason: 'unreadable' }, { kind: 'threads', reason: 'unreadable' }])
 const receipt = await f.owner.executeEditorInline(recovery.view.handle)
 expect(receipt.outcome.status).toBe('completed')
})
it('开运行后人物状态或本章蓝图变了，建议仍可应用', () => {
 const f = fixture()
 const handle = f.owner.beginEditorInline(continued()).view.handle
 f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(30,'后来补的蓝图')")
 f.db.exec("INSERT INTO characters(name,cs_mental_state) VALUES('林岚','后台更新的心理状态')")
 expect(f.owner.readEditorInlineRecovery(handle).sourceStatus).toBe('current')
 expect(f.reopenStorage().readEditorInlineRecovery(handle).sourceStatus).toBe('current')
})
it.each([
 ['工具表外的块', chapterContext([block('style', 'S', true), block('blueprint', 'B', true), block('preceding', '伪造前文', true)])],
 ['必需标记与工具表不符', chapterContext([block('style', 'S', true), block('blueprint', 'B', false)])],
 ['同一块两次', chapterContext([block('style', 'S', true), block('style', 'S2', true)])],
 ['章号不合法', { ...chapterContext(), chapterNumber: 0 }],
])('章节上下文%s时拒绝开始运行', (_name, bad) => {
 const f = fixture()
 expect(() => f.owner.beginEditorInline(continued(bad as never))).toThrow('GENERATION_EDITOR_INPUT_INVALID')
})

const settingDoc = '# 雾港\n\n雾港是北方一座半废弃的港城，三面环山。\n\n渔市的老人们记得沉船那一夜。\n\n每年十月起，海雾午后从湾口涌进来。'
const settingSel = '渔市的老人们记得沉船那一夜。'
const settingContinue = (filePath: string | undefined, atEnd: boolean, language: 'zh-CN' | 'en-US', frozen?: { materials?: undefined }) => {
 const documentText = atEnd ? settingDoc.slice(0, settingDoc.indexOf(settingSel) + settingSel.length) : settingDoc
 const from = documentText.indexOf(settingSel)
 return editorInlineTask(buildEditorInlineContext({ action: 'continue', documentText, from, to: from + settingSel.length, selectedText: settingSel,
  ...(filePath ? { filePath } : {}) } as never, language, getBuiltinPromptTemplate('edit_selected_text', language)!, Infinity, frozen)).messages
}
const promptHash = (messages: unknown) => createHash('sha256').update(JSON.stringify(messages)).digest('hex')
it.each([
 ['zh-CN', false, '2c21debfcc697f75735e2cd67932070b21b92342a6c637be04b5a052ea5e5769'], ['zh-CN', true, '1fd89372392372249da5a184414976fd1137a42bc488033b235b005369bbf783'],
 ['en-US', false, '366d97851355c872fe61077a232266efc97923c062badb4b3ce3d43f01fd0e4e'], ['en-US', true, '6a9a6f45d6ce911968f3b4951e6cb8c7b3b9562ec7878e5689ab61cc3e4ba07f'],
] as const)('%s 不是设定文档的无章号续写（恢复稿、没有文件路径）提示与改动前逐字节相同（选区在末尾 %s）', (language, atEnd, hash) => {
 for (const filePath of [undefined, 'ai-novel://recovery/candidate-1']) expect(promptHash(settingContinue(filePath, atEnd, language)), filePath).toBe(hash)
})
it.each([['zh-CN', 'bc53b520bad0b328b63e3a2a58995d70cb5cc78bf6d073081b995e7af3b27ba5'], ['en-US', 'aab14495386917524ba444ac2de1eee2ebc21eb4b97e87a933b302630eff2c30']] as const)('%s 升级前冻结的设定文档续写（没有材料，替换选区）提示与改动前逐字节相同', (language, hash) => {
 expect(promptHash(settingContinue('ai-novel://core/worldbuilding', false, language, { materials: undefined }))).toBe(hash)
})
it.each([false, true])('设定文档里的续写照原文体裁写：提示说明体裁，不提人物动机与情节，材料标为文档（选区在末尾 %s）', atEnd => {
 const [system, user] = settingContinue('ai-novel://core/worldbuilding', atEnd, 'zh-CN').map(message => message.content)
 expect(system).toContain('原文是设定、资料、大纲这类说明性文字时，续写也只写说明性的内容')
 expect(user).toContain('照原文的体裁和写法往下写。')
 expect(user).toContain('【文档上下文：')
 expect(user).toContain('【选中正文之前的文档】')
 if (!atEnd) expect(user).toContain('【选中正文之后的文档】')
 for (const novelish of ['人物动机', '情节', '人物手里', '本章正文】', '本章上下文']) expect(system + user, novelish).not.toContain(novelish)
})
it.each([false, true])('英文设定文档里的续写同样照原文体裁写（选区在末尾 %s）', atEnd => {
 const [system, user] = settingContinue('ai-novel://core/worldbuilding', atEnd, 'en-US').map(message => message.content)
 expect(system).toContain('expository text such as setting notes')
 expect(user).toContain('Continue in the same form and manner as the original.')
 expect(user).toContain('[Document context:')
 expect(user).toContain('[Document text before the selection]')
 if (!atEnd) expect(user).toContain('[Document text after the selection]')
 for (const novelish of ['character motivation', 'What the characters hold', 'Chapter text', 'Chapter context']) expect(system + user, novelish).not.toContain(novelish)
})
