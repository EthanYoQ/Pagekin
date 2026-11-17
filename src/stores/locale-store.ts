import { create, type StateCreator } from 'zustand'
import { ipc } from '../services/ipc-client'
import { copyLocale, localize, resolveInterfaceLocale, storedInterfaceLocale, translate, type MessageKey, type MessageParams } from '../i18n/core'
import { displayedErrorMessage } from '../i18n/app-errors'
import type { InterfaceLocale, Locale } from '../i18n/types'
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
  /** Language of colocated copy (`text`, `localize`) for the interface language: `ja-JP` reads `en-US`. */
  locale: Locale
  initialized: boolean
  init: () => Promise<void>
  setLocale: (locale: InterfaceLocale) => Promise<void>
  t: (key: MessageKey, params?: MessageParams) => string
  text: (zhCNText: string, enUSText: string, params?: MessageParams) => string
}

function localeFields(interfaceLocale: InterfaceLocale): Pick<LocaleState, 'interfaceLocale' | 'locale'> {
  return { interfaceLocale, locale: copyLocale(interfaceLocale) }
}

/**
 * Interface language in effect. Code that sets only `locale` (as tests do with setState) leaves
 * `interfaceLocale` behind; then `locale` wins, so the catalog and the colocated copy never disagree.
 */
function activeInterfaceLocale(state: Pick<LocaleState, 'interfaceLocale' | 'locale'>): InterfaceLocale {
  return copyLocale(state.interfaceLocale) === state.locale ? state.interfaceLocale : state.locale
}

export function createLocaleState(dependencies: LocaleDependencies): StateCreator<LocaleState> {
  return (set, get) => {
    let latestSave = 0
    // Components commonly select only `t` or `text`. Refreshing these reader
    // identities with the locale makes those subscriptions reactive while the
    // functions still resolve the latest locale when called from callbacks.
    const localeReaders = () => ({
      t: (key: MessageKey, params?: MessageParams) => translate(activeInterfaceLocale(get()), key, params),
      text: (zhCNText: string, enUSText: string, params?: MessageParams) => (
        localize(get().locale, zhCNText, enUSText, params)
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
        set({ ...localeFields(locale), initialized: true, ...localeReaders() })
      },
      async setLocale(locale) {
        const previousLocale = activeInterfaceLocale(get())
        if (locale === previousLocale) return
        const save = ++latestSave
        set({ ...localeFields(locale), ...localeReaders() })
        dependencies.setDocumentLanguage(locale)
        try {
          const result = await dependencies.saveLocale(locale)
          if (!result.success) throw new Error(result.error ?? 'Failed to persist locale')
        } catch (error) {
          if (save !== latestSave) return
          if (activeInterfaceLocale(get()) === locale) {
            set({ ...localeFields(previousLocale), ...localeReaders() })
            dependencies.setDocumentLanguage(previousLocale)
          }
          const previousCopyLocale = copyLocale(previousLocale)
          const reason = displayedErrorMessage(previousLocale, error)
          await dependencies.reportError?.(
            localize(previousCopyLocale, `语言设置保存失败：${reason}`, `Could not save the language setting: ${reason}`),
            localize(previousCopyLocale, '语言设置保存失败', 'Could not save language setting'),
          )
        }
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

export function currentInterfaceLocale(): InterfaceLocale {
  return activeInterfaceLocale(useLocaleStore.getState())
}
