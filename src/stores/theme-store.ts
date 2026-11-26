import { create } from 'zustand'
import { useAppearanceStore, type AppearanceStore } from './appearance-bootstrap'
import { ipc } from '../services/ipc-client'
import type { ColorTheme } from '../shared/appearance-profile'

export type Theme = ColorTheme

export type FontId = 'inter' | 'noto-sans-sc' | 'lxgw-wenkai' | 'noto-serif-sc' | 'system'

export interface FontOption {
  id: FontId
  label: string
  labelEn: string
  desc: string
  descEn: string
  family: string
  preview: string
  previewEn: string
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: 'inter',
    label: 'Inter',
    labelEn: 'Inter',
    desc: '精心设计的现代 UI 字体，英文排版优秀，界面首选',
    descEn: 'A modern UI font designed for clear English interfaces',
    family: "'Inter', system-ui, sans-serif",
    preview: 'Aa Bb 文字 123',
    previewEn: 'Aa Bb Text 123',
  },
  {
    id: 'noto-sans-sc',
    label: '思源黑体',
    labelEn: 'Noto Sans SC',
    desc: '黑体风格，中英文兼顾，简洁现代，科幻都市题材适用',
    descEn: 'A clean modern sans serif for Chinese and English text',
    family: "'Noto Sans SC', sans-serif",
    preview: '思源黑体 Sans',
    previewEn: 'Noto Sans',
  },
  {
    id: 'lxgw-wenkai',
    label: '霞鹜文楷',
    labelEn: 'LXGW WenKai',
    desc: '楷体风格，温润典雅，最适合中文小说写作',
    descEn: 'A warm, elegant typeface suited to literary writing',
    family: "'LXGW WenKai', serif",
    preview: '春花秋月何时了',
    previewEn: 'Once upon a time',
  },
  {
    id: 'noto-serif-sc',
    label: '思源宋体',
    labelEn: 'Noto Serif SC',
    desc: '宋体风格，字形端正，印刷质感强，正式文稿首选',
    descEn: 'A formal serif with a print-like reading experience',
    family: "'Noto Serif SC', serif",
    preview: '往事如云烟，归零',
    previewEn: 'A story in print',
  },
  {
    id: 'system',
    label: '系统默认',
    labelEn: 'System UI',
    desc: 'macOS 使用苹方/SF Pro，原生手感，无需字体文件',
    descEn: 'Uses the operating system interface font with no extra files',
    family: 'system-ui, -apple-system, sans-serif',
    preview: 'Aa Bb 苹方 123',
    previewEn: 'Aa Bb System 123',
  },
]

export const WRITING_FONT_OPTIONS = FONT_OPTIONS
export type WritingFont = FontId

const ZOOM_STEP = 0.05
const ZOOM_MIN = 0.7
const ZOOM_MAX = 1.5
const BASE_FONT_SIZE = 14 as const

interface ThemeState {
  theme: Theme
  resolvedTheme: Theme
  zoom: number
  writingFont: FontId
  uiFont: FontId
  setTheme: (theme: Theme) => void
  initTheme: () => void
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
  setZoom: (zoom: number) => void
  setWritingFont: (font: FontId) => void
  setUiFont: (font: FontId) => void
}

export function createThemeStore(appearance: AppearanceStore = useAppearanceStore) {
  const store = create<ThemeState>()((set, get) => ({
    theme: 'light', resolvedTheme: 'light', zoom: 1, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc',
    setTheme: theme => { appearance.getState().update({ colorTheme: theme }) },
    initTheme: () => {
      const state = appearance.getState()
      if (state.phase !== 'migrated' || !state.profile) return
      const profile = state.profile
      set({ theme: profile.colorTheme, resolvedTheme: profile.colorTheme, zoom: profile.zoom,
        writingFont: profile.writingFont, uiFont: profile.uiFont })
      applyTheme(profile.colorTheme)
      applyZoom(profile.zoom)
      applyWritingFont(profile.writingFont)
      applyUiFont(profile.uiFont)
    },
    zoomIn: () => { appearance.getState().update({ zoom: Math.min(ZOOM_MAX, +(get().zoom + ZOOM_STEP).toFixed(2)) }) },
    zoomOut: () => { appearance.getState().update({ zoom: Math.max(ZOOM_MIN, +(get().zoom - ZOOM_STEP).toFixed(2)) }) },
    zoomReset: () => { appearance.getState().update({ zoom: 1 }) },
    setZoom: zoom => { appearance.getState().update({ zoom: +Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)).toFixed(2) }) },
    setWritingFont: writingFont => { appearance.getState().update({ writingFont }) },
    setUiFont: uiFont => { appearance.getState().update({ uiFont }) },
  }))
  appearance.subscribe((next, previous) => {
    if (next.phase === 'migrated' && (next.profile !== previous.profile || previous.phase !== 'migrated')) {
      store.getState().initTheme()
    }
  })
  if (appearance.getState().phase === 'migrated') store.getState().initTheme()
  return store
}

export const useThemeStore = createThemeStore()

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

function applyZoom(zoom: number) {
  if (ipc.isElectron) {
    ipc.setZoomFactor(zoom)
  } else {
    document.documentElement.style.fontSize = `${(BASE_FONT_SIZE * zoom).toFixed(2)}px`
  }
}

function applyWritingFont(font: FontId) {
  const opt = FONT_OPTIONS.find((o) => o.id === font)
  if (opt) {
    document.documentElement.style.setProperty('--font-writing', opt.family)
  }
}

function applyUiFont(font: FontId) {
  const opt = FONT_OPTIONS.find((o) => o.id === font)
  if (opt) {
    document.documentElement.style.setProperty('--font-sans', opt.family)
  }
}
