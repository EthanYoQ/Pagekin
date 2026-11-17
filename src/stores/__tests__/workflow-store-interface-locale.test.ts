import { beforeEach, expect, it, vi } from 'vitest'

import { localize, translate } from '../../i18n/core'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { useWorkflowStore, type WorkflowContext } from '../workflow-store'

const projectSession = { projectId: 'lighthouse', leaseId: 'lease-lighthouse', projectPath: 'C:\\novels\\lighthouse' }

beforeEach(() => {
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'skills:list-user') return []
        if (channel === 'fs:check-exists') return false
        throw new Error(`unexpected ${channel}`)
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
    },
  })
  useLocaleStore.setState({ interfaceLocale: 'ja-JP', locale: 'en-US' })
  useProjectStore.setState({
    currentProject: { id: projectSession.projectId, sessionLease: projectSession.leaseId, name: 'Lighthouse', path: projectSession.projectPath, novelConfig: {} } as never,
  })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1 })
})

it('日文界面下步骤因登记错误失败，日志里的原因是日文，运行记录的语言仍是 en-US', async () => {
  let seen: WorkflowContext | undefined
  await useWorkflowStore.getState().startWorkflow({
    type: 'chapter_creation',
    title: 'Chapter 1',
    projectPath: projectSession.projectPath,
    projectSession,
    steps: [{ name: 'Write', description: 'Write', executor: async (_step, context) => {
      seen = context
      throw new Error('PROJECT_NOT_OPEN')
    } }],
  })

  const failure = useWorkflowStore.getState().globalLogs.find(entry => entry.level === 'error')
  expect(failure?.message).toContain(translate('ja-JP', 'error.projectNotOpen'))
  expect(failure?.message).toContain('[Failed]')
  const run = useWorkflowStore.getState().history[0]
  expect(run.uiLocale).toBe('en-US')
  expect(JSON.stringify(run)).not.toContain('ja-JP')
  expect(seen?.uiLocale).toBe('en-US')
})

it('日文界面启动的运行：带日文的文案按运行冻结的文案语言写，运行记录里没有日文', async () => {
  await useWorkflowStore.getState().startWorkflow({
    type: 'chapter_creation',
    title: 'Chapter 1',
    projectPath: projectSession.projectPath,
    projectSession,
    steps: [{ name: 'Write', description: 'Write', executor: async (_step, context, callbacks) => {
      callbacks.log(localize(context.uiLocale, '已写好第 {n} 章', 'Chapter {n} written', '第 {n} 章を書きました', { n: 1 }))
      return localize(context.uiLocale, '写稿完成', 'Draft finished', '下書き完成')
    } }],
  })

  const run = useWorkflowStore.getState().history[0]
  expect(run.uiLocale).toBe('en-US')
  expect(JSON.stringify(run)).toContain('Chapter 1 written')
  expect(JSON.stringify(run)).toContain('Draft finished')
  expect(JSON.stringify(run)).not.toMatch(/書きました|下書き/u)
  expect(JSON.stringify(useWorkflowStore.getState().globalLogs)).not.toMatch(/書きました|下書き/u)
})
