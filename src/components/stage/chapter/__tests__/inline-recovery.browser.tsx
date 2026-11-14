import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'

import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
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
  stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
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

/** 上次打开时在第 3 章选中一句点了「润色」，请求还没发出去应用就关了；这次打开它列在运行侧页「进行中」。 */
async function interruptedSelectionRun(documentText: string) {
  const from = documentText.indexOf(SELECTED)
  const context = { action: 'refine', kind: 'author-draft', documentText, documentHash: await sha256(documentText), from, to: from + SELECTED.length, selectedText: SELECTED }
  const pending = { handle, status: 'running', artifacts: [], candidates: [], ledger: { physicalRequests: 0 } }
  const done = { handle, status: 'completed', artifacts: [], candidates: [{ ...handle, artifactId: '建议', textHash: 'h', text: SUGGESTION, status: 'completed', compositionEligible: true }], ledger: { physicalRequests: 1 } }
  let view: typeof pending | typeof done = pending
  const recovery = () => ({ view, modelId: 'glm', sourceStatus: 'current', context })
  const fixture = backend.invoke.getMockImplementation()!
  backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'generation:list-recovery': return { planning: [], editors: view === pending ? [recovery()] : [], reviews: [], drafts: [], batches: [], partial: false }
      case 'db:recovery-candidate-list': return []
      case 'editor-inline:read-recovery': return recovery()
      case 'editor-inline:execute':
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

async function openChapter() {
  const draft = backend.addDraft({ status: 'draft' })
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  const meta = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draft.id)!
  await act(async () => { await openDraftTab(meta, '第 3 章', SESSION) })
}

const executions = () => backend.writes('editor-inline:execute').length
const editorText = () => EditorView.findFromDOM(host!.querySelector('.cm-editor')!)!.state.doc.toString()

beforeEach(async () => {
  await page.viewport(1280, 900)
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
  useLLMStore.setState(original.llm, true)
  useWorkflowStore.setState(original.workflow, true)
})

describe('运行侧页「继续原选区任务」', () => {
  it('原章正文没变：收起侧页，在原选区的气泡里续跑，建议显示在气泡里，点「替换」写进正文', async () => {
    await interruptedSelectionRun(ORIGINAL)
    await mount()
    await openChapter()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))

    await act(async () => page.getByRole('button', { name: '继续原选区任务' }).click())

    const bubble = page.getByRole('toolbar', { name: '选中文字的操作' })
    await expect.element(bubble.getByText(SUGGESTION)).toBeVisible()
    expect(useStageStore.getState().sheet).toBeNull()
    expect(executions()).toBe(1)
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
    expect(executions()).toBe(1)
    expect(useStageStore.getState().sheet).not.toBeNull()
    await act(async () => card.getByRole('button', { name: '复制建议' }).click())
    expect(copied).toEqual([SUGGESTION])
    expect(editorText()).toBe(ORIGINAL)
  })
})
