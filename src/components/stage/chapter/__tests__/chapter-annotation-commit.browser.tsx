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

type CommitAnnotations = (before: string, after: string, annotations: never[]) => Promise<void>
const editorProps = vi.hoisted(() => ({ commit: null as CommitAnnotations | null }))
vi.mock('/src/components/editor/CodeMirrorEditor.tsx', () => ({
  default: ({ content, onCommitAnnotations, onSave }: { content: string; onSave?: (body: string) => unknown; onCommitAnnotations?: CommitAnnotations }) => onCommitAnnotations
    ? <>
      {void (editorProps.commit = onCommitAnnotations)}
      <button type="button" onClick={() => void onCommitAnnotations(content, `${content}\n\n批注改出的一段。`, []).catch(() => {})}>接受批注修改</button>
      <button type="button" onClick={() => void onSave?.(content)}>保存正文</button>
    </>
    : null,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = { editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(), stage: useStageStore.getState(), llm: useLLMStore.getState() }
let root: Root
let host: HTMLDivElement
let backend: ReturnType<typeof createChapterBackend>
let holdCommit: Promise<void> | null = null

beforeEach(async () => {
  await resizeViewport(1280, 900)
  backend = createChapterBackend()
  backend.install()
  const answer = backend.invoke.getMockImplementation()!
  holdCommit = null
  backend.invoke.mockImplementation(async (channel, ...args) => {
    if (channel !== 'db:annotation-commit') return answer(channel, ...args)
    const { draftId, after } = args[0] as { draftId: number; after: string }
    Object.assign(backend.state.drafts.find(draft => draft.id === draftId)!, { content: after })
    await holdCommit
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

it('批注修改还在写入时作者按了保存：保存等写入完成后再取正文，不把写入的结果改回去', async () => {
  const draft = backend.addDraft({ status: 'draft' })
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  await act(async () => { await openDraftTab(useDraftStore.getState().draftsByChapter[3]!.find(candidate => candidate.id === draft.id)!, '第 3 章 · 雨夜车站', SESSION) })
  let release!: () => void
  holdCommit = new Promise(resolve => { release = resolve })
  const after = `${draft.content}\n\n批注改出的一段。`

  await act(async () => page.getByRole('button', { name: '接受批注修改' }).click())
  await act(async () => page.getByRole('button', { name: '保存正文' }).click())
  await act(async () => release())

  await vi.waitFor(() => expect(backend.writes('db:draft-update-content').length).toBeGreaterThan(0))
  expect(backend.writes('db:draft-update-content').map(args => args[1])).toEqual([after])
  expect(backend.state.drafts.find(candidate => candidate.id === draft.id)!.content).toBe(after)
})

const OTHER_SESSION = Object.freeze({ projectId: 'other-work', leaseId: 'other-lease', projectPath: 'C:/另一部作品' })

async function switchToOtherWorkWhileCommitPending(retagTab: boolean) {
  const draft = backend.addDraft({ status: 'draft' })
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  await act(async () => { await openDraftTab(useDraftStore.getState().draftsByChapter[3]!.find(candidate => candidate.id === draft.id)!, '第 3 章 · 雨夜车站', SESSION) })
  await expect.element(page.getByRole('button', { name: '接受批注修改' })).toBeVisible()
  const commit = editorProps.commit!
  const tab = useEditorStore.getState().tabs[0]!
  await act(async () => {
    useProjectStore.setState({ currentProject: { ...chapterProject(), id: OTHER_SESSION.projectId, sessionLease: OTHER_SESSION.leaseId, path: OTHER_SESSION.projectPath } })
    setActiveProjectSessionContext(OTHER_SESSION)
    if (retagTab) useEditorStore.setState({ tabs: [{ ...tab, projectKey: OTHER_SESSION.projectPath }] })
  })
  return { tab, outcome: await commit(tab.content!, `${tab.content}\n\n批注改出的一段。`, []).then(() => 'committed', (error: Error) => error.message) }
}

it('作者已切到另一部作品，同一标签号的标签属于那部作品：批注修改不写进那部作品', async () => {
  const { tab, outcome } = await switchToOtherWorkWhileCommitPending(true)

  expect(outcome).toBe('SOURCE_DRAFT_CHANGED')
  expect(backend.invoke.mock.calls.filter(([channel]) => channel === 'db:annotation-commit')).toEqual([])
  expect(useEditorStore.getState().tabs[0]!.content).toBe(tab.content)
})

it('作者已切到另一部作品，原标签还在：批注修改不按当前作品的会话写入', async () => {
  const { tab, outcome } = await switchToOtherWorkWhileCommitPending(false)

  expect(outcome).toBe('SOURCE_DRAFT_CHANGED')
  expect(backend.invoke.mock.calls.filter(([channel]) => channel === 'db:annotation-commit')).toEqual([])
  expect(useEditorStore.getState().tabs[0]!.content).toBe(tab.content)
})
