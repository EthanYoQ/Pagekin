import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translate } from '../../../i18n/core'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowDefinition } from '../../../stores/workflow-store'
import { launchCreativeWorkflow } from '../creative-workflow-launcher'

vi.mock('../../workflow-guards', () => ({ guardArchitectureGeneration: () => ({ ok: true }) }))
vi.mock('../architecture-workflow', () => ({
  createArchitectureWorkflow: (params: { projectPath: string; projectSession: WorkflowDefinition['projectSession'] }) => ({
    type: 'generate_architecture', title: 'Architecture', projectPath: params.projectPath, projectSession: params.projectSession, steps: [],
  }),
}))

const session = { projectId: 'NovelA', leaseId: 'lease-NovelA', projectPath: 'C:/NovelA' }

beforeEach(() => {
  useLocaleStore.setState({ locale: 'en-US' })
})

afterEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', interfaceLocale: 'zh-CN' })
  useProjectStore.setState({ currentProject: null })
})

describe('创作工作流启动失败的说明按界面语言显示（#471）', () => {
  it('英文界面：项目会话已切换时说明是英文', async () => {
    useProjectStore.setState({ currentProject: null })

    await expect(launchCreativeWorkflow({ workflow: 'generate_draft', chapterNumber: 1 }, session))
      .rejects.toThrow(/^The project session changed, so the workflow did not start\.$/u)
  })

  it('英文界面：不能从对话启动的工作流说明是英文', async () => {
    useProjectStore.setState({
      currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId } as ProjectData,
    })

    await expect(launchCreativeWorkflow({ workflow: 'refine', chapterNumber: 1 }, session))
      .rejects.toThrow(/^refine needs an explicit draft ID and a fixed snapshot of its text\./u)
  })
})

it('启动后才失败时，报错用启动那一刻的界面语言，中途切换不影响', async () => {
  useLocaleStore.setState({ interfaceLocale: 'ja-JP', locale: 'en-US' })
  useProjectStore.setState({
    currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId } as ProjectData,
  })
  const realStart = useWorkflowStore.getState().startWorkflow
  let fail!: (error: Error) => void
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], startWorkflow: definition => {
    useWorkflowStore.setState({ activeRuns: [{ id: definition.runId, status: 'running' } as never] })
    return new Promise((_resolve, reject) => { fail = reject })
  } })
  try {
    await launchCreativeWorkflow({ workflow: 'generate_architecture' }, session)
    useLocaleStore.setState({ interfaceLocale: 'en-US', locale: 'en-US' })
    fail(new Error('PROJECT_NOT_OPEN'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(translate('ja-JP', 'error.projectNotOpen')).not.toBe(translate('en-US', 'error.projectNotOpen'))
    const logged = useWorkflowStore.getState().globalLogs.find(entry => entry.level === 'error')?.message
    expect(logged).toBe(`[Failed] Workflow errored after launch: ${translate('ja-JP', 'error.projectNotOpen')}`)
  } finally {
    useWorkflowStore.setState({ activeRuns: [], startWorkflow: realStart })
  }
})
