import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Locale } from '../../i18n/types'
import { useLocaleStore } from '../locale-store'
import { useLLMStore } from '../llm-store'

const { invoke, alertError } = vi.hoisted(() => ({ invoke: vi.fn(), alertError: vi.fn() }))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke, get isElectron() { return true } },
}))

vi.mock('../../components/ui/AlertDialog', () => ({ alertError }))

const originalLocale = useLocaleStore.getState().locale

afterEach(() => {
  useLocaleStore.setState({ locale: originalLocale })
})

async function shownError(locale: Locale, run: () => Promise<unknown>): Promise<string> {
  useLocaleStore.setState({ locale })
  alertError.mockClear()
  await run()
  expect(alertError).toHaveBeenCalledOnce()
  return String(alertError.mock.calls[0]![0])
}

describe('model settings refusals from the main process (#474 B6)', () => {
  it.each([
    ['setDefaultModel', 'llm:set-default-model'],
    ['setDefaultEmbeddingModel', 'llm:set-default-embedding-model'],
  ] as const)('explains a damaged settings file from %s in the interface language', async (action, channel) => {
    invoke.mockImplementation(async (called: string) => (
      called === channel ? { success: false, error: 'Error: LLM_GLOBAL_CONFIG_CORRUPT' } : undefined
    ))

    const english = await shownError('en-US', () => useLLMStore.getState()[action]('model-1'))
    expect(english).toContain('The model settings file is damaged')
    expect(english).not.toMatch(/LLM_|\p{Script=Han}/u)

    const chinese = await shownError('zh-CN', () => useLLMStore.getState()[action]('model-1'))
    expect(chinese).toContain('模型设置文件已损坏')
    expect(chinese).not.toContain('LLM_')
  })

  it.each([
    ['Error: LLM_DEFAULT_MODEL_ROLLBACK_FAILED', 'The model was not deleted', '模型没有删除'],
    ['Error: LLM_MODEL_CONFIG_CORRUPT', 'The model settings file is damaged', '模型设置文件已损坏'],
  ])('explains a refused model deletion (%s) in the interface language', async (error, english, chinese) => {
    invoke.mockImplementation(async (called: string) => (called === 'llm:delete-model' ? { success: false, error } : undefined))

    const shownEnglish = await shownError('en-US', () => useLLMStore.getState().deleteModel('model-1'))
    expect(shownEnglish).toContain(english)
    expect(shownEnglish).not.toMatch(/LLM_|\p{Script=Han}/u)

    const shownChinese = await shownError('zh-CN', () => useLLMStore.getState().deleteModel('model-1'))
    expect(shownChinese).toContain(chinese)
    expect(shownChinese).not.toContain('LLM_')
  })

  it('模型设置失败不显示主进程交来的异常原文，删除模型改说删除失败', async () => {
    // llm:* 是直连通道，主进程 catch 里交的是 String(error)（electron/controllers/llm-controller.ts）。
    const raw = "Error: EBUSY: resource busy or locked, open 'C:\\Users\\a\\models.json'"
    invoke.mockImplementation(async (called: string) => (called.startsWith('llm:') ? { success: false, error: raw } : undefined))
    await expect(shownError('en-US', () => useLLMStore.getState().deleteModel('model-1'))).resolves.toBe('Could not delete the model.')
    await expect(shownError('zh-CN', () => useLLMStore.getState().setDefaultModel('model-1'))).resolves.toBe('出了意外问题，暂时说不清原因。请再试一次。')
    await expect(shownError('en-US', () => useLLMStore.getState().setStageModel('planning', 'model-1'))).resolves.toBe('Something unexpected went wrong. Try again.')
  })
})
