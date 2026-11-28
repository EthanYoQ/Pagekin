import { beforeEach, describe, expect, it, vi } from 'vitest'

import { authorError, catalogNote, failureText } from '../../i18n/app-errors'
import { shown } from '../../i18n/__tests__/shown-locale'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { useWorkflowStore, type WorkflowRun } from '../workflow-store'

const projectSession = { projectId: 'lighthouse', leaseId: 'lease-lighthouse', projectPath: 'C:\\novels\\lighthouse' }
const sentence = '代理 127.0.0.1:7890 连不上，请在设置里检查代理。'

beforeEach(() => {
  vi.stubGlobal('window', { aiNovelAPI: {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'skills:list-user') return []
      if (channel === 'fs:check-exists') return false
      throw new Error(`unexpected ${channel}`)
    }),
    on: vi.fn(() => () => {}),
    once: vi.fn(),
  } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  useProjectStore.setState({
    currentProject: { id: projectSession.projectId, sessionLease: projectSession.leaseId, name: 'Lighthouse', path: projectSession.projectPath, novelConfig: {} } as never,
  })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1 })
})

async function failedRun(thrown: unknown): Promise<WorkflowRun> {
  const runId = await useWorkflowStore.getState().startWorkflow({
    type: 'chapter_creation', title: '第 1 章', projectPath: projectSession.projectPath, projectSession,
    steps: [{ name: '写稿', description: '写稿', executor: async () => { throw thrown } }],
  })
  return useWorkflowStore.getState().history.find(run => run.id === runId)!
}

const stored = (run: WorkflowRun) => ({ run: run.failure, step: run.steps[0].failure })

const throws = [
  ['整条是码', () => new Error('PROJECT_NOT_OPEN'), { code: 'PROJECT_NOT_OPEN' }],
  ['句子', () => new Error(sentence), undefined],
  ['句子另挂码', () => Object.assign(new Error(sentence), { code: 'NETWORK_ERROR' }), { code: 'NETWORK_ERROR' }],
  ['message 为空另挂码', () => Object.assign(new Error(''), { code: 'PROJECT_NOT_OPEN' }), { code: 'PROJECT_NOT_OPEN' }],
  ['message 为空也没有码', () => new Error(''), undefined],
] as const

describe('步骤失败只存 failure：认得出的码留下，原文不进记录', () => {
  it.each(throws)('%s', async (_name, thrown, expected) => {
    const run = await failedRun(thrown())
    expect(stored(run)).toEqual({ run: expected, step: expected })
    expect(run).not.toHaveProperty('error')
    expect(run.steps[0]).not.toHaveProperty('error')
  })

  it('AuthorError 的 failure 原样存下', async () => {
    const migrated = authorError(shown('zh-CN'), { code: 'NETWORK_ERROR', note: catalogNote('error.proxyUnreachable') })
    expect(stored(await failedRun(migrated))).toEqual({ run: migrated.failure, step: migrated.failure })
  })
})

it('认不出的失败存下来没有 note', async () => {
  for (const thrown of [new Error(''), new Error('某处中文原文'), Object.assign(new Error(''), { code: 'enoent' })]) {
    const run = await failedRun(thrown)
    expect([run.failure?.note, run.steps[0].failure?.note]).toEqual([undefined, undefined])
  }
})

describe('写作 Skill 快照加载失败', () => {
  async function snapshotFailedRun(bindings: (channel: string) => unknown): Promise<WorkflowRun> {
    vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async (channel: string, path?: unknown) => {
      if (channel === 'skills:list-user') return []
      return typeof path === 'string' && path.endsWith('writing-skills.json') ? bindings(channel) : false
    }), on: vi.fn(() => () => {}), once: vi.fn() } })
    const runId = await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation', title: '第 1 章', projectPath: projectSession.projectPath, projectSession,
      steps: [{ name: '写稿', description: '写稿', executor: async () => undefined }],
    })
    return useWorkflowStore.getState().history.find(run => run.id === runId)!
  }

  it('渲染端余下的显示点不把原文交给作者：运行时原文只进日志', async () => {
    const raw = "Cannot read properties of undefined (reading 'bindings')"
    const run = await snapshotFailedRun(() => { throw new TypeError(raw) })
    expect(run.status).toBe('failed')
    expect(failureText(shown('zh-CN'), run.failure)).toBe('写作 Skill 快照加载失败，工作流未启动')
    expect(failureText(shown('en-US'), run.failure)).toBe('Writing skill snapshot could not be loaded, so the workflow was not started.')
  })

  it('原来能看到的具体说明逐字保留：绑定文件损坏', async () => {
    const run = await snapshotFailedRun(channel => channel === 'fs:check-exists' ? true : { success: true, content: '{broken' })
    expect(failureText(shown('zh-CN'), run.failure)).toBe('写作 Skill 快照加载失败，工作流未启动：写作 Skill 绑定文件已损坏')
  })
})
