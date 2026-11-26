import { create } from 'zustand'

import type { DraftStatus } from '../shared/draft-status'
import { sameProjectPathKey } from '../shared/project-session-context'
import { countUnsavedEditorItems, countUnsavedEditorItemsForProject } from './editor-unsaved'
import { useLocaleStore } from './locale-store'
import { canonicalResourceUri } from '../shared/project-paths'
import type { GenerationRecoveryContext } from '../shared/generation-owner-contract'
import type { AllInvokeChannels } from '../shared/ipc-channels'

export interface EditorTabSaveSnapshot {
  content: string
  contentRevision: number
}

type PlanningSaveChannel = 'db:project-core-synopsis-commit' | 'db:blueprint-commit-range'

export type PlanningRecoverySaveSnapshot = EditorTabSaveSnapshot & {
  status: 'pending' | 'saved'
} & {
  [Channel in PlanningSaveChannel]: {
    channel: Channel
    request: AllInvokeChannels[Channel]['args'][0] & {
      authorRecovery: NonNullable<AllInvokeChannels[Channel]['args'][0]['authorRecovery']>
    }
  }
}[PlanningSaveChannel]

export interface KnowledgeDocumentCopy {
  available: boolean
  content?: string
  contentHash?: string
  edited?: boolean
  indexStatus: 'current' | 'stale' | 'unavailable'
}

export interface KnowledgeDraft {
  docId: string | null
  copy: KnowledgeDocumentCopy | null
  content: string
  busy?: boolean
}

export function knowledgeDraftDirty(draft: KnowledgeDraft): boolean {
  return Boolean(draft.copy?.available && draft.content !== draft.copy.content)
}

export interface EditorTab {
  id: string
  name: string
  type: 'chapter' | 'outline' | 'character' | 'config' | 'diff' | 'chapter-card' | 'world-building' | 'arch-file' | 'version-history' | 'review-report' | 'narrative-thread' | 'knowledge'
  filePath?: string
  content?: string
  savedContent?: string
  originalContent?: string
  dirty?: boolean
  pinned?: boolean
  revisionPath?: string
  reviewReport?: string
  chapterNumber?: number
  draftId?: number
  draftStatus?: DraftStatus
  contentRevision?: number
  projectKey?: string
  projectSessionLease?: string
  finalizationId?: string
  finalizationPublication?: 'pending' | 'published'
  finalizationConflict?: {
    finalizationId: string
    publicationStatus: 'pending' | 'published'
  }
  chapterDir?: string
  reportPath?: string
  reviewId?: number
  narrativeThreadView?: 'plot-tree' | 'plans'
  narrativeThreadViewRequest?: number
  chapterSelectRequest?: number
  planningRecovery?: GenerationRecoveryContext
  knowledgeDraft?: KnowledgeDraft
  planningSaveOperationId?: string
  planningSaveEnd?: string
  planningSaveSnapshot?: PlanningRecoverySaveSnapshot
}

export function openPlanningRecoveryDraft(context: GenerationRecoveryContext, projectKey: string, name: string): void {
  const draft = context.plotOutlineRecovery?.draft ?? context.blueprintRecovery?.draft
  if (draft === undefined) return
  const outline = Boolean(context.plotOutlineRecovery)
  useEditorStore.getState().openFile({
    id: `planning-recovery:${context.handle.runId}`,
    name,
    type: outline ? 'arch-file' : 'chapter-card',
    ...(outline ? { filePath: 'ai-novel://core/synopsis' } : {}),
    projectKey,
    content: draft,
    savedContent: '',
    originalContent: context.plotOutlineRecovery?.rejectedReply ?? draft,
    dirty: draft.length > 0,
    planningRecovery: context,
    planningSaveOperationId: crypto.randomUUID(),
    planningSaveEnd: String(context.plotOutlineRecovery?.completeChapters.at(-1)
      ?? context.plotOutline?.range.from ?? context.blueprintRecovery?.editRange?.from ?? ''),
  })
}

interface EditorState {
  tabs: EditorTab[]
  activeTabId: string | null
  draftLedgers: Record<string, string>

  openFile: (tab: EditorTab) => void
  setDraftLedger: (key: string, content: string) => void
  setProjectEditorDirty: (
    type: Extract<EditorTab['type'], 'character' | 'config' | 'chapter-card'>,
    projectKey: string,
    dirty: boolean,
  ) => void
  setKnowledgeDraft: (tabId: string, draft: KnowledgeDraft) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateTabContent: (tabId: string, content: string) => void
  syncTabContent: (tabId: string, content: string) => void
  markTabSaved: (tabId: string, savedContent?: string) => void
  settleTabSave: (tabId: string, snapshot: EditorTabSaveSnapshot) => void
  setPlanningSaveSnapshot: (tabId: string, snapshot: PlanningRecoverySaveSnapshot | undefined) => void
  settleMergedRevision: (
    tabId: string,
    snapshot: EditorTabSaveSnapshot,
    mergedContent: string,
  ) => void
  clearTabs: () => void
  clearProjectTabs: (projectKey: string) => void
}

const BACKGROUND_LEDGER_BY_EDITOR_TYPE: Partial<Record<EditorTab['type'], string>> = {
  character: 'character-editor-drafts',
  config: 'config',
  'chapter-card': 'chapter-card-editor',
}
const PROJECT_SCOPED_BUILTIN_TYPES = new Set<EditorTab['type']>([
  'character',
  'config',
  'chapter-card',
  'world-building',
  'chapter',
  'review-report',
  'version-history',
  'diff',
  'narrative-thread',
  'knowledge',
])

export interface EditorExitSaveHandler {
  tabId?: string
  type: EditorTab['type']
  projectKey?: string
  save: () => Promise<void>
}

const exitSaveHandlers = new Map<string, EditorExitSaveHandler>()

function exitSaveTypeKey(type: EditorTab['type'], projectKey: string): string {
  return `type:${type}:${projectKey}`
}

export function registerEditorExitSaveHandler(handler: EditorExitSaveHandler): () => void {
  const keys: string[] = []
  if (handler.tabId) keys.push(`tab:${handler.tabId}`)
  if (handler.projectKey && BACKGROUND_LEDGER_BY_EDITOR_TYPE[handler.type]) {
    keys.push(exitSaveTypeKey(handler.type, handler.projectKey))
  }
  for (const key of keys) exitSaveHandlers.set(key, handler)
  return () => {
    for (const key of keys) {
      if (exitSaveHandlers.get(key) === handler) exitSaveHandlers.delete(key)
    }
  }
}

function removeEditorExitSaveHandlers(tab: EditorTab): void {
  exitSaveHandlers.delete(`tab:${tab.id}`)
  if (tab.projectKey && !tab.planningRecovery && BACKGROUND_LEDGER_BY_EDITOR_TYPE[tab.type]) {
    exitSaveHandlers.delete(exitSaveTypeKey(tab.type, tab.projectKey))
  }
}

export function editorSaveHandler(tab: Pick<EditorTab, 'id' | 'type' | 'projectKey'>): (() => Promise<void>) | null {
  const handler = exitSaveHandlers.get(`tab:${tab.id}`)
    ?? (tab.projectKey ? exitSaveHandlers.get(exitSaveTypeKey(tab.type, tab.projectKey)) : undefined)
  return handler ? handler.save : null
}

export function createProjectScopedEditorTabId(
  baseId: string,
  type: EditorTab['type'],
  projectKey?: string,
): string {
  if (!projectKey || !PROJECT_SCOPED_BUILTIN_TYPES.has(type)) return baseId
  return `${baseId}:${encodeURIComponent(projectKey)}`
}

function hasBackgroundProjectDraft(
  draftLedgers: Record<string, string>,
  tab: EditorTab,
): boolean {
  const ledgerKey = BACKGROUND_LEDGER_BY_EDITOR_TYPE[tab.type]
  if (!ledgerKey || !tab.projectKey) return false
  const content = draftLedgers[ledgerKey]
  if (!content) return false
  try {
    const parsed = JSON.parse(content) as { projects?: Array<{ projectKey?: unknown }> }
    return Array.isArray(parsed.projects)
      && parsed.projects.some(project => project.projectKey === tab.projectKey)
  } catch {
    return false
  }
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  draftLedgers: {},

  openFile: (tab) => {
    const canonical = (value: string | undefined): string | undefined => {
      if (value === undefined) return value
      const resource = canonicalResourceUri(value)
      if (!resource && value.includes('://')) throw new Error('INVALID_RESOURCE_URI')
      return resource ?? value
    }
    const projectScopedTab = {
      ...tab,
      filePath: canonical(tab.filePath),
      revisionPath: canonical(tab.revisionPath),
      chapterDir: canonical(tab.chapterDir),
      reportPath: canonical(tab.reportPath),
      id: createProjectScopedEditorTabId(tab.id, tab.type, tab.projectKey),
    }
    const tabWithDraftState = !tab.planningRecovery && hasBackgroundProjectDraft(get().draftLedgers, projectScopedTab)
      ? { ...projectScopedTab, dirty: true }
      : projectScopedTab
    const idOnly = tab.type === 'diff' || Boolean(tab.planningRecovery)
    const existing = get().tabs.find((t) =>
      t.id === tabWithDraftState.id ||
      (!idOnly
        && tabWithDraftState.filePath !== undefined
        && canonical(t.filePath) === tabWithDraftState.filePath
        && t.type === tabWithDraftState.type && !t.planningRecovery
        && t.projectKey === tabWithDraftState.projectKey)
    )
    if (existing) {
      if (existing.dirty && existing.filePath !== canonical(existing.filePath)) {
        set(s => ({ tabs: s.tabs.map(t => t.id === existing.id ? {
          ...t, filePath: canonical(t.filePath), revisionPath: canonical(t.revisionPath),
          chapterDir: canonical(t.chapterDir), reportPath: canonical(t.reportPath),
        } : t), activeTabId: existing.id }))
        return
      }
      if (tabWithDraftState.type === 'diff' || tabWithDraftState.type === 'review-report') {
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === existing.id ? { ...t, ...tabWithDraftState, id: tabWithDraftState.id } : t),
          activeTabId: tabWithDraftState.id,
        }))
      } else {
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === existing.id
            ? {
                ...t,
                filePath: canonical(t.filePath),
                revisionPath: canonical(t.revisionPath),
                chapterDir: canonical(t.chapterDir),
                reportPath: canonical(t.reportPath),
                name: tabWithDraftState.name,
                ...(tabWithDraftState.draftId === undefined
                  ? {}
                  : { draftId: tabWithDraftState.draftId }),
                ...(tabWithDraftState.chapterNumber === undefined
                  ? {}
                  : { chapterNumber: tabWithDraftState.chapterNumber }),
                ...(tabWithDraftState.type === 'chapter-card' && tabWithDraftState.chapterNumber !== undefined
                  ? { chapterSelectRequest: (t.chapterSelectRequest ?? 0) + 1 }
                  : {}),
                ...(tabWithDraftState.draftStatus === undefined
                  ? {}
                  : { draftStatus: tabWithDraftState.draftStatus }),
                ...(tabWithDraftState.narrativeThreadView === undefined
                  ? {}
                  : {
                      narrativeThreadView: tabWithDraftState.narrativeThreadView,
                      narrativeThreadViewRequest: (t.narrativeThreadViewRequest ?? 0) + 1,
                    }),
              }
            : t),
          activeTabId: existing.id,
        }))
      }
    } else {
      set((s) => ({
        tabs: [
          ...s.tabs,
          tabWithDraftState.type === 'narrative-thread'
            && tabWithDraftState.narrativeThreadView !== undefined
            ? { ...tabWithDraftState, narrativeThreadViewRequest: 1 }
            : tabWithDraftState.type === 'chapter-card' && tabWithDraftState.chapterNumber !== undefined
              ? { ...tabWithDraftState, chapterSelectRequest: 1 }
              : tabWithDraftState,
        ],
        activeTabId: tabWithDraftState.id,
      }))
    }
  },

  setDraftLedger: (key, content) => {
    set((state) => ({
      draftLedgers: {
        ...state.draftLedgers,
        [key]: content,
      },
    }))
  },

  setProjectEditorDirty: (type, projectKey, dirty) => {
    set((state) => ({
      tabs: state.tabs.map(tab => (
        tab.type === type && tab.projectKey === projectKey && !tab.planningRecovery
          ? { ...tab, dirty }
          : tab
      )),
    }))
  },

  setKnowledgeDraft: (tabId, draft) => {
    set(state => ({
      tabs: state.tabs.map(tab => tab.id === tabId ? { ...tab, knowledgeDraft: draft, dirty: knowledgeDraftDirty(draft) } : tab),
    }))
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get()
    const target = tabs.find((t) => t.id === tabId)
    if (target?.pinned) return
    if (target) removeEditorExitSaveHandlers(target)
    const newTabs = tabs.filter((t) => t.id !== tabId)
    set({
      tabs: newTabs,
      activeTabId: activeTabId === tabId
        ? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
        : activeTabId,
    })
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId })
  },

  updateTabContent: (tabId, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId
        ? {
            ...t,
            content,
            contentRevision: (t.contentRevision ?? 0) + 1,
            dirty: true,
          }
        : t),
    }))
  },

  syncTabContent: (tabId, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId
        ? {
            ...t,
            content,
            contentRevision: content === t.content
              ? (t.contentRevision ?? 0)
              : (t.contentRevision ?? 0) + 1,
          }
        : t),
    }))
  },

  markTabSaved: (tabId, savedContent) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId
        ? {
            ...t,
            dirty: false,
            ...(savedContent === undefined ? {} : { savedContent }),
          }
        : t),
    }))
  },

  settleTabSave: (tabId, snapshot) => {
    set((state) => ({
      tabs: state.tabs.map(tab => {
        if (tab.id !== tabId) return tab
        const snapshotStillCurrent = (
          (tab.contentRevision ?? 0) === snapshot.contentRevision
          && tab.content === snapshot.content
        )
        return {
          ...tab,
          savedContent: snapshot.content,
          dirty: !snapshotStillCurrent,
        }
      }),
    }))
  },

  setPlanningSaveSnapshot: (tabId, snapshot) => {
    set(state => ({ tabs: state.tabs.map(tab => tab.id === tabId ? { ...tab, planningSaveSnapshot: snapshot } : tab) }))
  },

  settleMergedRevision: (tabId, snapshot, mergedContent) => {
    set((state) => ({
      tabs: state.tabs.map(tab => {
        if (tab.id !== tabId) return tab
        const snapshotStillCurrent = (
          (tab.contentRevision ?? 0) === snapshot.contentRevision
          && tab.content === snapshot.content
        )
        if (!snapshotStillCurrent) {
          return {
            ...tab,
            savedContent: mergedContent,
            dirty: true,
          }
        }
        return {
          ...tab,
          content: mergedContent,
          savedContent: mergedContent,
          contentRevision: (tab.contentRevision ?? 0) + (tab.content === mergedContent ? 0 : 1),
          dirty: false,
        }
      }),
    }))
  },

  clearTabs: () => {
    exitSaveHandlers.clear()
    set({ tabs: [], activeTabId: null })
  },

  clearProjectTabs: (projectKey) => {
    for (const tab of get().tabs) {
      if (tab.projectKey === projectKey) removeEditorExitSaveHandlers(tab)
    }
    set((state) => {
      const tabs = state.tabs.filter(tab => tab.projectKey !== projectKey)
      const draftLedgers = Object.fromEntries(
        Object.entries(state.draftLedgers).map(([key, content]) => {
          try {
            const parsed = JSON.parse(content) as {
              version?: unknown
              projects?: Array<{ projectKey?: unknown }>
            }
            if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return [key, content]
            return [key, JSON.stringify({
              ...parsed,
              projects: parsed.projects.filter(project => project.projectKey !== projectKey),
            })]
          } catch {
            return [key, content]
          }
        }),
      )
      const activeTabId = state.activeTabId && tabs.some(tab => tab.id === state.activeTabId)
        ? state.activeTabId
        : (tabs.at(-1)?.id ?? null)
      return { tabs, activeTabId, draftLedgers }
    })
  },
}))

export async function saveDirtyEditorChangesForExit(
  currentProjectKey: string | undefined, scope: 'all' | 'project' = 'all',
): Promise<void> {
  const countUnsaved = (state: Pick<EditorState, 'tabs' | 'draftLedgers'>) => scope === 'project' && currentProjectKey
    ? countUnsavedEditorItemsForProject(state.tabs, state.draftLedgers, currentProjectKey)
    : countUnsavedEditorItems(state.tabs, state.draftLedgers)
  const initial = useEditorStore.getState()
  if (countUnsaved(initial) === 0) return
  const text = useLocaleStore.getState().text

  const handlers = new Set<EditorExitSaveHandler>()
  for (const tab of initial.tabs) {
    if (!tab.dirty) continue
    if (scope === 'project' && tab.projectKey !== currentProjectKey) continue
    if (!tab.projectKey || !currentProjectKey || !sameProjectPathKey(tab.projectKey, currentProjectKey)) {
      throw new Error(text('另一个项目仍有未保存内容，请切回该项目后再保存或取消退出', 'Another book has unsaved changes. Switch back to it to save them, or cancel exiting.'))
    }
    const handler = exitSaveHandlers.get(`tab:${tab.id}`)
      ?? exitSaveHandlers.get(exitSaveTypeKey(tab.type, tab.projectKey))
    if (!handler) throw new Error(text(`“${tab.name}”当前无法安全保存，请取消退出并在编辑器中保存`, `“${tab.name}” cannot be saved safely right now. Cancel exiting and save it in its editor.`))
    handlers.add(handler)
  }

  for (const [ledgerKey, content] of Object.entries(initial.draftLedgers)) {
    const type = Object.entries(BACKGROUND_LEDGER_BY_EDITOR_TYPE)
      .find(([, key]) => key === ledgerKey)?.[0] as EditorTab['type'] | undefined
    if (!type || !content) continue
    let projects: Array<{ projectKey?: unknown }>
    try {
      const parsed = JSON.parse(content) as { projects?: unknown }
      if (!Array.isArray(parsed.projects)) throw new Error('invalid ledger')
      projects = parsed.projects
    } catch {
      throw new Error(text('存在无法识别的未保存编辑内容，请取消退出并恢复该编辑器', 'Some unsaved edits could not be recognized. Cancel exiting and restore that editor.'))
    }
    for (const project of projects) {
      if (typeof project.projectKey !== 'string') continue
      if (scope === 'project' && project.projectKey !== currentProjectKey) continue
      if (!currentProjectKey || !sameProjectPathKey(project.projectKey, currentProjectKey)) {
        throw new Error(text('另一个项目仍有未保存内容，请切回该项目后再保存或取消退出', 'Another book has unsaved changes. Switch back to it to save them, or cancel exiting.'))
      }
      const handler = exitSaveHandlers.get(exitSaveTypeKey(type, project.projectKey))
      if (!handler) throw new Error(text('当前编辑内容无法安全保存，请取消退出并在对应编辑器中保存', 'These edits cannot be saved safely right now. Cancel exiting and save them in their editor.'))
      handlers.add(handler)
    }
  }

  for (const handler of handlers) await handler.save()

  const settled = useEditorStore.getState()
  if (countUnsaved(settled) !== 0) {
    throw new Error(text('保存期间仍有未保存修改，已取消退出', 'New edits were made while saving, so exiting was cancelled.'))
  }
}
