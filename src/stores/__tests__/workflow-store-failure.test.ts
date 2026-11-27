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

const legacyFields = (run: WorkflowRun) => ({
  runError: run.error, runCode: run.errorCode, stepError: run.steps[0].error, stepCode: run.steps[0].errorCode,
})

const throws = [
  ['整条是码', () => new Error('PROJECT_NOT_OPEN'), { runError: 'PROJECT_NOT_OPEN', runCode: undefined, stepError: 'PROJECT_NOT_OPEN', stepCode: undefined }],
  ['句子', () => new Error(sentence), { runError: sentence, runCode: undefined, stepError: sentence, stepCode: undefined }],
  ['句子另挂码', () => Object.assign(new Error(sentence), { code: 'NETWORK_ERROR' }), { runError: sentence, runCode: 'NETWORK_ERROR', stepError: sentence, stepCode: 'NETWORK_ERROR' }],
  ['message 为空另挂码', () => Object.assign(new Error(''), { code: 'PROJECT_NOT_OPEN' }), { runError: '', runCode: 'PROJECT_NOT_OPEN', stepError: '', stepCode: 'PROJECT_NOT_OPEN' }],
  ['message 为空也没有码', () => new Error(''), { runError: '', runCode: undefined, stepError: '', stepCode: undefined }],
] as const

describe('步骤失败后 run.error、step.error、errorCode 与 master 相同', () => {
  it.each(throws)('%s', async (_name, thrown, expected) => {
    expect(legacyFields(await failedRun(thrown()))).toEqual(expected)
  })

  it('AuthorError：与 master 上 Object.assign(new Error(说明), { code }) 写出的相同', async () => {
    const migrated = authorError(shown('zh-CN'), { code: 'NETWORK_ERROR', note: catalogNote('error.proxyUnreachable') })
    const master = Object.assign(new Error(migrated.message), { code: 'NETWORK_ERROR' })
    expect(legacyFields(await failedRun(migrated))).toEqual(legacyFields(await failedRun(master)))
  })
})

it('认不出的失败存下来没有 note', async () => {
  for (const thrown of [new Error(''), new Error('某处中文原文'), Object.assign(new Error(''), { code: 'enoent' })]) {
    const run = await failedRun(thrown)
    expect([run.failure?.note, run.steps[0].failure?.note]).toEqual([undefined, undefined])
  }
})

describe('复验失败和正文生成失败读到的 run.error 与 master 相同', () => {
  const recheckFallback = '复验任务未完成；可在修复模型或资源问题后再次重试。'
  it.each(throws)('%s', async (_name, thrown, expected) => {
    const run = await failedRun(thrown())
    expect(run.error || recheckFallback).toBe(expected.runError || recheckFallback)
    expect(new Error(run.error).message).toBe(expected.runError)
  })
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
    expect(run.error).toBe('写作 Skill 快照加载失败，工作流未启动')
    expect(run.error).not.toContain(raw)
    expect(failureText(shown('en-US'), run.failure)).toBe('Writing skill snapshot could not be loaded, so the workflow was not started.')
  })

  it('原来能看到的具体说明逐字保留：绑定文件损坏', async () => {
    const run = await snapshotFailedRun(channel => channel === 'fs:check-exists' ? true : { success: true, content: '{broken' })
    expect(run.error).toBe('写作 Skill 快照加载失败，工作流未启动：写作 Skill 绑定文件已损坏')
  })
})
