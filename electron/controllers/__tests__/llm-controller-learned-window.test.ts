import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { resolveContextWindow } from '../../../src/shared/model-profile-draft'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  models: { current: [] as unknown[] },
  fail: { current: false },
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) }) },
}))

vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: {},
  readJsonFile: vi.fn((filePath: string, fallback: unknown) => filePath === 'models.json' ? mocks.models.current : fallback),
  tryReadJsonFile: vi.fn(() => {
    if (mocks.fail.current) return { status: 'error', error: new Error('corrupt') }
    return { status: 'ok', value: structuredClone(mocks.models.current) }
  }),
  writeJsonFile: vi.fn((filePath: string, value: unknown) => { if (filePath === 'models.json') mocks.models.current = structuredClone(value) as unknown[] }),
}))

vi.mock('../../llm/llm-factory', () => ({ LLMFactory: { getProvider: vi.fn() } }))

import { registerLLMController } from '../llm-controller'

const profile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'm', name: 'M', provider: 'custom', protocol: 'openai', modelName: 'future', apiKey: 'k', baseUrl: 'https://compatible.example/v1',
  temperature: 0.7, maxTokens: 65_536, purposes: ['generation'], ...overrides })
const stored = () => mocks.models.current[0] as ModelProfile

let remember: (model: ModelProfile, tokens: number) => void
const save = (model: ModelProfile) => mocks.handlers.get('llm:save-model')!({}, model)

beforeAll(() => { remember = registerLLMController().rememberContextWindow })
beforeEach(() => { mocks.models.current = [profile()]; mocks.fail.current = false })

describe('学到的窗口写进模型档案', () => {
  it('记到档案里，下次读出来就是学到的', () => {
    remember(profile(), 32_768)
    expect(resolveContextWindow(stored())).toEqual({ tokens: 32_768, source: 'learned' })
  })

  it('运行途中作者已经换了模型：不写', () => {
    remember(profile({ modelName: 'old-name' }), 32_768)
    expect(stored().learnedContextWindow).toBeUndefined()
  })

  it('读不了配置：不抛错，不影响这次失败的原因', () => {
    mocks.fail.current = true
    expect(() => remember(profile(), 32_768)).not.toThrow()
  })

  it('设置页拿旧数据保存，不会把学到的窗口抹掉', async () => {
    remember(profile(), 32_768)
    await save(profile({ name: '改名' }))
    expect(stored().name).toBe('改名')
    expect(resolveContextWindow(stored())).toEqual({ tokens: 32_768, source: 'learned' })
  })

  it('渲染端传来的值不算数', async () => {
    await save(profile({ learnedContextWindow: { tokens: 1, provider: 'custom', protocol: 'openai', baseUrl: 'https://compatible.example/v1', modelName: 'future' } }))
    expect(stored().learnedContextWindow).toBeUndefined()
  })

  it('保存时服务商、地址或模型名变了，学到的窗口作废', async () => {
    remember(profile(), 32_768)
    await save(profile({ modelName: 'other' }))
    expect(stored().learnedContextWindow).toBeUndefined()
    await save(profile())
    expect(resolveContextWindow(stored()).source).toBe('default')
  })
})
