import { createStore } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createLocaleState } from '../locale-store'

describe('locale store', () => {
  it('prefers a saved locale over the operating-system locale', async () => {
    const state = createStore(createLocaleState({
      loadConfig: async () => ({ locale: 'zh-CN' }),
      saveLocale: vi.fn(async () => ({ success: true })),
      systemLocale: () => 'en-US',
      setDocumentLanguage: vi.fn(),
    }))

    await state.getState().init()

    expect(state.getState()).toMatchObject({ locale: 'zh-CN', initialized: true })
  })

  it('uses the operating-system locale without persisting it on first launch', async () => {
    const saveLocale = vi.fn(async () => ({ success: true }))
    const state = createStore(createLocaleState({
      loadConfig: async () => ({}),
      saveLocale,
      systemLocale: () => 'zh-TW',
      setDocumentLanguage: vi.fn(),
    }))

    await state.getState().init()

    expect(state.getState().locale).toBe('zh-CN')
    expect(saveLocale).not.toHaveBeenCalled()
  })

  it('persists a manual choice and updates the document language', async () => {
    const saveLocale = vi.fn().mockResolvedValue({ success: true })
    const setDocumentLanguage = vi.fn()
    const state = createStore(createLocaleState({
      loadConfig: async () => ({}),
      saveLocale,
      systemLocale: () => 'zh-CN',
      setDocumentLanguage,
    }))

    await state.getState().setLocale('en-US')

    expect(saveLocale).toHaveBeenCalledWith('en-US')
    expect(setDocumentLanguage).toHaveBeenCalledWith('en-US')
    expect(state.getState().locale).toBe('en-US')
  })

  it('selects a Japanese interface from a Japanese system locale and reads colocated copy in English', async () => {
    const state = createStore(createLocaleState({
      loadConfig: async () => ({}),
      saveLocale: vi.fn(async () => ({ success: true })),
      systemLocale: () => 'ja-JP',
      setDocumentLanguage: vi.fn(),
    }))

    await state.getState().init()

    expect(state.getState()).toMatchObject({ interfaceLocale: 'ja-JP', locale: 'en-US' })
    expect(state.getState().text('中文', 'English')).toBe('English')
    expect(state.getState().t('error.projectNotOpen')).toBe('先にプロジェクトを開いてください。')
  })

  it('persists a Japanese choice and sets the document language to Japanese', async () => {
    const saveLocale = vi.fn().mockResolvedValue({ success: true })
    const setDocumentLanguage = vi.fn()
    const state = createStore(createLocaleState({
      loadConfig: async () => ({}),
      saveLocale,
      systemLocale: () => 'zh-CN',
      setDocumentLanguage,
    }))

    await state.getState().setLocale('ja-JP')

    expect(saveLocale).toHaveBeenCalledWith('ja-JP')
    expect(setDocumentLanguage).toHaveBeenCalledWith('ja-JP')
    expect(state.getState()).toMatchObject({ interfaceLocale: 'ja-JP', locale: 'en-US' })
  })

  it('ignores an unknown stored locale and falls back to the operating-system locale', async () => {
    const state = createStore(createLocaleState({
      loadConfig: async () => ({ locale: 'ko-KR' as never }),
      saveLocale: vi.fn(async () => ({ success: true })),
      systemLocale: () => 'zh-CN',
      setDocumentLanguage: vi.fn(),
    }))

    await state.getState().init()

    expect(state.getState()).toMatchObject({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  })

  it('lets a locale set on its own win over a stale interface language', async () => {
    const saveLocale = vi.fn(async () => ({ success: true }))
    const state = createStore(createLocaleState({
      loadConfig: async () => ({ locale: 'ja-JP' }),
      saveLocale,
      systemLocale: () => 'ja-JP',
      setDocumentLanguage: vi.fn(),
    }))
    await state.getState().init()

    state.setState({ locale: 'zh-CN' })

    expect(state.getState().t('error.projectNotOpen')).toBe('请先打开项目。')
    await state.getState().setLocale('ja-JP')
    expect(saveLocale).toHaveBeenCalledWith('ja-JP')
    expect(state.getState()).toMatchObject({ interfaceLocale: 'ja-JP', locale: 'en-US' })
  })

  it('notifies components that subscribe only to locale readers', async () => {
    const state = createStore(createLocaleState({
      loadConfig: async () => ({}),
      saveLocale: vi.fn(async () => ({ success: true })),
      systemLocale: () => 'zh-CN',
      setDocumentLanguage: vi.fn(),
    }))
    const initialText = state.getState().text
    const initialTranslate = state.getState().t

    await state.getState().setLocale('en-US')

    expect(state.getState().text).not.toBe(initialText)
    expect(state.getState().t).not.toBe(initialTranslate)
  })

  it('localizes colocated component copy with the active locale', async () => {
    const state = createStore(createLocaleState({
      loadConfig: async () => ({}),
      saveLocale: vi.fn(async () => ({ success: true })),
      systemLocale: () => 'en-US',
      setDocumentLanguage: vi.fn(),
    }))

    expect(state.getState().text('中文', 'English')).toBe('English')
    await state.getState().setLocale('zh-CN')
    expect(state.getState().text('中文', 'English')).toBe('中文')
  })

  it.each([
    ['business failure', async () => ({ success: false, error: 'disk full' })],
    ['transport rejection', async () => { throw new Error('IPC unavailable') }],
  ] as const)('rolls back and reports a visible error after a %s', async (_label, saveLocale) => {
    const setDocumentLanguage = vi.fn()
    const reportError = vi.fn()
    const state = createStore(createLocaleState({
      loadConfig: async () => ({ locale: 'zh-CN' }),
      saveLocale,
      systemLocale: () => 'zh-CN',
      setDocumentLanguage,
      reportError,
    }))

    await expect(state.getState().setLocale('en-US')).resolves.toBeUndefined()

    expect(state.getState().locale).toBe('zh-CN')
    expect(setDocumentLanguage).toHaveBeenLastCalledWith('zh-CN')
    expect(reportError).toHaveBeenCalledWith(
      expect.stringMatching(/disk full|IPC unavailable/),
      '语言设置保存失败',
    )
  })
})
