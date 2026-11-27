import { create, type StateCreator } from 'zustand'
import { ipc } from '../services/ipc-client'
import { copyLocale, localize, resolveInterfaceLocale, selectCopy, storedInterfaceLocale, translate, type LocalizedText, type MessageKey, type MessageParams } from '../i18n/core'
import { authorError, displayedErrorMessage, IPC_HANDLER_FAILED, resultFailure } from '../i18n/app-errors'
import type { ErrorDisplayLocale, InterfaceLocale, Locale } from '../i18n/types'
import type { GlobalConfig } from '../shared/ipc-channels'
import type { Failure } from '../shared/failure'

export interface LocaleDependencies {
  loadConfig: () => Promise<Partial<GlobalConfig>>
  saveLocale: (locale: InterfaceLocale) => Promise<{ success: boolean; failure?: Failure }>
  systemLocale: () => string | undefined
  setDocumentLanguage: (locale: InterfaceLocale) => void
  reportError?: (message: string, title: string) => void | Promise<void>
}

export interface LocaleState {
  interfaceLocale: InterfaceLocale
  locale: Locale
  initialized: boolean
  init: () => Promise<void>
  setLocale: (locale: InterfaceLocale) => Promise<void>
  t: (key: MessageKey, params?: MessageParams) => string
  text: LocalizedText
}

function localeFields(interfaceLocale: InterfaceLocale): Pick<LocaleState, 'interfaceLocale' | 'locale'> {
  return { interfaceLocale, locale: copyLocale(interfaceLocale) }
}

export function activeInterfaceLocale(state: Pick<LocaleState, 'interfaceLocale' | 'locale'>): ErrorDisplayLocale {
  return (copyLocale(state.interfaceLocale) === state.locale ? state.interfaceLocale : state.locale) as ErrorDisplayLocale
}

function createLocaleSaveLedger(initiallySaved: InterfaceLocale) {
  let saved = initiallySaved
  let savedSave = 0
  let sent = 0
  let settled = 0
  let failure: { error: unknown } | undefined
  return {
    loaded(locale: InterfaceLocale) { saved = locale },
    begin(): number { return ++sent },
    succeeded(save: number, locale: InterfaceLocale) {
      if (save <= savedSave) return
      saved = locale
      savedSave = save
    },
    failed(error: unknown) { failure = { error } },
    settle(): { error: unknown; saved: InterfaceLocale } | undefined {
      if (++settled < sent || !failure) return undefined
      const { error } = failure
      failure = undefined
      return { error, saved }
    },
  }
}

export function createLocaleState(dependencies: LocaleDependencies): StateCreator<LocaleState> {
  return (set, get) => {
    const ledger = createLocaleSaveLedger(resolveInterfaceLocale(dependencies.systemLocale()))
    const localeReaders = () => ({
      t: (key: MessageKey, params?: MessageParams) => translate(activeInterfaceLocale(get()), key, params),
      text: (zhCNText: string, enUSText: string, jaJPTextOrParams?: string | MessageParams, params?: MessageParams) => (
        selectCopy(activeInterfaceLocale(get()), zhCNText, enUSText, jaJPTextOrParams, params)
      ),
    })

    return {
      ...localeFields(resolveInterfaceLocale(dependencies.systemLocale())),
      initialized: false,
      ...localeReaders(),
      async init() {
        const config = await dependencies.loadConfig()
        const locale = storedInterfaceLocale(config.locale) ?? resolveInterfaceLocale(dependencies.systemLocale())
        dependencies.setDocumentLanguage(locale)
        ledger.loaded(locale)
        set({ ...localeFields(locale), initialized: true, ...localeReaders() })
      },
      async setLocale(locale) {
        if (locale === activeInterfaceLocale(get())) return
        const save = ledger.begin()
        set({ ...localeFields(locale), ...localeReaders() })
        dependencies.setDocumentLanguage(locale)
        try {
          const result = await dependencies.saveLocale(locale)
          // 抛 AuthorError 而不是字符串：回退语言后再按回退后的界面语言说明原因。
          if (!result.success) throw authorError(activeInterfaceLocale(get()), resultFailure(result) ?? { code: IPC_HANDLER_FAILED })
          ledger.succeeded(save, locale)
        } catch (error) {
          ledger.failed(error)
        }
        const unsaved = ledger.settle()
        if (!unsaved || activeInterfaceLocale(get()) === unsaved.saved) return
        const { error, saved: fallback } = unsaved
        set({ ...localeFields(fallback), ...localeReaders() })
        dependencies.setDocumentLanguage(fallback)
        const fallbackCopyLocale = copyLocale(fallback)
        const reason = displayedErrorMessage(activeInterfaceLocale(get()), error)
        await dependencies.reportError?.(
          localize(fallbackCopyLocale, `语言设置保存失败：${reason}`, `Could not save the language setting: ${reason}`),
          localize(fallbackCopyLocale, '语言设置保存失败', 'Could not save language setting'),
        )
      },
    }
  }
}

const browserDependencies: LocaleDependencies = {
  loadConfig: () => ipc.invoke('config:get'),
  saveLocale: locale => ipc.invoke('config:set', { locale }),
  systemLocale: () => globalThis.navigator?.language,
  setDocumentLanguage(locale) {
    if (globalThis.document) globalThis.document.documentElement.lang = locale
  },
  async reportError(message, title) {
    const { alertError } = await import('../components/ui/AlertDialog')
    await alertError(message, { title })
  },
}

export const useLocaleStore = create<LocaleState>(createLocaleState(browserDependencies))

export function currentInterfaceLocale(): ErrorDisplayLocale {
  return activeInterfaceLocale(useLocaleStore.getState())
}
