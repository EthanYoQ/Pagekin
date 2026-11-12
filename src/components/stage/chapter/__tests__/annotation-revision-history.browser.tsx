import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useProjectStore } from '../../../../stores/project-store'
import AnnotationRevisionHistory from '../AnnotationRevisionHistory'
import { diffProse } from '../../history/version-diff'

vi.mock('../../history/version-diff', async importOriginal => {
  const actual = await importOriginal<typeof import('../../history/version-diff')>()
  return { ...actual, diffProse: vi.fn(actual.diffProse) }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const entries = [
  { id: 2, before: '我走进北塔。', after: '我走进南塔。', annotations: [{ id: 'b', from: 0, to: 6, selectedText: '我走进北塔。', instruction: '改成南塔' }], createdAt: '2026-11-11 09:00:00' },
  { id: 1, before: '林岚走进北塔。', after: '我走进北塔。', annotations: [{ id: 'a', from: 0, to: 7, selectedText: '林岚走进北塔。', instruction: '改成第一人称' }], createdAt: '2026-11-11 08:00:00' },
]

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  useProjectStore.setState({ currentProject: { id: 'history-project', sessionLease: 'history-epoch', path: 'C:/合成批注', novelConfig: {} } as never })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'db:annotation-history-list') return entries
      throw new Error(`Unexpected IPC channel: ${channel}`)
    }),
    on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(),
  } })
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useProjectStore.setState({ currentProject: null })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('列出批注历史，父组件重渲染时不重算整章差异', async () => {
  const Parent = ({ tick }: { tick: number }) => <div data-tick={tick}><AnnotationRevisionHistory draftId={7} projectKey="C:/合成批注" refresh={0} /></div>
  await act(async () => root.render(<Parent tick={0} />))
  await expect.element(page.getByText('批注历史版本（2）')).toBeVisible()
  const computed = vi.mocked(diffProse).mock.calls.length
  expect(computed).toBe(2)
  for (let tick = 1; tick <= 5; tick++) await act(async () => root.render(<Parent tick={tick} />))
  expect(vi.mocked(diffProse).mock.calls.length).toBe(computed)
})

it('把库里的 UTC 时刻按本机时区显示', async () => {
  await act(async () => root.render(<AnnotationRevisionHistory draftId={7} projectKey="C:/合成批注" refresh={0} />))
  await expect.element(page.getByText('批注历史版本（2）')).toBeVisible()
  const local = new Date(Date.UTC(2026, 10, 11, 8, 0, 0)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  expect(host.textContent).toContain(`${local} · `)
  expect(host.textContent).not.toContain('2026-11-11 08:00:00')
})
