import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import PostProcessSteps from '../PostProcessSteps'
import { SESSION, chapterProject, createChapterBackend } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalProject = useProjectStore.getState()
let root: Root | undefined
let host: HTMLDivElement | undefined
let backend: ReturnType<typeof createChapterBackend>

const render = (busy: boolean) => act(async () => root!.render(
  <PostProcessSteps chapterNumber={3} publication={undefined} busy={busy} onRetryStep={vi.fn()} onRetryFailed={vi.fn()} onRetryPublication={vi.fn()} />,
))

const KB_UNAVAILABLE = '知识库不可用：Windows 原生组件加载失败。请重新安装或下载完整发布包。'
const SESSION_STALE = '项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。'
const failedWith = (errorMsg: string) => ({ steps: [
  { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
  { stepKey: 'character_cards', label: '角色状态更新', ok: false, attemptCount: 1, errorMsg },
] })

beforeEach(() => {
  backend = createChapterBackend()
  backend.install()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState(originalProject, true)
})

it('#420 修复失败后不发 WORKFLOW_COMPLETE：本章由忙转闲时重读，失败说明换成最新一次的原因', async () => {
  // 落库原文不显示（#845 PR-H2），用两个已登记的码区分前后两次的原因。
  backend.state.postProcess = failedWith('KNOWLEDGE_BASE_NATIVE_UNAVAILABLE')
  await render(false)
  await expect.element(page.getByText(KB_UNAVAILABLE)).toBeVisible()

  await render(true)
  backend.state.postProcess = failedWith('PROJECT_SESSION_STALE')
  await render(false)

  await expect.element(page.getByText(SESSION_STALE)).toBeVisible()
  expect(host!.textContent).not.toContain(KB_UNAVAILABLE)
})

it('#702 步骤表外、已登记的码：落库的裸码和带 IPC 包装的码都显示报错目录文案，不露码名', async () => {
  for (const [errorMsg, shownText] of [
    ['KNOWLEDGE_BASE_NATIVE_UNAVAILABLE', KB_UNAVAILABLE],
    ["Error invoking remote method 'project-session:invoke': Error: PROJECT_SESSION_STALE", SESSION_STALE],
  ]) {
    backend.state.postProcess = failedWith(errorMsg)
    await render(true)
    await render(false)
    await expect.element(page.getByText(shownText)).toBeVisible()
    expect(host!.textContent).not.toMatch(/[A-Z]+_[A-Z_]+|Error invoking/u)
  }
})

it('两张表都有的码仍按后处理步骤说明，英文界面同样', async () => {
  backend.state.postProcess = failedWith('KNOWLEDGE_BASE_VOLUME_UNSUPPORTED')
  await render(false)
  await expect.element(page.getByText(/从新位置打开后再点「重试」/u)).toBeVisible()

  useLocaleStore.setState({ locale: 'en-US' })
  backend.state.postProcess = failedWith('FINALIZATION_GENERATION_INCOMPLETE')
  await render(true)
  await render(false)
  await expect.element(page.getByText(/The model did not return a complete result/u)).toBeVisible()
})
