import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import { useProjectStore } from '../../../../stores/project-store'
import StageWorkspace from '../../StageWorkspace'
import { BLUEPRINT, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'
import { resizeViewport } from '../../../ui/__tests__/viewport'

vi.mock('/src/components/editor/CodeMirrorEditor.tsx', () => ({
  default: ({ content, onCommitAnnotations }: { content: string; onCommitAnnotations?: (before: string, after: string, annotations: never[]) => Promise<void> }) => onCommitAnnotations
    ? <button type="button" onClick={() => void onCommitAnnotations(content, `${content}\n\n批注改出的一段。`, [])}>接受批注修改</button>
    : null,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = { editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(), stage: useStageStore.getState(), llm: useLLMStore.getState() }
let root: Root
let host: HTMLDivElement
let backend: ReturnType<typeof createChapterBackend>

beforeEach(async () => {
  await resizeViewport(1280, 900)
  backend = createChapterBackend()
  backend.install()
  const answer = backend.invoke.getMockImplementation()!
  backend.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'db:annotation-history-list') return []
    if (channel !== 'db:annotation-commit') return answer(channel, ...args)
    const { draftId, after } = args[0] as { draftId: number; after: string }
    Object.assign(backend.state.drafts.find(draft => draft.id === draftId)!, { content: after })
    return { success: true }
  })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('grok')], defaultModelId: 'grok', loaded: true })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1028px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<StageWorkspace library={false} focus={false} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(original.editor, true)
  useProjectStore.setState(original.project, true)
  useDraftStore.setState(original.drafts, true)
  useStageStore.setState(original.stage, true)
  useLLMStore.setState(original.llm, true)
})

it('批注修改写进这一稿后，生成在先的修稿立刻显示为不能再合并', async () => {
  const draft = backend.addDraft({ status: 'draft' })
  backend.addRevision(draft, 'refine')
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  await act(async () => { await openDraftTab(useDraftStore.getState().draftsByChapter[3]!.find(candidate => candidate.id === draft.id)!, '第 3 章 · 雨夜车站', SESSION) })
  await act(async () => page.getByRole('button', { name: '稍后再合并' }).click())
  await expect.element(page.getByText('有 1 份修稿不能再合并')).not.toBeInTheDocument()

  await act(async () => page.getByRole('button', { name: '接受批注修改' }).click())

  await expect.element(page.getByText('有 1 份修稿不能再合并')).toBeVisible()
})
