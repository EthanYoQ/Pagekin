import { create } from 'zustand'
import { useLocaleStore } from './locale-store'
import {
  APPEARANCE_STORAGE_KEY, INITIAL_APPEARANCE, LEGACY_THEME_STORAGE_KEY, PREVIOUS_APPEARANCE_STORAGE_KEY,
  AppearanceProfileError, migrateLegacyAppearance, migratePreviousAppearance, parseAppearanceProfile, serializeAppearanceProfile,
  type AppearancePatch, type CanonicalAppearanceProfile, type ColorTheme,
} from '../shared/appearance-profile'
import { mayHydrateAppearance } from '../shared/project-storage'
import type { AppearanceReadbackAck, StartupState } from '../shared/startup-contract'
export type { AppearanceReadbackAck } from '../shared/startup-contract'
export const systemColorTheme = (): ColorTheme => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

export interface AppearanceBootstrapDependencies {
  waitForMainReady(): Promise<StartupState>
  acknowledgeReadback(ack: AppearanceReadbackAck): Promise<boolean>
  storage?: () => Pick<Storage, 'getItem' | 'setItem'>
  systemTheme?: () => ColorTheme
}
export interface AppearanceBootstrapState {
  phase: 'pending' | 'migrated' | 'blocked'
  profile: Readonly<CanonicalAppearanceProfile> | null
  notice: string | null
  failureCode: string | null
  bootstrap(dependencies: AppearanceBootstrapDependencies): Promise<boolean>
  update(patch: AppearancePatch): boolean
  resetAppearance(): boolean
}

function readOrMigrate(storage: Pick<Storage, 'getItem'>, systemTheme: () => ColorTheme): { profile: CanonicalAppearanceProfile; stored: string | null } {
  const stored = storage.getItem(APPEARANCE_STORAGE_KEY)
  if (stored !== null) return { profile: parseAppearanceProfile(stored), stored }
  const previous = storage.getItem(PREVIOUS_APPEARANCE_STORAGE_KEY)
  if (previous !== null) return { profile: migratePreviousAppearance(previous), stored: null }
  return { profile: migrateLegacyAppearance(storage.getItem(LEGACY_THEME_STORAGE_KEY), systemTheme()), stored: null }
}

export function createAppearanceStore() {
  let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null
  let acknowledgedRaw: string | null = null
  let mainRevisionFloor = 0
  let inFlight: Promise<boolean> | null = null
  return create<AppearanceBootstrapState>()((set, get) => {
    const block = (error: unknown) => {
      set({ phase: 'blocked',
        notice: get().profile
          ? useLocaleStore.getState().text('外观偏好尚未安全保存，已保留原设置。请重试；当前工作台保持原状。', 'Appearance preferences could not be saved safely. Your previous settings and workspace are preserved. Please try again.')
          : useLocaleStore.getState().text('外观偏好尚未安全加载，已保留原设置。请重试；工作台尚未加载。', 'Appearance preferences could not be loaded safely. Your previous settings are preserved. Please try again before opening the workspace.'),
        failureCode: error instanceof AppearanceProfileError ? error.code : 'APPEARANCE_STORAGE_OR_MAIN_FAILED' })
      return false
    }
    return {
      phase: 'pending', profile: null, notice: null, failureCode: null,
      bootstrap(dependencies) {
        if (inFlight) return inFlight
        if (get().phase === 'migrated') return Promise.resolve(true)
        const run = async () => {
          set({ phase: 'pending', notice: null, failureCode: null })
          try {
            const ready = await dependencies.waitForMainReady()
            mainRevisionFloor = Math.max(mainRevisionFloor, ready.appearanceRevisionFloor ?? 0)
            if (!mayHydrateAppearance(ready)) throw new AppearanceProfileError('MAIN_NOT_READY')
            storage = (dependencies.storage ?? (() => window.localStorage))()
            const { profile, stored } = readOrMigrate(storage,
              dependencies.systemTheme ?? systemColorTheme)
            const serialized = stored ?? serializeAppearanceProfile(profile)
            if (stored === null) storage.setItem(APPEARANCE_STORAGE_KEY, serialized)
            if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_READBACK_FAILED')
            const accepted = await dependencies.acknowledgeReadback({ storageKey: APPEARANCE_STORAGE_KEY,
              profileRevision: profile.revision, globalGeneration: ready.globalGeneration })
            if (accepted !== true) throw new AppearanceProfileError('MAIN_ACK_REJECTED')
            acknowledgedRaw = serialized
            if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_CHANGED_DURING_ACK')
            set({ phase: 'migrated', profile: Object.freeze(profile), notice: null, failureCode: null })
            return true
          } catch (error) { return block(error) }
        }
        inFlight = run().finally(() => { inFlight = null })
        return inFlight
      },
      update(patch) {
        const current = get()
        if (current.phase !== 'migrated' || !current.profile || !storage || !acknowledgedRaw) return false
        try {
          if (storage.getItem(APPEARANCE_STORAGE_KEY) !== acknowledgedRaw) throw new AppearanceProfileError('APPEARANCE_CHANGED_EXTERNALLY')
          const serialized = serializeAppearanceProfile({ ...current.profile, ...patch, revision: current.profile.revision + 1, origin: 'author' })
          const next = parseAppearanceProfile(serialized)
          storage.setItem(APPEARANCE_STORAGE_KEY, serialized)
          if (storage.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_READBACK_FAILED')
          acknowledgedRaw = serialized
          set({ profile: Object.freeze(next), notice: null, failureCode: null })
          return true
        } catch (error) { return block(error) }
      },
      resetAppearance() {
        try {
          const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage)
          if (!target) return false
          let revision = Math.max(mainRevisionFloor, get().profile?.revision ?? 0, acknowledgedRaw ? parseAppearanceProfile(acknowledgedRaw).revision : 0)
          const existing = target.getItem(APPEARANCE_STORAGE_KEY)
          if (existing !== null) {
            try { revision = Math.max(revision, parseAppearanceProfile(existing).revision) }
            catch (error) { if (!(error instanceof AppearanceProfileError)) throw error }
          }
          const serialized = serializeAppearanceProfile({ ...INITIAL_APPEARANCE, revision: revision + 1, origin: 'author' })
          target.setItem(APPEARANCE_STORAGE_KEY, serialized)
          if (target.getItem(APPEARANCE_STORAGE_KEY) !== serialized) throw new AppearanceProfileError('APPEARANCE_READBACK_FAILED')
          set({ phase: 'pending', profile: null, notice: null, failureCode: null })
          return true
        } catch { return false }
      },
    }
  })
}

export const useAppearanceStore = createAppearanceStore()
export type AppearanceStore = ReturnType<typeof createAppearanceStore>
export { INITIAL_APPEARANCE }
