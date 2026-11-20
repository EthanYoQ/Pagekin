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
  backend.state.postProcess = failedWith('模型长时间没有响应')
  await render(false)
  await expect.element(page.getByText('模型长时间没有响应')).toBeVisible()

  await render(true)
  backend.state.postProcess = failedWith('向量服务没有响应')
  await render(false)

  await expect.element(page.getByText('向量服务没有响应')).toBeVisible()
  expect(host!.textContent).not.toContain('模型长时间没有响应')
})
