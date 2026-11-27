import { afterEach, expect, it, vi } from 'vitest'
import { requireIpcSuccess } from '../ipc-result'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage, errorCodeOf, failureText, caughtFailure, receivedIpcResult, wireNote } from '../../i18n/app-errors'
import { publicIpcResult } from '../../../electron/ipc/handle'
import { shown } from '../../i18n/__tests__/shown-locale'

const original = useLocaleStore.getState()
afterEach(() => {
  useLocaleStore.setState(original, true)
  vi.restoreAllMocks()
})

function thrownBy(run: () => unknown): Error {
  try { run() } catch (error) { return error as Error }
  throw new Error('应当失败')
}

const overIpc = (value: unknown) => receivedIpcResult(publicIpcResult(value)) as { success: boolean }

it('requireIpcSuccess 遇到没有码的失败时作者看到调用点的兜底说明，原文只进日志', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })

  const raw = 'connect ECONNREFUSED 127.0.0.1:7890 (#897)'
  const cases: Array<[string, { success: boolean }]> = [
    ['渲染端返回的原文', { success: false, error: raw } as { success: boolean }],
    ['主进程回的原文经 handle() 换成通用码', overIpc({ success: false, error: raw })],
    ['不带失败', { success: false }],
  ]
  for (const [name, result] of cases) {
    const withFallback = thrownBy(() => requireIpcSuccess(result, '保存草稿', '草稿没有保存，请再试一次。'))
    expect(displayedErrorMessage('zh-CN', withFallback), name).toBe('草稿没有保存，请再试一次。')
    expect(failureText('zh-CN', caughtFailure(withFallback)), name).toBe('草稿没有保存，请再试一次。')
    const withoutFallback = thrownBy(() => requireIpcSuccess(result, '保存草稿'))
    expect(displayedErrorMessage('zh-CN', withoutFallback), name).toBe('保存草稿失败，请再试一次。')
    expect(withoutFallback.message, name).not.toContain('ECONNREFUSED')
  }
  expect(warn.mock.calls.flat().some(arg => String(arg).includes(raw))).toBe(true)

  useLocaleStore.setState({ interfaceLocale: 'en-US', locale: 'en-US' })
  const english = thrownBy(() => requireIpcSuccess({ success: false }, '保存草稿'))
  expect(displayedErrorMessage('en-US', english)).toBe('The operation did not finish. Try again.')
  expect(displayedErrorMessage(shown('ja-JP'), english)).toBe('操作は完了しませんでした。もう一度お試しください。')
})

it('原来能看到的具体说明逐字保留', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  const cases: Array<[string, unknown, string]> = [
    ['export-service 写入导出文件（fs:grant-write-file）', { success: false, failure: { code: 'SECURE_FS_TARGET_IN_USE', note: wireNote('error.exportTargetInUse') } },
      '文件没有改动。目标文件正被其他程序打开，关掉它后再点「选择目录并导出」。'],
    ['export-service 创建导出目录（fs:grant-mkdir）', { success: false, failure: { code: 'PROJECT_DIRECTORY_CREATE_FAILED', note: wireNote('error.projectDirectoryCreateFailed') } },
      '无法创建项目目录。'],
    ['savePartialData（fs:write-json）', { success: false, failure: { code: 'PROJECT_DATA_WRITE_FAILED', note: wireNote('error.projectDataWriteFailed') } },
      '无法写入项目数据。'],
    ['prompt-catalog 与架构清理检查点（fs:write-file）', { success: false, failure: { code: 'PROJECT_FILE_WRITE_FAILED', note: wireNote('error.projectFileWriteFailed') } },
      '无法写入项目文件。'],
    ['已登记码不带说明', { success: false, error: 'Error: GENERATION_PROJECT_SESSION_STALE' },
      '作品已切换或重新打开，这次操作属于之前打开的作品，结果不可用。请在当前作品里查看，需要时重新操作。'],
  ]
  for (const [name, value, expected] of cases) {
    const thrown = thrownBy(() => requireIpcSuccess(overIpc(value), '保存', '调用点兜底说明。'))
    expect(thrown.message, name).toBe(expected)
    expect(displayedErrorMessage('zh-CN', thrown), name).toBe(expected)
  }
})

it('兜底说明不改失败带的码，定稿后处理记下的码与之前相同', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(errorCodeOf(thrownBy(() => requireIpcSuccess(overIpc({ success: false, error: 'boom' }), '导入知识库')))).toBe('IPC_HANDLER_FAILED')
  expect(errorCodeOf(thrownBy(() => requireIpcSuccess({ success: false, error: 'WORKFLOW_UNREGISTERED_TEST_CODE' } as { success: boolean }, '导入知识库'))))
    .toBe('WORKFLOW_UNREGISTERED_TEST_CODE')
  expect(errorCodeOf(thrownBy(() => requireIpcSuccess({ success: false }, '导入知识库')))).toBeUndefined()
})
