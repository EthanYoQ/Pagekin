import { formatResourceUri } from '../shared/project-paths'
import { parseResourceUri, resourceWriteAllowed } from '../shared/project-paths'
import { readResourceContent } from '../services/resource-protocol'
import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { ignoreFailure } from '../shared/ignore-failure'
import {
  type DraftMeta,
} from '../services/draft-index'
import type { DraftStatus } from '../shared/draft-status'
import type { AllInvokeChannels, ProjectSessionContext } from '../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { useProjectStore } from './project-store'
import { requireIpcSuccess } from '../services/ipc-result'
import { countDraftUnits } from '../shared/draft-units'
import { useEditorStore } from './editor-store'
import { currentInterfaceLocale } from './locale-store'
import { authorError, catalogNote, caughtFailure } from '../i18n/app-errors'
import { note, type Failure } from '../shared/failure'

let loadAllDraftsRequestSequence = 0

function currentDraftProjectSession(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): ProjectSessionContext | null {
  const project = useProjectStore.getState().currentProject
  const projectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !projectSession
    || (expectedProjectPath && !sameProjectPathKey(project.path, expectedProjectPath))
    || (expectedProjectSession && !sameProjectSessionContext(expectedProjectSession, projectSession))
  ) return null
  return projectSession
}

function isDraftProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

function toDraftMetas(list: AllInvokeChannels['db:draft-list']['return']): DraftMeta[] {
  return list.map((m) => ({
    ...m,
    status: m.status as DraftStatus,
    source: m.source as DraftMeta['source'],
    fileName: `draft_v${m.version}.md`,
    filePath: formatResourceUri({ kind: 'draft', id: m.id })
  })).sort((a, b) => b.version - a.version)
}

export async function fetchChapterDrafts(chapterNumber: number, projectSession: ProjectSessionContext): Promise<DraftMeta[]> {
  return toDraftMetas(await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chapterNumber, projectSession.projectPath))
}

function staleProjectError(): { success: false; error: string } {
  return { success: false, error: '项目会话已变化，已拒绝继续操作' }
}

export type DraftsByChapter = Record<number, DraftMeta[]>

interface DraftState {
  draftsByChapter: DraftsByChapter
  loading: boolean
  dataProjectKey: string | null
  dataProjectSession: ProjectSessionContext | null
  loadingProjectKey: string | null
  loadingProjectSession: ProjectSessionContext | null

  beginProjectLoad: (projectPath: string) => void
  reset: () => void
  loadChapterDrafts: (
    chapterNumber: number,
    expectedProjectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<void>
  loadAllDrafts: (
    expectedProjectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<void>

  markDraftStatus: (
    draftPath: string,
    chapterNumber: number,
    status: DraftStatus,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<void>
  invalidateChapter: (chapterNumber: number) => void
  applyMergedRevision: (
    chapterDir: string,
    chapterNumber: number | undefined,
    filePath: string,
    revPath: string,
    mergedText: string,
    expectedDraftContent: string,
    expectedProjectPath: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<{ success: boolean; receipt?: Awaited<ReturnType<typeof ipc.invoke<'db:revision-merge'>>>['receipt'];
    failure?: Failure; postCommitError?: string }>
}

export const useDraftStore = create<DraftState>()((set, get) => ({
  draftsByChapter: {},
  loading: false,
  dataProjectKey: null,
  dataProjectSession: null,
  loadingProjectKey: null,
  loadingProjectSession: null,

  beginProjectLoad: (projectPath) => {
    loadAllDraftsRequestSequence++
    set({
      draftsByChapter: {},
      loading: true,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: projectPath,
      loadingProjectSession: null,
    })
  },

  reset: () => {
    loadAllDraftsRequestSequence++
    set({
      draftsByChapter: {},
      loading: false,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: null,
      loadingProjectSession: null,
    })
  },

  loadChapterDrafts: async (chapterNumber, expectedProjectPath, expectedProjectSession) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = currentDraftProjectSession(expectedProjectPath, expectedProjectSession)
    if (!project || !projectSession) return
    const projectPath = expectedProjectPath ?? project.path
    const requestId = loadAllDraftsRequestSequence

    await ignoreFailure(`chapter draft list unavailable: ${chapterNumber}`, async () => {
      const list = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chapterNumber, projectPath)
      if (
        requestId !== loadAllDraftsRequestSequence
        || !sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )
      ) return
      const metas = toDraftMetas(list)

      set(s => ({
        draftsByChapter: {
          ...(sameProjectSessionContext(s.dataProjectSession, projectSession) ? s.draftsByChapter : {}),
          [chapterNumber]: metas,
        },
        dataProjectKey: projectPath,
        dataProjectSession: projectSession,
      }))
    })
  },

  loadAllDrafts: async (expectedProjectPath, expectedProjectSession) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = currentDraftProjectSession(expectedProjectPath, expectedProjectSession)
    if (!project || !projectSession) return
    const projectPath = expectedProjectPath ?? project.path
    const requestId = ++loadAllDraftsRequestSequence

    set(s => ({
      draftsByChapter: sameProjectSessionContext(s.dataProjectSession, projectSession)
        ? s.draftsByChapter
        : {},
      loading: true,
      dataProjectKey: sameProjectSessionContext(s.dataProjectSession, projectSession)
        ? projectPath
        : null,
      dataProjectSession: sameProjectSessionContext(s.dataProjectSession, projectSession)
        ? projectSession
        : null,
      loadingProjectKey: projectPath,
      loadingProjectSession: projectSession,
    }))
    try {
      const drafts = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list-all', projectPath)
      const newDraftsByChapter: DraftsByChapter = {}

      for (const draft of drafts) {
        const chapterDrafts = newDraftsByChapter[draft.chapterNumber] ?? []
        chapterDrafts.push({
          ...draft,
          status: draft.status as DraftStatus,
          source: draft.source as DraftMeta['source'],
          fileName: `draft_v${draft.version}.md`,
          filePath: formatResourceUri({ kind: 'draft', id: draft.id })
        })
        newDraftsByChapter[draft.chapterNumber] = chapterDrafts
      }

      for (const chapterDrafts of Object.values(newDraftsByChapter)) {
        chapterDrafts.sort((a, b) => b.version - a.version)
      }

      if (
        requestId === loadAllDraftsRequestSequence
        && sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )
      ) {
        set({
          draftsByChapter: newDraftsByChapter,
          dataProjectKey: projectPath,
          dataProjectSession: projectSession,
        })
      }
    } finally {
      if (
        requestId === loadAllDraftsRequestSequence
        && sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )
      ) {
        set({ loading: false, loadingProjectKey: null, loadingProjectSession: null })
      }
    }
  },


  markDraftStatus: async (draftPath, chapterNumber, status, expectedProjectSession) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = currentDraftProjectSession(project?.path, expectedProjectSession)
    if (!project || !projectSession || !resourceWriteAllowed(draftPath)) return
    const resource = parseResourceUri(draftPath)
    if (resource?.kind !== 'draft') return
    const draftId = resource.id
    requireIpcSuccess(
      await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-update-status',
        draftId,
        status,
        undefined,
        project.path,
      ),
      ['更新草稿状态', 'update the draft status', '草稿の状態の更新'],
    )
    if (!isDraftProjectSessionCurrent(projectSession)) return
    await get().loadChapterDrafts(chapterNumber, project.path, projectSession)
  },

  invalidateChapter: (chapterNumber) => {
    set(s => {
      const next = { ...s.draftsByChapter }
      delete next[chapterNumber]
      return { draftsByChapter: next }
    })
  },

  applyMergedRevision: async (
    chapterDir,
    chapterNumber,
    filePath,
    revPath,
    mergedText,
    expectedDraftContent,
    expectedProjectPath,
    expectedProjectSession,
  ) => {
    void chapterDir
    let committedReceipt: Awaited<ReturnType<typeof ipc.invoke<'db:revision-merge'>>>['receipt'] | undefined
    try {
      const projectSession = currentDraftProjectSession(expectedProjectPath, expectedProjectSession)
      if (!projectSession) {
        return { success: false, failure: { note: catalogNote('error.mergeProjectSwitched') } }
      }
      const editorState = useEditorStore.getState()
      const targetTab = editorState.tabs.find(t =>
        t.projectKey === expectedProjectPath && t.filePath === filePath
      )
      const editorSnapshot = targetTab
        ? {
            content: targetTab.content ?? expectedDraftContent,
            contentRevision: targetTab.contentRevision ?? 0,
          }
        : undefined

      const draftResource = parseResourceUri(filePath)
      const revisionResource = parseResourceUri(revPath)
      if (!resourceWriteAllowed(filePath) || draftResource?.kind !== 'draft'
        || revisionResource?.kind !== 'revision' || revisionResource.legacy) {
        return { success: false, failure: { note: catalogNote('error.mergeTargetUnresolved') } }
      }
      const targetDraftId = draftResource.id
      const revisionId = revisionResource.id

      const merged = requireIpcSuccess(
        await ipc.invokeWithProjectSession(
          projectSession,
          'db:revision-merge',
          {
            revisionId,
            targetDraftId,
            expectedDraftContent,
            mergedContent: mergedText,
            wordCount: countDraftUnits(mergedText),
          },
          expectedProjectPath,
        ),
        ['提交合并后的修订稿', 'submit the merged revision', '統合した改稿の確定'],
      )
      committedReceipt = merged.receipt
      if (!isDraftProjectSessionCurrent(projectSession)) {
        return { success: true, receipt: committedReceipt, postCommitError: staleProjectError().error }
      }

      if (targetTab && editorSnapshot) {
        editorState.settleMergedRevision(targetTab.id, editorSnapshot, mergedText)
      }

      if (chapterNumber !== undefined) {
        await get().loadChapterDrafts(chapterNumber, expectedProjectPath, projectSession)
      }
      if (!isDraftProjectSessionCurrent(projectSession)) {
        return { success: true, receipt: committedReceipt, postCommitError: staleProjectError().error }
      }

      if (merged.receipt?.reviewCycle?.disposition === 'required') {
        const { createReviewOnlyWorkflow } = await import('../services/workflows/chapter-workflow')
        const { useWorkflowStore } = await import('./workflow-store')
        if (!isDraftProjectSessionCurrent(projectSession)) {
          return { success: true, receipt: committedReceipt, postCommitError: staleProjectError().error }
        }
        const mergedTab = useEditorStore.getState().tabs.find(tab => tab.projectKey === expectedProjectPath && tab.filePath === filePath)
        let started: (() => void) | undefined
        const admission = new Promise<void>(resolve => { started = resolve })
        const definition = createReviewOnlyWorkflow({
          projectPath: expectedProjectPath,
          chapterNumber: merged.receipt.chapterNumber,
          chapterTitle: `第${merged.receipt.chapterNumber}章`,
          draftPath: filePath,
          draftContent: mergedText,
          sourceDraft: { id: merged.receipt.targetDraftId, chapterNumber: merged.receipt.chapterNumber,
            version: merged.receipt.version, status: 'revised', contentRevision: mergedTab?.contentRevision ?? 0 },
          reviewCycleId: merged.receipt.reviewCycle.cycleId,
          expectedMergedHash: merged.receipt.reviewCycle.mergedHash,
        }, projectSession)
        definition.onStarted = started
        await Promise.race([admission, useWorkflowStore.getState().startWorkflow(definition, false).then(runId => {
          const run = useWorkflowStore.getState().history.find(item => item.id === runId)
          if (run?.status === 'failed') throw authorError(currentInterfaceLocale(), run.failure ?? { note: note('合并后复验没有启动。', 'The post-merge recheck did not start.') })
        })])
      }

      return { success: true, receipt: committedReceipt }
    } catch (e) {
      if (committedReceipt) return { success: true, receipt: committedReceipt, postCommitError: String(e) }
      return { success: false, failure: caughtFailure(e) }
    }
  },
}))

export async function readDraftBody(
  filePath: string,
  expectedProjectPath: string,
  expectedProjectSession?: ProjectSessionContext,
): Promise<string> {
  const projectSession = currentDraftProjectSession(expectedProjectPath, expectedProjectSession)
  if (!projectSession) throw authorError(currentInterfaceLocale(), { note: note('读取草稿时缺少匹配的冻结项目会话', 'The draft was not read because the book session changed.') })

  const content = await readResourceContent(filePath, projectSession)
  return isDraftProjectSessionCurrent(projectSession) ? content : ''
}

export type { DraftMeta, DraftStatus }
