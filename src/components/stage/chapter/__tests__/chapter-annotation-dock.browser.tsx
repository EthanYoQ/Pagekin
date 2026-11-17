import { afterEach, beforeEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../../../../index.css'

import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageWorkspace from '../../StageWorkspace'
import { BLUEPRINT, ORIGINAL, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = { editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(), stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState() }
let root: Root
let host: HTMLDivElement
let backend: ReturnType<typeof createChapterBackend>

async function openChapter(fields: { content?: string; reviewed: boolean }) {
  const draft = backend.addDraft({ status: 'draft', ...(fields.content ? { content: fields.content } : {}) })
  if (fields.reviewed) backend.addReview(draft)
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  await act(async () => { await openDraftTab(useDraftStore.getState().draftsByChapter[3]!.find(candidate => candidate.id === draft.id)!, '第 3 章 · 雨夜车站', SESSION) })
}

async function annotate(line: string, note: string) {
  await act(async () => page.getByText(line, { exact: true }).click({ clickCount: 3 }))
  await act(async () => page.getByRole('button', { name: '添加批注' }).click())
  await act(async () => page.getByRole('textbox', { name: '批注意见' }).fill(note))
  await act(async () => page.getByRole('button', { name: '添加批注' }).click())
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  backend = createChapterBackend()
  backend.install()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, spineFacts: SESSION, chapterRequest: null, writeRequest: null, sheet: null })
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
  useWorkflowStore.setState(original.workflow, true)
})

const reviewSheet = () => page.getByRole('complementary', { name: /审稿/ })
const dock = () => page.getByRole('region', { name: '本章批注' })
const proseWidth = () => document.querySelector('.stage-ch-prose')!.getBoundingClientRect().width

it('已审稿的稿在 1028px 下加批注：审稿报告让位给批注坞，正文栏不被两页挤窄；打开报告时坞让位，关掉报告坞带着原批注回来', async () => {
  await openChapter({ reviewed: true })
  await expect.element(reviewSheet()).toBeVisible()
  const widthWithOneSheet = proseWidth()

  await annotate('他第三次展开信纸。', '写出信纸上的字')

  await expect.element(dock()).toBeVisible()
  await expect.element(reviewSheet()).not.toBeInTheDocument()
  expect(proseWidth()).toBeGreaterThanOrEqual(widthWithOneSheet)

  await act(async () => page.getByRole('button', { name: '更多操作' }).click())
  await act(async () => page.getByRole('menuitem', { name: '审稿报告' }).click())
  await expect.element(reviewSheet()).toBeVisible()
  await expect.element(dock()).not.toBeInTheDocument()
  expect(proseWidth()).toBeGreaterThanOrEqual(widthWithOneSheet)

  await act(async () => page.getByRole('button', { name: '关闭审稿报告' }).click())
  await expect.element(dock()).toBeVisible()
  await expect.element(page.getByText('本章批注 · 1')).toBeVisible()
})

it('审稿报告开着时进入专注模式：报告随专注收起，批注坞回来，原批注仍可看', async () => {
  await openChapter({ reviewed: true })
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  await act(async () => page.getByRole('button', { name: '更多操作' }).click())
  await act(async () => page.getByRole('menuitem', { name: '审稿报告' }).click())
  await expect.element(dock()).not.toBeInTheDocument()

  await act(async () => useStageStore.setState({ focus: true }))

  await expect.element(reviewSheet()).not.toBeInTheDocument()
  await expect.element(dock()).toBeVisible()
  await expect.element(page.getByText('本章批注 · 1')).toBeVisible()
})

it('侧页记着本稿的审稿报告、本稿却没有审稿：报告画不出来，批注坞照常显示', async () => {
  await openChapter({ reviewed: false })
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  const filePath = useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)!.filePath!

  await act(async () => useStageStore.setState({ sheet: { kind: 'review', filePath } }))

  await expect.element(reviewSheet()).not.toBeInTheDocument()
  await expect.element(dock()).toBeVisible()
})

it('批注的原文滚出纸面后点「定位批注」：原文滚回可见范围，不压在吸顶的动作条下面', async () => {
  await openChapter({ reviewed: false, content: Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段：雨从傍晚开始就没有停过。`).join('\n\n') })
  await annotate('第 1 段：雨从傍晚开始就没有停过。', '写出雨声')
  const scroller = document.querySelector('.stage-ch-scroll')!
  await act(async () => { scroller.scrollTop = scroller.scrollHeight })
  const visible = () => {
    const mark = document.querySelector('.cm-editor-annotation')?.getBoundingClientRect()
    const top = document.querySelector('.stage-ch-actions-sticky')!.getBoundingClientRect().bottom
    return Boolean(mark && mark.top >= top && mark.bottom <= scroller.getBoundingClientRect().bottom)
  }
  expect(visible()).toBe(false)

  await act(async () => page.getByRole('button', { name: '定位批注 1' }).click())

  await expect.poll(visible).toBe(true)
})

async function startAnnotationRevision(reviewed = false, beforeAnnotate?: () => Promise<void>, executeGate?: Promise<unknown>, content = ORIGINAL) {
  const answer = backend.invoke.getMockImplementation()!
  let recovery: { view: object; modelId: string; sourceStatus: string; context: object } | null = null
  backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'editor-inline:begin') {
      const input = (args[0] as { input: { documentText: string } }).input
      const documentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.documentText))), byte => byte.toString(16).padStart(2, '0')).join('')
      const handle = { projectId: SESSION.projectId, epoch: SESSION.leaseId, rootActionId: 'root', runId: 'batch' }
      recovery = { view: { handle, status: 'running', artifacts: [] }, modelId: 'grok', sourceStatus: 'current', context: { ...input, kind: 'author-draft', documentHash } }
      return recovery
    }
    if (channel === 'editor-inline:execute') {
      await executeGate
      const content = ORIGINAL.replace('他第三次展开信纸。', '他第三次展开信纸，上面只有两个字：等我。')
      const run = { ...recovery!.view, status: 'completed', artifacts: [{ ...(recovery!.view as { handle: object }).handle, artifactId: 'proof', textHash: 'proof-hash', text: content, status: 'completed', compositionEligible: true }] }
      recovery = { ...recovery!, view: run }
      return { run, sourceStatus: 'current', outcome: { status: 'completed', content, finishReason: 'stop', receipt: { finishReason: 'stop' } } }
    }
    if (channel === 'editor-inline:read-recovery') return recovery
    if (channel === 'editor-inline:delivered') return undefined
    if (channel === 'db:annotation-commit') {
      const { draftId, after } = args[0] as { draftId: number; after: string }
      Object.assign(backend.state.drafts.find(draft => draft.id === draftId)!, { content: after })
      return { success: true }
    }
    return answer(channel, ...args)
  })
  await openChapter({ reviewed, content })
  await beforeAnnotate?.()
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  await act(async () => page.getByRole('button', { name: '统一修改（1）' }).click())
}

async function openAnnotationReview(reviewed = false, beforeAnnotate?: () => Promise<void>) {
  await startAnnotationRevision(reviewed, beforeAnnotate)
  const review = page.getByRole('region', { name: '批注修改对比' })
  await expect.element(review).toBeVisible()
  return review
}
const annotationCommits = () => backend.invoke.mock.calls.filter(([channel]) => channel === 'db:annotation-commit')

it('批注修改审阅到一半，这一稿被定稿：点「接受全部」提示到当前版本里改，不叫作者等任务结束', async () => {
  const review = await openAnnotationReview()

  await act(async () => useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, draftStatus: 'finalized' as const })) })))
  await act(async () => review.getByRole('button', { name: '接受全部' }).click())

  await expect.element(review.getByRole('alert')).toHaveTextContent('这一稿已定稿或有了新版本，修改没有保存。点「取消」后到当前版本里改。')
  expect(annotationCommits()).toEqual([])
})

it('批注修改审阅到一半，本章被任务占用：点「接受全部」仍提示等本章任务结束', async () => {
  const review = await openAnnotationReview()

  await act(async () => useWorkflowStore.setState({ activeRuns: [{ id: 'review-run', type: 'chapter_creation', title: '审稿第 3 章',
    status: 'running', projectPath: SESSION.projectPath, resourceKeys: ['chapter:3'], steps: [], currentStepIndex: 0, logs: [] } as never] }))
  await act(async () => review.getByRole('button', { name: '接受全部' }).click())

  await expect.element(review.getByRole('alert')).toHaveTextContent('修改还在，但正文现在不能编辑，没有保存。等本章任务结束再点「接受全部」，或点「取消」放弃。')
  expect(annotationCommits()).toEqual([])
})

const runSheet = () => page.getByRole('complementary', { name: '运行' })

it('审稿报告开着时加批注，用完后清空批注：报告回到侧栏', async () => {
  await openChapter({ reviewed: true })
  await expect.element(reviewSheet()).toBeVisible()
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  await expect.element(reviewSheet()).not.toBeInTheDocument()

  await act(async () => dock().getByRole('button', { name: '清空' }).click())

  await expect.element(dock()).not.toBeInTheDocument()
  await expect.element(reviewSheet()).toBeVisible()
})

it('审稿报告开着时加批注，统一修改接受全部写进正文后：报告回到侧栏', async () => {
  const review = await openAnnotationReview(true)
  await expect.element(reviewSheet()).not.toBeInTheDocument()

  await act(async () => review.getByRole('button', { name: '接受全部' }).click())

  await expect.element(review).not.toBeInTheDocument()
  await expect.element(page.getByText('他第三次展开信纸，上面只有两个字：等我。')).toBeVisible()
  await expect.element(reviewSheet()).toBeVisible()
})

it('运行侧页开着时加批注，删掉最后一条批注后：运行侧页回来', async () => {
  await openChapter({ reviewed: false })
  await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'history' } }))
  await expect.element(runSheet()).toBeVisible()
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  await expect.element(runSheet()).not.toBeInTheDocument()

  await act(async () => dock().getByRole('button', { name: '删除批注 1' }).click())

  await expect.element(dock()).not.toBeInTheDocument()
  await expect.element(runSheet()).toBeVisible()
  expect(useStageStore.getState().sheet).toEqual({ kind: 'run', tab: 'history' })
})

it('运行侧页开着时加批注，切到另一章：正文整个换掉，不把运行侧页放回来', async () => {
  await openChapter({ reviewed: false })
  await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'history' } }))
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  await expect.element(runSheet()).not.toBeInTheDocument()
  const other = backend.addDraft({ status: 'draft', chapterNumber: 4, content: '第四章只有一句。' })
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })

  await act(async () => { await openDraftTab(useDraftStore.getState().draftsByChapter[4]!.find(candidate => candidate.id === other.id)!, '第 4 章', SESSION) })

  await expect.element(page.getByText('第四章只有一句。')).toBeVisible()
  await expect.element(dock()).not.toBeInTheDocument()
  expect(useStageStore.getState().sheet).toBeNull()
})

it('运行侧页让位给批注后，本章被重读收起了侧页，再删掉批注：不放回运行侧页', async () => {
  await openChapter({ reviewed: false })
  await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'history' } }))
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  const filePath = useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)!.filePath!
  await act(async () => useStageStore.setState({ chapterRequest: { session: SESSION, filePath } }))
  await expect.element(dock()).toBeVisible()

  await act(async () => dock().getByRole('button', { name: '删除批注 1' }).click())

  await expect.element(dock()).not.toBeInTheDocument()
  expect(useStageStore.getState().sheet).toBeNull()
})

it('作者先关掉审稿报告再加批注，用完后：侧栏仍空着，不替作者打开报告', async () => {
  await openChapter({ reviewed: true })
  await act(async () => page.getByRole('button', { name: '关闭审稿报告' }).click())
  await expect.element(reviewSheet()).not.toBeInTheDocument()
  await annotate('他第三次展开信纸。', '写出信纸上的字')

  await act(async () => dock().getByRole('button', { name: '清空' }).click())

  await expect.element(dock()).not.toBeInTheDocument()
  await expect.element(reviewSheet()).not.toBeInTheDocument()
  expect(useStageStore.getState().sheet).toBeNull()
})

it('批注期间打开过报告又关掉，用完后：放回批注前开着的那一页', async () => {
  await openChapter({ reviewed: true })
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  await act(async () => page.getByRole('button', { name: '更多操作' }).click())
  await act(async () => page.getByRole('menuitem', { name: '审稿报告' }).click())
  await act(async () => page.getByRole('button', { name: '关闭审稿报告' }).click())
  await expect.element(dock()).toBeVisible()

  await act(async () => dock().getByRole('button', { name: '清空' }).click())

  await expect.element(reviewSheet()).toBeVisible()
})

it('报告让位后批注随修稿合并收走，回到正文再加批注、用完：不放回早先那一页', async () => {
  await openChapter({ reviewed: true })
  await annotate('他第三次展开信纸。', '写出信纸上的字')
  const filePath = useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)!.filePath!
  await act(async () => { backend.addRevision(backend.state.drafts.at(-1)!); useStageStore.setState({ chapterRequest: { session: SESSION, filePath } }) })
  await act(async () => page.getByRole('button', { name: '稍后再合并' }).click())
  await expect.element(page.getByRole('region', { name: '修稿合并' })).not.toBeInTheDocument()
  await expect.element(reviewSheet()).not.toBeInTheDocument()
  await annotate('他第三次展开信纸。', '写出信纸上的字')

  await act(async () => dock().getByRole('button', { name: '清空' }).click())

  await expect.element(dock()).not.toBeInTheDocument()
  expect(useStageStore.getState().sheet).toBeNull()
})

it('报告开着时进入专注再加批注，用完退出专注：报告回到侧栏', async () => {
  await openChapter({ reviewed: true })
  await expect.element(reviewSheet()).toBeVisible()
  await act(async () => useStageStore.setState({ focus: true }))
  await annotate('他第三次展开信纸。', '写出信纸上的字')

  await act(async () => dock().getByRole('button', { name: '清空' }).click())
  await act(async () => useStageStore.setState({ focus: false }))

  await expect.element(reviewSheet()).toBeVisible()
})

it('作者先关掉审稿报告再加批注，统一修改接受全部写进正文后：侧栏仍空着', async () => {
  const review = await openAnnotationReview(true, async () => {
    await act(async () => page.getByRole('button', { name: '关闭审稿报告' }).click())
    await expect.element(reviewSheet()).not.toBeInTheDocument()
  })

  await act(async () => review.getByRole('button', { name: '接受全部' }).click())

  await expect.element(review).not.toBeInTheDocument()
  await expect.element(page.getByText('他第三次展开信纸，上面只有两个字：等我。')).toBeVisible()
  await expect.element(reviewSheet()).not.toBeInTheDocument()
  expect(useStageStore.getState().sheet).toBeNull()
})

const LOCK_HINT = '批注修改还在等你处理，修稿会冲掉它。先接受或取消批注修改。'
const refineItem = async () => {
  await act(async () => page.getByRole('button', { name: '更多操作' }).click())
  const item = page.getByRole('menuitem', { name: '直接修稿…' })
  await expect.element(item).toBeVisible()
  return item
}
const closeMenu = () => act(async () => page.getByRole('button', { name: '更多操作' }).click())
const reloadChapter = () => act(async () => useStageStore.setState({ chapterRequest: { session: SESSION, filePath: useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)!.filePath! } }))

it('已审稿的稿，批注修改审阅摆着：「按 N 项意见修稿」与「直接修稿」不可点并提示；点「取消」后恢复可点', async () => {
  const review = await openAnnotationReview(true)
  const revise = page.getByRole('button', { name: /项意见修稿$/ })

  await expect.element(revise).toBeDisabled()
  await expect.element(page.getByText(LOCK_HINT)).toBeVisible()
  await expect.element(await refineItem()).toBeDisabled()
  await closeMenu()

  await act(async () => review.getByRole('button', { name: '取消' }).click())

  await expect.element(revise).toBeEnabled()
  await expect.element(page.getByText(LOCK_HINT)).not.toBeInTheDocument()
  await expect.element(await refineItem()).toBeEnabled()
})

it('统一修改还在生成：「直接修稿」不可点并提示；取消生成后恢复可点', async () => {
  await startAnnotationRevision(false, undefined, new Promise(() => {}))
  await expect.element(page.getByText('正在生成', { exact: false })).toBeVisible()

  await expect.element(page.getByText(LOCK_HINT)).toBeVisible()
  await expect.element(await refineItem()).toBeDisabled()
  await closeMenu()

  await act(async () => page.getByRole('toolbar', { name: '选中文字的操作' }).getByRole('button', { name: '取消' }).click())

  await expect.element(page.getByText(LOCK_HINT)).not.toBeInTheDocument()
  await expect.element(await refineItem()).toBeEnabled()
})

it('有待合并的修稿、作者选了稍后再合并，批注修改审阅摆着：「打开修稿合并」不可点，审阅留着；点「取消」后恢复可点', async () => {
  const review = await openAnnotationReview(false, async () => {
    backend.addRevision(backend.state.drafts.at(-1)!)
    await reloadChapter()
    await act(async () => page.getByRole('button', { name: '稍后再合并' }).click())
    await expect.element(page.getByRole('region', { name: '修稿合并' })).not.toBeInTheDocument()
  })
  const openMerge = page.getByRole('button', { name: '打开修稿合并' })

  await expect.element(openMerge).toBeDisabled()
  await expect.element(page.getByText(LOCK_HINT)).toBeVisible()
  await expect.element(review).toBeVisible()

  await act(async () => review.getByRole('button', { name: '取消' }).click())

  await expect.element(openMerge).toBeEnabled()
})

it('有不能再合并的旧修稿，批注修改审阅摆着：「查看修稿」不可点；点「取消」后恢复可点', async () => {
  const review = await openAnnotationReview(false, async () => {
    backend.addRevision(backend.state.drafts.at(-1)!).source = null
    await reloadChapter()
    await expect.element(page.getByText('有 1 份修稿不能再合并')).toBeVisible()
  })
  const view = page.getByRole('button', { name: '查看修稿' })

  await expect.element(view).toBeDisabled()

  await act(async () => review.getByRole('button', { name: '取消' }).click())

  await expect.element(view).toBeEnabled()
})

it('统一修改生成中把正文滚远、生成失败：修稿入口不锁死', async () => {
  let fail!: (error: Error) => void
  const gate = new Promise((_, reject) => { fail = reject })
  gate.catch(() => {})
  const long = [ORIGINAL, ...Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 段：雨从傍晚开始就没有停过。`)].join('\n\n')
  await startAnnotationRevision(false, undefined, gate, long)
  await expect.element(page.getByText(LOCK_HINT)).toBeVisible()
  const scroller = document.querySelector('.stage-ch-scroll')!
  await act(async () => { scroller.scrollTop = scroller.scrollHeight })
  await expect.poll(() => document.querySelector('.cm-selbar')).toBeNull()

  await act(async () => fail(new Error('模型失败')))
  await act(async () => { scroller.scrollTop = 0 })

  await expect.element(page.getByText(LOCK_HINT)).not.toBeInTheDocument()
  await expect.element(dock().getByRole('button', { name: '统一修改（1）' })).toBeVisible()
  await expect.element(await refineItem()).toBeEnabled()
})

it('统一修改生成中作者改了正文、又滚到别处：结果停在预览时修稿入口仍锁着，点「回到预览」能找回预览并取消', async () => {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const long = [ORIGINAL, ...Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 段：雨从傍晚开始就没有停过。`)].join('\n\n')
  await startAnnotationRevision(false, undefined, gate, long)
  await expect.element(page.getByText('正在生成', { exact: false })).toBeVisible()

  const scroller = document.querySelector('.stage-ch-scroll')!
  await act(async () => { scroller.scrollTop = scroller.scrollHeight })
  await expect.poll(() => document.querySelector('.cm-selbar')).toBeNull()
  await act(async () => page.getByText('第 200 段：雨从傍晚开始就没有停过。', { exact: true }).click())
  await act(async () => userEvent.keyboard('又'))
  await act(async () => finish())

  await expect.element(page.getByText(LOCK_HINT)).toBeVisible()
  await expect.element(await refineItem()).toBeDisabled()
  await closeMenu()

  await act(async () => page.getByRole('button', { name: '回到预览' }).click())
  const preview = page.getByRole('toolbar', { name: '选中文字的操作' })
  await expect.element(preview.getByText('正文或原目标已变化，结果未应用；你仍可复制预览内容')).toBeVisible()
  await expect.element(page.getByRole('button', { name: '回到预览' })).not.toBeInTheDocument()

  await act(async () => preview.getByRole('button', { name: '取消' }).click())

  await expect.element(page.getByText(LOCK_HINT)).not.toBeInTheDocument()
  await expect.element(dock().getByRole('button', { name: '统一修改（1）' })).toBeVisible()
})

it('统一修改生成中作者改了正文、另选了一段又滚开：点「回到预览」仍能摆出预览', async () => {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const long = [ORIGINAL, ...Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 段：雨从傍晚开始就没有停过。`)].join('\n\n')
  await startAnnotationRevision(false, undefined, gate, long)
  const scroller = document.querySelector('.stage-ch-scroll')!
  await act(async () => { scroller.scrollTop = scroller.scrollHeight })
  await act(async () => page.getByText('第 200 段：雨从傍晚开始就没有停过。', { exact: true }).click())
  await act(async () => userEvent.keyboard('又'))
  await act(async () => page.getByText('第 195 段：雨从傍晚开始就没有停过。', { exact: true }).click({ clickCount: 3 }))
  await act(async () => { scroller.scrollTop = scroller.scrollHeight / 2 })
  await expect.poll(() => document.querySelector('.cm-selbar')).toBeNull()
  await act(async () => finish())

  await act(async () => page.getByRole('button', { name: '回到预览' }).click())

  await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' }).getByText('正文或原目标已变化，结果未应用；你仍可复制预览内容')).toBeVisible()
})

it('取消统一修改后再恢复一次失败的运行：修稿入口不被锁住', async () => {
  await startAnnotationRevision(false, undefined, new Promise(() => {}))
  await act(async () => page.getByRole('toolbar', { name: '选中文字的操作' }).getByRole('button', { name: '取消' }).click())
  await expect.element(page.getByText(LOCK_HINT)).not.toBeInTheDocument()
  const answer = backend.invoke.getMockImplementation()!
  backend.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'editor-inline:read-recovery') throw new Error('读取失败')
    return answer(channel, ...args)
  })
  const filePath = useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)!.filePath!
  const handle = { projectId: SESSION.projectId, epoch: SESSION.leaseId, rootActionId: 'root', runId: 'other' }

  await act(async () => useStageStore.setState({ selectionRequest: { session: SESSION, filePath, handle, nonce: 1 } }))

  await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' }).getByText('无法恢复原运行')).toBeVisible()
  await expect.element(page.getByText(LOCK_HINT)).not.toBeInTheDocument()
})

it('批注修改审阅摆着时早先发起的修稿生成完成：不自动打开修稿合并，审阅留着；取消后点「打开修稿合并」可以打开', async () => {
  const review = await openAnnotationReview()

  await act(async () => { backend.addRevision(backend.state.drafts.at(-1)!) })
  await reloadChapter()

  await expect.element(page.getByRole('button', { name: '打开修稿合并' })).toBeDisabled()
  await expect.element(review).toBeVisible()
  await expect.element(page.getByRole('region', { name: '修稿合并' })).not.toBeInTheDocument()

  await act(async () => review.getByRole('button', { name: '取消' }).click())
  await expect.element(page.getByRole('button', { name: '打开修稿合并' })).toBeEnabled()
  expect(document.querySelector('[role="region"][aria-label="修稿合并"]')).toBeNull()
  await act(async () => page.getByRole('button', { name: '打开修稿合并' }).click())

  await expect.element(page.getByRole('region', { name: '修稿合并' })).toBeVisible()
})

it('批注修改审阅摆着时早先发起的修稿生成完成，作者接受全部：修改写进正文，那份修稿显示为不能再合并', async () => {
  const review = await openAnnotationReview()
  await act(async () => { backend.addRevision(backend.state.drafts.at(-1)!) })
  await reloadChapter()
  await expect.element(page.getByRole('button', { name: '打开修稿合并' })).toBeDisabled()

  await act(async () => review.getByRole('button', { name: '接受全部' }).click())

  await expect.element(review).not.toBeInTheDocument()
  await expect.element(page.getByText('他第三次展开信纸，上面只有两个字：等我。')).toBeVisible()
  await expect.element(page.getByText('有 1 份修稿不能再合并')).toBeVisible()
  await expect.element(page.getByRole('region', { name: '修稿合并' })).not.toBeInTheDocument()
})

it('本章已有定稿，旧稿上批注修改审阅摆着：「以这一稿重新打开」不可点并提示，审阅留着；点「取消」后恢复可点', async () => {
  backend.addDraft({ status: 'finalized', version: 2, createdAt: '2026-10-13 20:30:00' })
  const review = await openAnnotationReview()
  const reopen = page.getByRole('button', { name: '以这一稿重新打开' })

  await expect.element(reopen).toBeDisabled()
  await expect.element(page.getByText(LOCK_HINT)).toBeVisible()
  await expect.element(review).toBeVisible()

  await act(async () => review.getByRole('button', { name: '取消' }).click())

  await expect.element(reopen).toBeEnabled()
  await expect.element(page.getByText(LOCK_HINT)).not.toBeInTheDocument()
})

it('本章有另一稿，批注修改审阅摆着：版本切换不可点，审阅留着；点「取消」后恢复可点', async () => {
  backend.addDraft({ status: 'finalized', version: 2, createdAt: '2026-10-13 20:30:00' })
  const review = await openAnnotationReview()
  const versions = page.getByRole('button', { name: /^本章版本：/ })

  await expect.element(versions).toBeDisabled()
  await expect.element(review).toBeVisible()

  await act(async () => review.getByRole('button', { name: '取消' }).click())

  await expect.element(versions).toBeEnabled()
})
