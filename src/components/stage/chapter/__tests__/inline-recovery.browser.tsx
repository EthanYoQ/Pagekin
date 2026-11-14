import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'

import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import StageWorkspace from '../../StageWorkspace'
import { BLUEPRINT, ORIGINAL, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = {
  editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(),
  stage: useStageStore.getState(), layout: useLayoutStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
}

const SELECTED = '他第三次展开信纸。'
const SUGGESTION = '他第三次把信纸摊开在膝上。'
const handle = { projectId: SESSION.projectId, epoch: '上次打开', rootActionId: '选区根', runId: '选区运行' }

let root: Root | undefined
let host: HTMLDivElement | undefined
let backend: ReturnType<typeof createChapterBackend>

async function sha256(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')
}

const chapterTab = (chapterNumber: number) => useEditorStore.getState().tabs.find(tab => tab.chapterNumber === chapterNumber)?.filePath

/** 请求发出前关闭应用留下的第 3 章选区润色运行。执行完的视图照实机：状态仍是 running，句柄换成这次打开。 */
async function interruptedSelectionRun(documentText: string, executed: Promise<void> = Promise.resolve(), origin: () => string | undefined = () => chapterTab(3) ?? 'drafts/3') {
  const from = documentText.indexOf(SELECTED)
  const base = { action: 'refine', kind: 'author-draft', documentText, documentHash: await sha256(documentText), from, to: from + SELECTED.length, selectedText: SELECTED }
  const pending = { handle, status: 'running', artifacts: [], candidates: [], ledger: { physicalRequests: 0 } }
  const done = { handle: { ...handle, epoch: SESSION.leaseId }, status: 'running', artifacts: [], candidates: [{ ...handle, artifactId: '建议', textHash: 'h', text: SUGGESTION, status: 'completed', compositionEligible: true }], ledger: { physicalRequests: 1 } }
  let view: typeof pending | typeof done = pending
  let delivered = false
  const recovery = () => {
    const filePath = origin()
    return { view, modelId: 'glm', sourceStatus: 'current', context: filePath === undefined ? base : { ...base, filePath } }
  }
  const fixture = backend.invoke.getMockImplementation()!
  backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'generation:list-recovery': return { planning: [], editors: delivered ? [] : [recovery()], reviews: [], drafts: [], batches: [], partial: false }
      case 'db:recovery-candidate-list': return []
      case 'llm:list-models': return useLLMStore.getState().models
      case 'editor-inline:read-recovery': return recovery()
      case 'editor-inline:delivered':
        if (view === done) delivered = true
        return undefined
      case 'editor-inline:execute':
        await executed
        view = done
        return { run: done, sourceStatus: 'current', outcome: { status: 'completed', finishReason: 'stop', content: SUGGESTION, receipt: { finishReason: 'stop' } } }
      default: return fixture(channel, ...args)
    }
  })
}

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1028px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
}

async function openChapter(chapterNumber = 3, prepare?: (draft: ReturnType<typeof backend.addDraft>) => void) {
  const draft = backend.addDraft({ status: 'draft', chapterNumber })
  prepare?.(draft)
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  const meta = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draft.id)!
  await act(async () => { await openDraftTab(meta, `第 ${chapterNumber} 章`, SESSION) })
}

const executions = () => backend.invoke.mock.calls.filter(([channel]) => channel === 'editor-inline:execute').length
const deliveries = () => backend.invoke.mock.calls.filter(([channel]) => channel === 'editor-inline:delivered').length
const withMergeableRevision = (draft: ReturnType<typeof backend.addDraft>) => { backend.addReview(draft); backend.addRevision(draft, 'refine') }

async function expectContinuedInSheet() {
  await vi.waitFor(() => expect(executions()).toBe(1))
  const card = page.getByRole('article').filter({ hasText: '编辑器选区建议' })
  await expect.element(card.getByText(SUGGESTION)).toBeVisible()
  expect(deliveries()).toBe(0)
}
const editor = () => EditorView.findFromDOM(host!.querySelector('.cm-editor')!)!
const editorText = () => editor().state.doc.toString()

beforeEach(async () => {
  await page.viewport(1280, 900)
  localStorage.clear()
  backend = createChapterBackend()
  backend.install()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, spineFacts: SESSION, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('glm')], defaultModelId: 'glm', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, startWorkflow: vi.fn(async () => 'chapter-run') as never, addLog: vi.fn() as never, getResourceConflict: (() => null) as never })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await act(async () => root?.unmount())
  host?.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(original.editor, true)
  useProjectStore.setState(original.project, true)
  useDraftStore.setState(original.drafts, true)
  useStageStore.setState(original.stage, true)
  useLayoutStore.setState(original.layout, true)
  useLLMStore.setState(original.llm, true)
  useWorkflowStore.setState(original.workflow, true)
})

describe('运行侧页「继续原选区任务」', () => {
  it('原章正文没变：收起侧页，选中原选区并在气泡里续跑，建议可复制，点「替换」写进正文', async () => {
    await interruptedSelectionRun(ORIGINAL)
    const copied: string[] = []
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async value => { copied.push(value) })
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    const bubble = page.getByRole('toolbar', { name: '选中文字的操作' })
    await expect.element(bubble.getByText(SUGGESTION)).toBeVisible()
    expect(useStageStore.getState().sheet).toBeNull()
    expect(executions()).toBe(1)
    const { from, to } = editor().state.selection.main
    expect(editorText().slice(from, to)).toBe(SELECTED)
    await act(async () => bubble.getByRole('button', { name: '复制' }).click())
    expect(copied).toEqual([SUGGESTION])
    await act(async () => bubble.getByRole('button', { name: '替换' }).click())
    await vi.waitFor(() => expect(editorText()).toBe(ORIGINAL.replace(SELECTED, SUGGESTION)))
  })

  it('原章正文已改过、定位不到原选区：在侧页续跑，建议留在侧页卡片里可复制', async () => {
    await interruptedSelectionRun(ORIGINAL.replace('雨从傍晚', '雪从傍晚'))
    const copied: string[] = []
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async value => { copied.push(value) })
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    const card = page.getByRole('article').filter({ hasText: '编辑器选区建议' })
    await expect.element(card.getByText(SUGGESTION)).toBeVisible()
    await expect.element(card.getByText('已用 0 次请求')).not.toBeInTheDocument()
    await expect.element(card.getByRole('button', { name: '继续原选区任务' })).toBeDisabled()
    expect(executions()).toBe(1)
    expect(useStageStore.getState().sheet).not.toBeNull()
    await act(async () => card.getByRole('button', { name: '复制建议' }).click())
    expect(copied).toEqual([SUGGESTION])
    expect(editorText()).toBe(ORIGINAL)
  })

  it('打开章之后作者改过正文：不进气泡，在侧页续跑，建议留在卡片上', async () => {
    await interruptedSelectionRun(ORIGINAL)
    await mount()
    await openChapter()
    await act(async () => editor().dispatch({ changes: { from: 0, insert: '夜。' } }))
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    await expect.element(page.getByRole('article').filter({ hasText: '编辑器选区建议' }).getByText(SUGGESTION)).toBeVisible()
    expect(useStageStore.getState().sheet).not.toBeNull()
    expect(host!.querySelector('[role="toolbar"]')).toBeNull()
    expect(editorText()).toBe(`夜。${ORIGINAL}`)
  })

  it('侧页续跑出的建议在关掉侧页再打开后仍在，点「不再显示」才不列出', async () => {
    await interruptedSelectionRun(ORIGINAL.replace('雨从傍晚', '雪从傍晚'))
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())
    const card = page.getByRole('article').filter({ hasText: '编辑器选区建议' })
    await expect.element(card.getByText(SUGGESTION)).toBeVisible()

    await act(async () => useStageStore.setState({ sheet: null }))
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await expect.element(card.getByText(SUGGESTION)).toBeVisible()
    await act(async () => card.getByRole('button', { name: '不再显示' }).click())
    await expect.element(card).not.toBeInTheDocument()
    await act(async () => useStageStore.setState({ sheet: null }))
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await expect.element(page.getByText('没有进行中的运行')).toBeVisible()
    await expect.element(card).not.toBeInTheDocument()
  })

  it('续跑进行中点了「不再显示」：藏的是续跑前的卡片，续跑写出的新建议照常列出', async () => {
    let finish!: () => void
    await interruptedSelectionRun(ORIGINAL.replace('雨从傍晚', '雪从傍晚'), new Promise<void>(resolve => { finish = resolve }))
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    const card = page.getByRole('article').filter({ hasText: '编辑器选区建议' })
    await act(async () => card.getByRole('button', { name: '继续原选区任务' }).click())

    await act(async () => card.getByRole('button', { name: '不再显示' }).click())
    await expect.element(card).not.toBeInTheDocument()
    await act(async () => finish())

    await expect.element(card.getByText(SUGGESTION)).toBeVisible()
  })

  it('气泡里复制失败只提示复制失败，「替换」仍可用；再复制成功提示消失', async () => {
    await interruptedSelectionRun(ORIGINAL)
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())
    const bubble = page.getByRole('toolbar', { name: '选中文字的操作' })
    await expect.element(bubble.getByText(SUGGESTION)).toBeVisible()

    await act(async () => bubble.getByRole('button', { name: '复制' }).click())
    await expect.element(bubble.getByText('复制失败')).toBeVisible()
    await expect.element(bubble.getByRole('button', { name: '替换' })).toBeEnabled()

    await act(async () => bubble.getByRole('button', { name: '复制' }).click())
    expect(writeText).toHaveBeenCalledTimes(2)
    await expect.element(bubble.getByText('复制失败')).not.toBeInTheDocument()
    await act(async () => bubble.getByRole('button', { name: '替换' }).click())
    await vi.waitFor(() => expect(editorText()).toBe(ORIGINAL.replace(SELECTED, SUGGESTION)))
  })

  it('两个已打开标签正文相同：按发起时记下的原稿进第 3 章的气泡，第 4 章不动', async () => {
    await interruptedSelectionRun(ORIGINAL)
    await mount()
    await openChapter(3)
    await openChapter(4)
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' }).getByText(SUGGESTION)).toBeVisible()
    expect(useEditorStore.getState().activeTabId).toBe(useEditorStore.getState().tabs.find(tab => tab.chapterNumber === 3)!.id)
    expect(useEditorStore.getState().tabs.find(tab => tab.chapterNumber === 4)!.content).toBe(ORIGINAL)
  })

  it('原稿没打开、另一份正文相同的稿开着：不进那份稿的气泡，在侧页续跑，正文不动', async () => {
    await interruptedSelectionRun(ORIGINAL, undefined, () => 'drafts/没打开的原稿')
    await mount()
    await openChapter(4)
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    await expect.element(page.getByRole('article').filter({ hasText: '编辑器选区建议' }).getByText(SUGGESTION)).toBeVisible()
    expect(host!.querySelector('[role="toolbar"]')).toBeNull()
    expect(editorText()).toBe(ORIGINAL)
  })

  it('升级前的旧运行没记原稿：即使有正文相同的标签也只在侧页续跑', async () => {
    await interruptedSelectionRun(ORIGINAL, undefined, () => undefined)
    await mount()
    await openChapter(3)
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    await expect.element(page.getByRole('article').filter({ hasText: '编辑器选区建议' }).getByText(SUGGESTION)).toBeVisible()
    expect(host!.querySelector('[role="toolbar"]')).toBeNull()
  })

  it('气泡显示过建议后，运行侧页不再列出这条运行', async () => {
    await interruptedSelectionRun(ORIGINAL)
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())
    await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' }).getByText(SUGGESTION)).toBeVisible()

    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await expect.element(page.getByText('没有进行中的运行')).toBeVisible()
    await expect.element(page.getByRole('article').filter({ hasText: '编辑器选区建议' })).not.toBeInTheDocument()
  })

  it('气泡续跑期间切到别的章：建议没显示过，运行侧页里仍能看到并复制', async () => {
    let finish!: () => void
    await interruptedSelectionRun(ORIGINAL, new Promise<void>(resolve => { finish = resolve }))
    const copied: string[] = []
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async value => { copied.push(value) })
    await mount()
    await openChapter(3)
    await openChapter(4)
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())
    await vi.waitFor(() => expect(executions()).toBe(1))

    await act(async () => useEditorStore.getState().setActiveTab(useEditorStore.getState().tabs.find(tab => tab.chapterNumber === 4)!.id))
    await act(async () => finish())
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    const card = page.getByRole('article').filter({ hasText: '编辑器选区建议' })
    await expect.element(card.getByText(SUGGESTION)).toBeVisible()
    await act(async () => card.getByRole('button', { name: '复制建议' }).click())
    expect(copied).toEqual([SUGGESTION])
  })

  it('设置页开着时点「继续原选区任务」：先离开设置页，建议显示在看得见的气泡里', async () => {
    await interruptedSelectionRun(ORIGINAL)
    await mount()
    await openChapter()
    await act(async () => useLayoutStore.setState({ settingsOpen: true }))
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    expect(useLayoutStore.getState().settingsOpen).toBe(false)
    await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' }).getByText(SUGGESTION)).toBeVisible()
  })

  it('气泡续跑期间打开设置页：生成完成时预览看不见就不回执，关掉设置页看到建议才回执', async () => {
    let finish!: () => void
    await interruptedSelectionRun(ORIGINAL, new Promise<void>(resolve => { finish = resolve }))
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())
    await vi.waitFor(() => expect(executions()).toBe(1))

    await act(async () => useLayoutStore.setState({ settingsOpen: true }))
    await act(async () => finish())
    await act(async () => new Promise(resolve => setTimeout(resolve, 50)))
    expect(deliveries()).toBe(0)

    await act(async () => useLayoutStore.setState({ settingsOpen: false }))
    await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' }).getByText(SUGGESTION)).toBeVisible()
    await vi.waitFor(() => expect(deliveries()).toBe(1))
  })

  it('修稿合并视图开着时点「继续原选区任务」：合并视图留着，在侧页续跑，建议留在卡片上', async () => {
    await interruptedSelectionRun(ORIGINAL)
    await mount()
    await openChapter(3, withMergeableRevision)
    await expect.element(page.getByRole('button', { name: '完成合并' })).toBeVisible()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    await expectContinuedInSheet()
    await expect.element(page.getByRole('button', { name: '完成合并' })).toBeVisible()
  })

  it('原稿在后台标签且有待合并修稿（切过去会摆出合并视图）：不切标签，在侧页续跑', async () => {
    await interruptedSelectionRun(ORIGINAL)
    await mount()
    await openChapter(3, withMergeableRevision)
    await expect.element(page.getByRole('button', { name: '完成合并' })).toBeVisible()
    await openChapter(4)
    const fourth = useEditorStore.getState().activeTabId
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    await expectContinuedInSheet()
    expect(useEditorStore.getState().activeTabId).toBe(fourth)
  })

  it('正在查看不能合并的修稿时点「继续原选区任务」：不退出查看，在侧页续跑', async () => {
    const edited = `${ORIGINAL}\n\n作者后来补的一段。`
    await interruptedSelectionRun(edited)
    await mount()
    await openChapter(3, draft => { withMergeableRevision(draft); draft.content = edited })
    await act(async () => page.getByRole('button', { name: '查看修稿' }).click())
    await expect.element(page.getByText('修订仍可查看但不能合并', { exact: false })).toBeVisible()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    await expectContinuedInSheet()
    await expect.element(page.getByText('修订仍可查看但不能合并', { exact: false })).toBeVisible()
  })

  it('第一次在气泡里读不出原运行，再从侧页点「继续原选区任务」会重新读取并续跑', async () => {
    await interruptedSelectionRun(ORIGINAL)
    const fixture = backend.invoke.getMockImplementation()!
    let reads = 0
    backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'editor-inline:read-recovery' && ++reads === 1) throw new Error('读取失败')
      return fixture(channel, ...args)
    })
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())
    await vi.waitFor(() => expect(reads).toBe(1))
    await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' }).getByText('无法恢复原运行')).toBeVisible()

    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' }).getByText(SUGGESTION)).toBeVisible()
  })
})
