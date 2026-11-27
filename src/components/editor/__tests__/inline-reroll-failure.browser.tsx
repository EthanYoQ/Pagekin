import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const mocks = vi.hoisted(() => ({ rejection: new Error('') }))
vi.mock('../../../services/editor-inline-generation', () => ({
  createEditorInlineGeneration: () => ({ open: () => Promise.reject(mocks.rejection), execute: vi.fn(), cancel: vi.fn(async () => {}), detach: vi.fn() }),
}))

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import InlineAnnotationReview from '../InlineAnnotationReview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
beforeEach(() => { setActiveProjectSessionContext({ projectId: 'p', projectPath: 'C:/p', leaseId: 'l' }); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setActiveProjectSessionContext(null) })

it.each([
  ['主进程的笼统失败', 'IPC_HANDLER_FAILED', '重新生成失败，请重试'],
  ['登记过的码', 'GENERATION_SOURCE_CHANGED', null],
])('逐处重新生成失败时，%s的说明与兜底句', async (_, code, expected) => {
  mocks.rejection = new Error(`Error invoking remote method 'editor-inline:begin': Error: ${code}`)
  await act(async () => root.render(<InlineAnnotationReview before="春雨落下。" after="秋雨落下。" annotations={[]} onCommit={async () => {}} onCancel={() => {}} />))
  await act(async () => page.getByRole('button', { name: '查看修改 1' }).click())
  await act(async () => page.getByRole('button', { name: '重新生成' }).click())
  if (expected) await expect.element(page.getByText(expected)).toBeVisible()
  else {
    await expect.element(page.getByRole('alert')).toBeVisible()
    expect(host.textContent).not.toContain('重新生成失败，请重试')
    expect(host.textContent).not.toMatch(/[A-Z]+_[A-Z_]+/u)
  }
})
