import { create, type StateCreator } from 'zustand'
import { ipc } from '../services/ipc-client'
import { copyLocale, localize, resolveInterfaceLocale, selectCopy, storedInterfaceLocale, translate, type LocalizedText, type MessageKey, type MessageParams } from '../i18n/core'
import { displayedErrorMessage } from '../i18n/app-errors'
import type { ErrorDisplayLocale, InterfaceLocale, Locale } from '../i18n/types'
import type { GlobalConfig } from '../shared/ipc-channels'

export interface LocaleDependencies {
  loadConfig: () => Promise<Partial<GlobalConfig>>
  saveLocale: (locale: InterfaceLocale) => Promise<{ success: boolean; error?: string }>
  systemLocale: () => string | undefined
  setDocumentLanguage: (locale: InterfaceLocale) => void
  reportError?: (message: string, title: string) => void | Promise<void>
}

export interface LocaleState {
  /** Language chosen for the interface, including languages that colocated copy does not have yet. */
  interfaceLocale: InterfaceLocale
  /** Copy language of the interface language (`ja-JP` reads `en-US`); runs freeze this one. */
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

/**
 * Interface language in effect. Code that sets only `locale` (as tests do with setState) leaves
 * `interfaceLocale` behind; then `locale` wins, so the catalog and the colocated copy never disagree.
 */
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
    // Components commonly select only `t` or `text`. Refreshing these reader
    // identities with the locale makes those subscriptions reactive while the
    // functions still resolve the latest locale when called from callbacks.
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
          if (!result.success) throw new Error(result.error ?? 'Failed to persist locale')
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
