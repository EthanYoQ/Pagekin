/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import type { ProjectData } from '../../../../shared/ipc-channels'
import type { GenerationTransportDiagnostics } from '../../../../shared/generation-contract'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore, type StepCallbacks, type WorkflowRun } from '../../../../stores/workflow-store'
import RunCapsule from '../../RunCapsule'
import RunSheet from '../RunSheet'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore].map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let finishers: Array<() => Promise<void>>

const SHEET = { kind: 'run', tab: 'active' } as const

function App({ sheet }: { sheet: boolean }) {
  return <><RunCapsule />{sheet && <RunSheet sheet={SHEET} />}</>
}

async function mount(sheet = true) {
  await act(async () => root!.render(<App sheet={sheet} />))
}

/** 起一条真实工作流，单步卡在执行器里，测试直接调步骤回调，等于模型那头在上报。 */
async function start(title = '拆书') {
  let callbacks: StepCallbacks | undefined
  let release = () => {}
  const held = new Promise<string>(resolve => { release = () => resolve('完成') })
  const pending = useWorkflowStore.getState().startWorkflow({ type: 'post_process', title, projectPath: session.projectPath, projectSession: session, steps: [
    { name: '分析章节', description: '', executor: async (_step, _context, stepCallbacks) => { callbacks = stepCallbacks; return held } },
  ] })
  finishers.push(async () => { release(); await pending })
  await vi.waitFor(() => expect(callbacks).toBeTruthy())
  await act(async () => {})
  return callbacks!
}

const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })
const report = (update: () => void) => act(async () => update())
const notes = () => [...host!.querySelectorAll('.run-step-wait')].map(node => node.textContent)
const capsule = () => host!.querySelector('.stage-capsule')?.textContent ?? ''

const diagnostics = (extra: Partial<GenerationTransportDiagnostics> = {}): GenerationTransportDiagnostics => ({
  startedAt: 1, elapsedMs: 1000, firstResponseMs: null, lastResponseMs: null, lastOutputMs: null, phase: 'request', visibleEvents: 0, reasoningEvents: 0, ...extra })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  finishers = []
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { on: () => () => {}, invoke: vi.fn(async (channel: string) => {
    if (channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:list-recovery') return { planning: [], editors: [], reviews: [], drafts: [], batches: [], partial: false }
    if (channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    throw new Error(`未配置调用：${channel}`)
  }) } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '灯塔', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { await Promise.all(finishers.map(finish => finish())) })
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  vi.useRealTimers()
  for (const restore of restores) restore()
})

describe('长任务百分比不动时说明在等什么（#631）', () => {
  it('步骤运行中连续 15 秒没有进展才出现说明，已等时长随时间增加', async () => {
    await start()
    await mount()
    await advance(14_000)
    expect(notes()).toEqual([])
    await advance(1_000)
    expect(notes()).toEqual(['这一步还在进行，已等 15 秒'])
    await advance(10_000)
    expect(notes()).toEqual(['这一步还在进行，已等 25 秒'])
    await advance(50_000)
    expect(notes()).toEqual(['这一步还在进行，已等 1 分 15 秒'])
  })

  it.each([
    ['百分比变化', (callbacks: StepCallbacks) => callbacks.setProgress(50)],
    ['输出增长', (callbacks: StepCallbacks) => callbacks.appendText('林岚')],
    ['同一步开始下一次模型请求', (callbacks: StepCallbacks) => callbacks.setGenerationActivity!({ operation: 'import-global-facts' })],
    ['模型吐出思考', (callbacks: StepCallbacks) => callbacks.setGenerationActivity!({ operation: 'import-global-facts', diagnostics: diagnostics({ elapsedMs: 21_000, lastResponseMs: 21_000, lastOutputMs: 21_000, reasoningEvents: 1, phase: 'stream' }) })],
  ])('%s：说明立刻消失，下一次无进展从头计时', async (_name, progress) => {
    const callbacks = await start()
    await mount()
    await report(() => callbacks.setGenerationActivity!({ operation: 'import-global-facts' }))
    await advance(20_000)
    expect(notes()).toHaveLength(1)
    await report(() => progress(callbacks))
    expect(notes()).toEqual([])
    await advance(14_000)
    expect(notes()).toEqual([])
    await advance(1_000)
    expect(notes()[0]).toContain('已等 15 秒')
  })

  it('连接心跳和内容不变的快照不算进展，否则模型慢时说明永远出不来', async () => {
    const callbacks = await start()
    await report(() => {
      callbacks.setProgress(40)
      callbacks.replaceText!('已有内容')
      callbacks.setGenerationActivity!({ operation: 'import-global-facts' })
    })
    await mount()
    for (const elapsedMs of [5_000, 10_000, 14_000]) {
      await advance(5_000)
      await report(() => {
        callbacks.setProgress(40)
        callbacks.replaceText!('已有内容')
        callbacks.setGenerationActivity!({ operation: 'import-global-facts', diagnostics: diagnostics({ elapsedMs, lastResponseMs: elapsedMs, phase: 'stream' }) })
      })
    }
    expect(notes()).toEqual(['正在等模型回复，已等 15 秒'])
  })

  it('请求已经结束、这一步还没完：不说在等模型', async () => {
    const callbacks = await start()
    await mount()
    await report(() => callbacks.setGenerationActivity!({ operation: 'import-global-facts' }))
    await report(() => callbacks.setGenerationActivity!({ operation: 'import-global-facts', diagnostics: diagnostics({ phase: 'complete', endReason: 'completed' }) }))
    await advance(16_000)
    expect(notes()).toEqual(['这一步还在进行，已等 16 秒'])
  })

  it('关掉运行侧页再打开，已等时长不清零', async () => {
    await start()
    await mount()
    await advance(20_000)
    expect(notes()).toEqual(['这一步还在进行，已等 20 秒'])
    await mount(false)
    await advance(30_000)
    await mount(true)
    expect(notes()).toEqual(['这一步还在进行，已等 50 秒'])
  })

  it('顶栏胶囊在同样条件下显示已等时长', async () => {
    const callbacks = await start()
    await mount(false)
    await advance(14_000)
    expect(capsule()).not.toContain('已等')
    await advance(1_000)
    expect(capsule()).toContain('已等 15 秒')
    await advance(5_000)
    expect(capsule()).toContain('已等 20 秒')
    await report(() => callbacks.setProgress(60))
    expect(capsule()).not.toContain('已等')
  })

  it('胶囊和侧页先后打开，同屏的已等时长也一致', async () => {
    await start()
    await mount(false)
    await advance(500)
    await mount(true)
    await advance(20_000)
    const seconds = /已等 (\d+) 秒/
    expect(notes()).toHaveLength(1)
    expect(capsule().match(seconds)?.[1]).toBe(notes()[0]?.match(seconds)?.[1])
  })

  it('多项运行同时进行：胶囊显示等得最久的一项，那项有进展后换成另一项', async () => {
    const first = await start('拆书甲')
    await advance(10_000)
    await start('拆书乙')
    await mount(false)
    await advance(20_000)
    expect(capsule()).toBe('2 项运行中已等 30 秒')
    await report(() => first.setProgress(10))
    expect(capsule()).toBe('2 项运行中已等 20 秒')
    await report(() => useWorkflowStore.setState(state => ({ activeRuns: state.activeRuns.map(run => run.title === '拆书甲' ? { ...run, status: 'waiting' } : run) })))
    expect(capsule()).toBe('2 项运行中 · 1 项等你确认')
  })

  it.each<[WorkflowRun['status']]>([['paused'], ['cancelling'], ['waiting'], ['failed'], ['completed']])('运行状态为 %s 时侧页和胶囊都不显示', async status => {
    const callbacks = await start()
    await report(() => callbacks.setGenerationActivity!({ operation: 'review-chapter', diagnostics: diagnostics() }))
    await mount()
    await advance(30_000)
    expect(notes()).toHaveLength(1)
    await report(() => useWorkflowStore.setState(state => ({ activeRuns: state.activeRuns.map(run => ({ ...run, status })) })))
    await advance(1_000)
    expect(notes()).toEqual([])
    expect(capsule()).not.toContain('已等')
  })

  it('审稿步骤只有一条说明，原有的审稿等待内容还在', async () => {
    const callbacks = await start()
    await report(() => callbacks.setGenerationActivity!({ operation: 'review-chapter', diagnostics: diagnostics({ elapsedMs: 0, firstResponseMs: null }) }))
    await mount()
    await advance(20_000)
    expect(notes()).toHaveLength(1)
    expect(notes()[0]).toContain('尚未收到响应')
    expect(notes()[0]).toContain('尚无完整审稿报告')
    expect(capsule()).toContain('已等 20 秒')
  })

  describe('审稿等待中胶囊和侧页首行是同一个时长', () => {
    const review = (extra: Partial<GenerationTransportDiagnostics> = {}) => ({ operation: 'review-chapter', diagnostics: diagnostics(extra) })
    const firstLine = () => host!.querySelector('.run-step-wait > p')?.textContent

    it('两处读同一个已等时长，分钟格式也一致', async () => {
      const callbacks = await start()
      await report(() => callbacks.setGenerationActivity!(review({ elapsedMs: 90_000 })))
      await mount()
      await advance(20_000)
      expect(firstLine()).toBe('正在等模型回复，已等 20 秒')
      expect(capsule()).toContain('已等 20 秒')
      await advance(55_000)
      expect(firstLine()).toBe('正在等模型回复，已等 1 分 15 秒')
      expect(capsule()).toContain('已等 1 分 15 秒')
    })

    it('收到进展后两处同时清零，下一次无进展从头计时，审稿说明一直在', async () => {
      const callbacks = await start()
      await report(() => callbacks.setGenerationActivity!(review({ lastOutputMs: 1_000, reasoningEvents: 1, phase: 'stream' })))
      await mount()
      await advance(30_000)
      expect(capsule()).toContain('已等 30 秒')
      await report(() => callbacks.setGenerationActivity!(review({ elapsedMs: 31_000, lastResponseMs: 31_000, lastOutputMs: 31_000, reasoningEvents: 2, phase: 'stream' })))
      expect(capsule()).not.toContain('已等')
      expect(notes()).toHaveLength(1)
      expect(notes()[0]).not.toContain('已等')
      expect(notes()[0]).toContain('尚无完整审稿报告')
      await advance(15_000)
      expect(firstLine()).toBe('正在等模型回复，已等 15 秒')
      expect(capsule()).toContain('已等 15 秒')
    })

    it('英文界面两处也一致', async () => {
      useLocaleStore.setState({ locale: 'en-US' })
      const callbacks = await start()
      await report(() => callbacks.setGenerationActivity!(review()))
      await mount()
      await advance(20_000)
      expect(firstLine()).toBe('Waiting for the model, 20s so far')
      expect(capsule()).toContain('Waiting 20s')
    })
  })

  it('英文界面', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    const callbacks = await start()
    await mount()
    await advance(16_000)
    expect(notes()).toEqual(['This step is still running, 16s so far'])
    expect(capsule()).toContain('Waiting 16s')
    await report(() => callbacks.setGenerationActivity!({ operation: 'import-global-facts' }))
    await advance(75_000)
    expect(notes()).toEqual(['Waiting for the model, 1m 15s so far'])
    expect(capsule()).toContain('Waiting 1m 15s')
  })
})
