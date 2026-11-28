/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { RunCard } from '../RunCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const restores = [useProjectStore, useWorkflowStore, useLocaleStore].map(store => {
  const state = (store as StoreApi<unknown>).getState()
  return () => (store as StoreApi<unknown>).setState(state, true)
})
let root: Root, host: HTMLDivElement

function Card() {
  const run = useWorkflowStore(state => state.history[0])
  return run ? <RunCard run={run} /> : null
}

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', interfaceLocale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, currentRun: null })
  setActiveProjectSessionContext(session)
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    throw new Error(`测试未配置桌面调用：${channel}`)
  })
  Object.assign(window, { aiNovelAPI: { invoke, on: () => () => {}, once: vi.fn(), send: vi.fn() } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  setActiveProjectSessionContext(null); restores.forEach(restore => restore()); vi.restoreAllMocks()
})

async function failedCard(thrown: unknown) {
  await useWorkflowStore.getState().startWorkflow({ type: 'chapter_creation', title: '第 3 章 · 写稿', projectPath: session.projectPath, projectSession: session, steps: [
    { name: '写稿', description: '', executor: async () => { throw thrown } },
  ] })
  await act(async () => root.render(<Card />))
  const row = host.querySelector<HTMLButtonElement>('button.run-step-row')
  if (row) await act(async () => row.click())
  return {
    expandable: row !== null,
    stepError: host.querySelector('.run-step-error')?.textContent ?? null,
    notice: host.querySelector('.pi-notice-text p')?.textContent ?? null,
  }
}

it('只带已登记码、message 为空的失败步骤能展开并显示说明', async () => {
  const shown = await failedCard(Object.assign(new Error(''), { code: 'PROJECT_NOT_OPEN' }))
  expect(shown.expandable).toBe(true)
  expect(shown.stepError).toBe('请先打开项目。')
  expect(shown.notice).toBe('请先打开项目。')
})

it('认不出的失败显示时仍有通用说明', async () => {
  const shown = await failedCard(new Error(''))
  expect(shown.expandable).toBe(true)
  expect(shown.stepError).toBe('出了意外问题，暂时说不清原因。请再试一次。')
})

describe('未迁移的产生点在运行卡片上：登记码照常说明，没标记的句子只显示通用说明（#845 PR-H2）', () => {
  const proxy = '代理 127.0.0.1:7890 连不上，请在设置里检查代理。'
  const GENERIC = '出了意外问题，暂时说不清原因。请再试一次。'
  const NETWORK = '没连上模型服务，或回复中途断了。请检查网络或代理后重试。'
  it.each([
    ['整条是已登记码', new Error('PROJECT_NOT_OPEN'), '请先打开项目。', '请先打开项目。'],
    ['IPC 包着的已登记码', new Error("Error invoking remote method 'db:save': Error: PROJECT_NOT_OPEN"), '请先打开项目。', '请先打开项目。'],
    ['产生点写好的句子', new Error('第 3 章的大纲还没生成。'), GENERIC, '生成在完成前停止。'],
    ['句子另挂已登记码', Object.assign(new Error(proxy), { code: 'NETWORK_ERROR' }), NETWORK, NETWORK],
  ] as const)('%s', async (_name, thrown, stepError, notice) => {
    expect(await failedCard(thrown)).toEqual({ expandable: true, stepError, notice })
  })
})

describe('没登记的码不显示给作者，只进日志（#859）', () => {
  it.each([
    ['en-US', 'MADE_UP_ENGLISH_CODE', 'Something unexpected went wrong'],
    ['ja-JP', 'MADE_UP_JAPANESE_CODE', '予期しない問題'],
  ] as const)('%s 界面', async (locale, code, generic) => {
    useLocaleStore.setState({ locale: 'en-US', interfaceLocale: locale, initialized: true })
    await failedCard(new Error(`Error invoking remote method 'db:save': Error: ${code}`))
    expect(host.textContent).not.toContain(code)
    expect(host.querySelector('.run-step-error')?.textContent).toContain(generic)
    expect(host.querySelector('.pi-notice-text p')?.textContent).toContain(generic)
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain(code)
  })
})
