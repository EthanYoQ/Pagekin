import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ContinuitySuggestionList, ContinuitySuggestionView } from '../../../../shared/blueprint-continuity-suggest'
import type { ReplacementImpact } from '../../../../shared/chapter-reopen'
import { globalEventBus } from '../../../../shared/event-bus'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { CHAPTER_CARD_TAB_ID } from '../../../editor/chapter-card-draft-ledger'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import StageWorkspace from '../../StageWorkspace'
import { BLUEPRINT, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 图生成的开跑与执行换成可控的假客户端，读建议和接受仍走章节假后端。 */
const graph = vi.hoisted(() => ({
  opened: [] as unknown[],
  release: null as null | (() => void),
  result: 'checked' as 'checked' | 'unreadable',
  runId: 'run-1',
}))
vi.mock('../../../../services/graph-generation', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../services/graph-generation')>(),
  createGraphGeneration: () => ({
    open: async (request: unknown) => { graph.opened.push(request) },
    execute: () => new Promise(resolve => {
      graph.release = () => resolve({
        result: graph.result === 'checked' ? { kind: 'continuity-suggest', suggestions: [], droppedSuggestions: 0 } : undefined,
        view: { handle: { runId: graph.runId }, budgetDiagnostics: [] },
      })
    }),
    detach: () => {},
  }),
}))

const original = {
  editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(),
  stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
}
const SEEN_KEY = `pagekin:replacement-impact-seen:${SESSION.projectId}`

let root: Root | undefined
let host: HTMLDivElement | undefined
let backend: ReturnType<typeof createChapterBackend>

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1028px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
}

async function unmount() {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
}

async function openDraft(draftId: number) {
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  const draft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draftId)!
  await act(async () => { await openDraftTab(draft, `第 ${draft.chapterNumber} 章`, SESSION) })
}

const button = (name: string) => page.getByRole('button', { name, exact: true })
const click = (name: string) => act(async () => button(name).click())
const finish = () => act(async () => { graph.release?.(); await Promise.resolve() })

const IMPACT: ReplacementImpact = { chapterNumber: 3, finalizationId: 'finalization-a', laterChapters: [4], blueprintOnlyChapters: [5], characters: ['林舟'], unmovedConfirmations: [] }
const NODE = { eventId: 'N-1', since: { zhCN: '第 3 章起', enUS: 'from chapter 3' }, fromChapter: 4, subjectName: '林舟', aspect: 'relation' as const, targetName: '老周', value: '死敌' }

function card(chapterNumber: number, fields: Partial<ContinuitySuggestionView> = {}): ContinuitySuggestionView {
  return {
    suggestionId: `${graph.runId}:${chapterNumber}`, chapterNumber, status: 'pending',
    issues: [`第 ${chapterNumber} 章写林舟和老周并肩，新稿里两人已成死敌。`], basis: [NODE],
    before: { title: '并肩', keyEvents: '林舟与老周并肩守站台。' }, after: { keyEvents: '林舟与老周在站台对峙。' },
    ...fields,
  }
}
const list = (suggestions: ContinuitySuggestionView[]): ContinuitySuggestionList => ({ runId: graph.runId, checkedChapters: [4, 5], droppedSuggestions: 0, suggestions })
const postProcessDone = (done: boolean) => {
  backend.state.postProcess = { steps: [
    { stepKey: 'chapter_notes', label: '章节要点', ok: true },
    { stepKey: 'character_cards', label: '角色状态', ok: done },
  ] }
}

async function openReplaced(title = '第 3 章已修改') {
  const final = backend.addDraft({ status: 'finalized', version: 2 })
  await mount()
  await openDraft(final.id)
  await expect.element(page.getByText(title)).toBeVisible()
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  localStorage.removeItem(SEEN_KEY)
  graph.opened = []
  graph.release = null
  graph.result = 'checked'
  graph.runId = 'run-1'
  backend = createChapterBackend()
  backend.install()
  backend.state.impacts = [IMPACT]
  postProcessDone(true)
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [3, 4, 5].map(chapterNumber => ({ chapterNumber, title: BLUEPRINT.title })) },
    spineFacts: SESSION, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('glm')], defaultModelId: 'glm', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: vi.fn(async () => 'chapter-run') as never, addLog: vi.fn() as never, getResourceConflict: (() => null) as never })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await unmount()
  localStorage.removeItem(SEEN_KEY)
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(original.editor, true)
  useProjectStore.setState(original.project, true)
  useDraftStore.setState(original.drafts, true)
  useStageStore.setState(original.stage, true)
  useLLMStore.setState(original.llm, true)
  useWorkflowStore.setState(original.workflow, true)
})

describe('替换定稿后检查后续蓝图', () => {
  it('后处理没做完时按钮不可点并说明原因；角色状态记完后可点，不自动开跑', async () => {
    postProcessDone(false)
    await openReplaced()
    await expect.element(button('检查后续蓝图')).toBeDisabled()
    await expect.element(page.getByText('定稿后处理做完后才能检查后续蓝图：新章的人物状态要先记进时间线。')).toBeVisible()

    postProcessDone(true)
    await act(async () => globalEventBus.emit('WORKFLOW_COMPLETE', { type: 'post-process', projectPath: SESSION.projectPath, projectSession: SESSION, runId: 'pp' }))
    await expect.element(button('检查后续蓝图')).toBeEnabled()
    expect(document.body.textContent).not.toContain('定稿后处理做完后才能检查后续蓝图')
    expect(graph.opened).toEqual([])
  })

  it('点「检查后续蓝图」按这次替换开跑；每章一张卡，写明问题、依据和逐字段对比；已有草稿的章提示正文不会跟着变', async () => {
    backend.addDraft({ status: 'draft', chapterNumber: 4 })
    await openReplaced()
    await click('检查后续蓝图')
    await expect.element(button('正在检查…')).toBeDisabled()
    expect(graph.opened).toEqual([{ input: { kind: 'continuity-suggest', finalizationId: 'finalization-a' }, modelId: 'glm', uiActionNonce: expect.any(String) }])

    backend.state.suggestions = list([card(4), card(5)])
    await finish()
    const section = page.getByRole('region', { name: '后续蓝图的修改建议' })
    await expect.element(section.getByText('检查了第 4–5 章')).toBeVisible()
    await expect.element(section.getByText('第 4 章写林舟和老周并肩，新稿里两人已成死敌。')).toBeVisible()
    await expect.element(section.getByText('依据：第 3 章起，林舟和老周是「死敌」').first()).toBeVisible()
    const changes = document.querySelector('.stage-ch-suggest-fields')!
    expect(changes.querySelector('dt')?.textContent).toBe('关键事件')
    expect(changes.querySelector('del')?.textContent).toBe('并肩守站台')
    expect(changes.querySelector('ins')?.textContent).toBe('在站台对峙')
    await expect.element(section.getByText('第 4 章已有草稿，蓝图改了正文不会跟着变。')).toBeVisible()
    expect(document.body.textContent).not.toContain('第 5 章已有草稿')
  })

  it('「接受」交给主进程写蓝图并刷新蓝图页；「不用」不写；接受时蓝图已改过就说明没写入、请重新检查', async () => {
    backend.state.suggestions = list([card(4), card(5)])
    backend.state.staleOnAccept.add('run-1:5')
    const refreshed = vi.fn()
    const off = globalEventBus.on('REFRESH_RESOURCE', refreshed)
    await openReplaced()
    const section = page.getByRole('region', { name: '后续蓝图的修改建议' })
    await expect.element(section).toBeVisible()

    await act(async () => section.getByRole('listitem').nth(0).getByRole('button', { name: '接受' }).click())
    await expect.element(section.getByText('已接受，蓝图已改。')).toBeVisible()
    expect(backend.writes('graph-generation:decide-suggestion')[0]?.[0]).toEqual({ suggestionId: 'run-1:4', decision: 'accept' })
    expect(refreshed).toHaveBeenCalledWith({ resources: ['blueprints'], projectPath: SESSION.projectPath, projectSession: SESSION })

    await act(async () => section.getByRole('listitem').nth(1).getByRole('button', { name: '接受' }).click())
    await expect.element(section.getByText('第 5 章的蓝图在建议之后改过，没有写入。再点“检查后续蓝图”。')).toBeVisible()
    await expect.element(section.getByText('这章蓝图在建议之后改过，这条不再适用。重新检查一次。')).toBeVisible()
    expect(refreshed).toHaveBeenCalledTimes(1)
    off()
  })

  it('「不用」只记下决定，蓝图不动', async () => {
    backend.state.suggestions = list([card(4)])
    await openReplaced()
    await click('不用')
    await expect.element(page.getByText('没有采用，蓝图没动。')).toBeVisible()
    expect(backend.writes('graph-generation:decide-suggestion').map(args => args[0])).toEqual([{ suggestionId: 'run-1:4', decision: 'reject' }])
  })

  it('蓝图页有没保存的修改时不能接受，并说明先保存或放弃', async () => {
    backend.state.suggestions = list([card(4)])
    useEditorStore.setState({ draftLedgers: { [CHAPTER_CARD_TAB_ID]: JSON.stringify({ version: 1, projects: [{ projectKey: SESSION.projectPath, blueprints: [], dirtyChapterNumbers: [4] }] }) } })
    await openReplaced()
    await expect.element(button('接受')).toBeDisabled()
    await expect.element(page.getByText('蓝图里有没保存的修改，先保存或放弃当前修改。')).toBeVisible()
    await expect.element(button('不用')).toBeEnabled()
  })

  it('检查进行中离开再回来，按钮仍在检查，结果出来后照常显示', async () => {
    await openReplaced()
    await click('检查后续蓝图')
    await unmount()
    await mount()
    await expect.element(button('正在检查…')).toBeDisabled()
    expect(graph.opened).toHaveLength(1)

    backend.state.suggestions = list([card(4)])
    await finish()
    await expect.element(page.getByText('第 4 章写林舟和老周并肩，新稿里两人已成死敌。')).toBeVisible()
    await expect.element(button('检查后续蓝图')).toBeEnabled()
  })

  it('没有矛盾时说明查过哪些章；结果读不出来时说明蓝图没动、再点一次', async () => {
    await openReplaced()
    await click('检查后续蓝图')
    backend.state.suggestions = list([])
    await finish()
    await expect.element(page.getByText('检查了第 4–5 章，蓝图和新的时间线没有矛盾。')).toBeVisible()

    graph.result = 'unreadable'
    graph.runId = 'run-2'
    await click('检查后续蓝图')
    await finish()
    await expect.element(page.getByText('蓝图没有改动。这次结果没读出来，再点“检查后续蓝图”。')).toBeVisible()
  })

  it('英文界面：按钮、卡片与提示都是英文', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    backend.addDraft({ status: 'draft', chapterNumber: 4 })
    backend.state.suggestions = list([card(4)])
    await openReplaced('Chapter 3 was changed')
    await expect.element(button('Check later blueprints')).toBeEnabled()
    const section = page.getByRole('region', { name: 'Suggested blueprint changes' })
    await expect.element(section.getByText('Checked chapters 4–5')).toBeVisible()
    await expect.element(section.getByText('Basis: From chapter 3, 林舟’s relation to 老周 is “死敌”')).toBeVisible()
    await expect.element(section.getByText('Chapter 4 already has a draft. Changing the blueprint does not change it.')).toBeVisible()
    await expect.element(button('Accept')).toBeEnabled()
    await expect.element(button('Don’t use')).toBeEnabled()
  })
})
