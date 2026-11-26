import { create } from 'zustand'

export type SidebarView = 'home' | 'project'

export type SettingsSection = 'appearance' | 'llm' | 'embedding' | 'stage-models' | 'proxy' | 'prompts' | 'skills' | 'backup' | 'about'

export type ChapterWritePrefill = {
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string
  userGuidance: string
}

export interface LayoutFields {
  sidebarView: SidebarView
  settingsOpen: boolean
  settingsSection: SettingsSection
  newProjectOpen: boolean
  exportOpen: boolean
  importNovelOpen: boolean
}

interface LayoutState extends LayoutFields {
  setSidebarView: (view: SidebarView) => void
  closeSettings: () => void
  openNewProject: () => void
  closeNewProject: () => void
  openExport: () => void
  closeExport: () => void
  openImportNovel: () => void
  closeImportNovel: () => void
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  sidebarView: 'project',
  settingsOpen: false,
  settingsSection: 'llm',
  newProjectOpen: false,
  exportOpen: false,
  importNovelOpen: false,

  setSidebarView: (view) => set({ sidebarView: view }),
  closeSettings: () => set({ settingsOpen: false }),
  openNewProject: () => set({ newProjectOpen: true }),
  closeNewProject: () => set({ newProjectOpen: false }),
  openExport: () => set({ exportOpen: true }),
  closeExport: () => set({ exportOpen: false }),
  openImportNovel: () => set({ importNovelOpen: true }),
  closeImportNovel: () => set({ importNovelOpen: false }),
}))
