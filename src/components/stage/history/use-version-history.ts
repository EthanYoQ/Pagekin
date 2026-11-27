import { useCallback, useEffect, useRef, useState } from 'react'
import { reopenFinalizedChapter } from '../../../services/chapter-reopen'
import { ipc } from '../../../services/ipc-client'
import { countDraftUnits } from '../../../shared/draft-units'
import type { DraftStatus } from '../../../shared/draft-status'
import { LatestRequestGate } from '../../../shared/latest-request-gate'
import { currentInterfaceLocale, useLocaleStore } from '../../../stores/locale-store'
import { failureText, resultFailure } from '../../../i18n/app-errors'
import { useProjectStore } from '../../../stores/project-store'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

export type VersionKind = 'draft' | 'refined' | 'final' | 'superseded'

const VERSION_KIND: Record<DraftStatus, VersionKind> = {
  draft: 'draft',
  reviewed: 'draft',
  archived: 'draft',
  revised: 'refined',
  finalized: 'final',
  superseded: 'superseded',
}

export interface VersionRecord {
  id: number
  version: number
  type: VersionKind
  word_count: number
  created_at: string
  dependencies_stale: boolean
}

export interface VersionChapter {
  number: number
  title: string
}

export interface VersionComparison {
  older: string
  current: string | null
}

const NO_VERSIONS: VersionRecord[] = []

type LoadedVersions = { chapter: number; session: ProjectSessionContext | null } & ({ ok: true; versions: VersionRecord[] } | { ok: false })

export function useVersionHistory(projectKey: string) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const [chapters, setChapters] = useState<VersionChapter[]>([])
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null)
  const [loaded, setLoaded] = useState<LoadedVersions | null>(null)
  const versionReads = useRef(new LatestRequestGate())
  const [loading, setLoading] = useState(true)

  const loadChapters = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setLoading(true)
    try {
      const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', projectSession.projectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      setChapters(blueprints.map(blueprint => ({
        number: blueprint.chapterNumber,
        title: blueprint.title || text(`第 ${blueprint.chapterNumber} 章`, `Chapter ${blueprint.chapterNumber}`),
      })))
    } catch {
      if (isProjectSessionCurrent(projectSession)) setChapters([])
    } finally {
      if (isProjectSessionCurrent(projectSession)) setLoading(false)
    }
  }, [currentProject, projectKey, text])

  useEffect(() => {
    let mounted = true
    Promise.resolve().then(() => { if (mounted) void loadChapters() })
    return () => { mounted = false }
  }, [loadChapters])

  const loadVersions = useCallback(async (chapterNumber: number): Promise<VersionRecord[]> => {
    const project = useProjectStore.getState().currentProject
    const projectSession = captureProjectSession(project)
    const request = versionReads.current.begin()
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      setLoaded({ chapter: chapterNumber, session: projectSessionContextFromProject(project), ok: true, versions: [] })
      return []
    }
    const latest = () => versionReads.current.isLatest(request) && isProjectSessionCurrent(projectSession)
    try {
      const drafts = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chapterNumber, projectSession.projectPath)
      if (!isProjectSessionCurrent(projectSession)) return []
      const loaded: VersionRecord[] = drafts.map(draft => ({
        id: draft.id,
        version: draft.version,
        type: VERSION_KIND[draft.status],
        word_count: draft.wordCount || 0,
        created_at: draft.createdAt,
        dependencies_stale: draft.dependenciesStale,
      }))
      if (latest()) setLoaded({ chapter: chapterNumber, session: projectSession, ok: true, versions: loaded })
      return loaded
    } catch {
      if (latest()) setLoaded({ chapter: chapterNumber, session: projectSession, ok: false })
      return []
    }
  }, [projectKey])

  const sessionLease = currentProject?.sessionLease
  useEffect(() => {
    if (selectedChapter === null) return
    let mounted = true
    Promise.resolve().then(() => { if (mounted) void loadVersions(selectedChapter) })
    return () => { mounted = false }
  }, [loadVersions, selectedChapter, sessionLease])

  const reloadVersions = useCallback(() => {
    if (selectedChapter === null) return
    setLoaded(null)
    void loadVersions(selectedChapter)
  }, [loadVersions, selectedChapter])


  const readComparison = useCallback(async (versionId: number): Promise<VersionComparison | 'missing' | null> => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || selectedChapter === null) return null
    const older = (await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', versionId, projectSession.projectPath))?.content
    if (!isProjectSessionCurrent(projectSession)) return null
    if (older === undefined) return 'missing'
    const latest = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-latest', selectedChapter, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    if (latest?.id === undefined) return { older, current: null }
    if (latest.id === versionId) return { older, current: older }
    const current = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', latest.id, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    return { older, current: current ? current.content : null }
  }, [projectKey, selectedChapter])

  const createRollbackDraft = useCallback(async (versionId: number, finalized: boolean): Promise<{ version: number | null; created: boolean } | null> => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || selectedChapter === null) return null
    if (finalized) {
      const reopened = await reopenFinalizedChapter(projectSession, { chapterNumber: selectedChapter, initialDraftId: versionId })
      if (!reopened.success) throw new Error(failureText(currentInterfaceLocale(), resultFailure(reopened)))
      if (!isProjectSessionCurrent(projectSession)) return null
      await loadVersions(selectedChapter)
      return { version: reopened.version, created: reopened.created }
    }
    const content = (await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', versionId, projectSession.projectPath))?.content
    if (!isProjectSessionCurrent(projectSession) || content === undefined) return null
    const nextVersion = await ipc.invokeWithProjectSession(projectSession, 'db:draft-next-version', selectedChapter, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    const created = await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
      chapterNumber: selectedChapter,
      version: nextVersion,
      source: 'rewrite',
      content,
      wordCount: countDraftUnits(content),
    }, projectSession.projectPath)
    if (!created.success) throw new Error(created.error || text('没有新建回滚草稿', 'the rollback draft was not created'))
    if (!isProjectSessionCurrent(projectSession)) return null
    const refreshed = await loadVersions(selectedChapter)
    return { version: refreshed.find(version => version.id === created.id)?.version ?? null, created: true }
  }, [loadVersions, projectKey, selectedChapter, text])

  const currentSession = projectSessionContextFromProject(currentProject)
  const loadedThisSession = loaded !== null && (loaded.session === null
    ? currentSession === null
    : sameProjectSessionContext(loaded.session, currentSession))
  const versionsLoading = selectedChapter !== null && (loaded?.chapter !== selectedChapter || !loadedThisSession)
  const versionsFailed = !versionsLoading && loaded?.ok === false
  const versions = !versionsLoading && loaded?.ok ? loaded.versions : NO_VERSIONS
  return {
    chapters, loading, selectedChapter, selectChapter: setSelectedChapter, versions, versionsLoading, versionsFailed, reloadVersions,
    readComparison, createRollbackDraft,
  }
}
