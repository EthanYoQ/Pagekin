import { leaveSettings, leaveSettingsThen } from '../../components/settings/unsaved-settings'
import { toast } from '../../components/ui/Toast'
import type { DraftMeta } from '../../services/draft-index'
import { chapterTabName } from '../../shared/chapter-label'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { fetchChapterDrafts, useDraftStore } from '../draft-store'
import { createProjectScopedEditorTabId, useEditorStore } from '../editor-store'
import { useLayoutStore } from '../layout-store'
import { currentInterfaceLocale, useLocaleStore } from '../locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { openDraftTab } from '../open-draft-tab'
import { useProjectStore } from '../project-store'
import type { NavigationIntent } from './navigation-intents'
import { openPageTab } from './page-tabs'
import { deriveChapters, focusChapter } from './stage-progress'
import { useStageStore } from './stage-store'

function enterWork(): void {
  useStageStore.setState({ focus: false })
  if (useLayoutStore.getState().sidebarView === 'home') useLayoutStore.setState({ sidebarView: 'project' })
}

function currentSession(): ProjectSessionContext | null {
  return projectSessionContextFromProject(useProjectStore.getState().currentProject)
}

async function chapterDrafts(chapterNumber: number, session: ProjectSessionContext): Promise<readonly DraftMeta[]> {
  const loaded = useDraftStore.getState()
  if (sameProjectSessionContext(loaded.dataProjectSession, session) && !loaded.loading) return loaded.draftsByChapter[chapterNumber] ?? []
  return fetchChapterDrafts(chapterNumber, session)
}

let openChapterRequest = 0

export function chapterNavigationEpoch(): number {
  return openChapterRequest
}

export function chapterPlanTabId(chapterNumber: number, projectPath: string): string {
  return createProjectScopedEditorTabId(`chapter-plan:${chapterNumber}`, 'chapter', projectPath)
}

export function openChapterPlan(chapterNumber: number, title: string, session: ProjectSessionContext): void {
  const text = useLocaleStore.getState().text
  useEditorStore.getState().openFile({
    id: `chapter-plan:${chapterNumber}`,
    name: chapterTabName(chapterNumber, title, text),
    type: 'chapter',
    chapterNumber,
    projectKey: session.projectPath,
    projectSessionLease: session.leaseId,
  })
}

export async function openChapter(chapterNumber: number, stillIntended: () => boolean = () => true): Promise<boolean> {
  const request = ++openChapterRequest
  const session = currentSession()
  if (!session) return false
  const text = useLocaleStore.getState().text
  const stillWanted = () => request === openChapterRequest && sameProjectSessionContext(session, currentSession()) && stillIntended()
  try {
    const drafts = await chapterDrafts(chapterNumber, session)
    if (!stillWanted()) return false
    const work = useStageStore.getState().work
    const [row] = deriveChapters({
      blueprints: (work && sameProjectSessionContext(work.session, session) ? work.blueprints : [])
        .filter(blueprint => blueprint.chapterNumber === chapterNumber),
      drafts: { [chapterNumber]: drafts },
      runningChapters: new Set(),
    })
    const draft = row?.draft
    if (!draft) {
      openChapterPlan(chapterNumber, row?.title ?? '', session)
      return true
    }
    if (useStageStore.getState().writeRequest?.chapterNumber === chapterNumber) useStageStore.setState({ writeRequest: null })
    const editor = useEditorStore.getState()
    const open = editor.tabs.find(tab => tab.type === 'chapter' && tab.projectKey === session.projectPath && tab.filePath === draft.filePath)
    if (open) {
      editor.setActiveTab(open.id)
      return true
    }
    return await openDraftTab(draft, chapterTabName(chapterNumber, row.title, text), session, stillWanted)
  } catch (error) {
    if (!stillWanted()) return false
    const reason = displayedErrorMessage(currentInterfaceLocale(), error)
    toast.error(text(`打开第 ${chapterNumber} 章失败：${reason}`, `Could not open chapter ${chapterNumber}: ${reason}`))
    return false
  }
}

useProjectStore.subscribe(({ currentProject }, previous) => {
  const session = projectSessionContextFromProject(currentProject)
  const { writeRequest, chapterRequest, selectionRequest, sheet } = useStageStore.getState()
  if (writeRequest && !sameProjectSessionContext(writeRequest.session, session)) useStageStore.setState({ writeRequest: null })
  if (chapterRequest && !sameProjectSessionContext(chapterRequest.session, session)) useStageStore.setState({ chapterRequest: null })
  if (selectionRequest && !sameProjectSessionContext(selectionRequest.session, session)) useStageStore.setState({ selectionRequest: null })
  if (sheet?.kind === 'review' && !sameProjectSessionContext(projectSessionContextFromProject(previous.currentProject), session)) useStageStore.setState({ sheet: null })
})

function openKnowledge(): void {
  const projectKey = useProjectStore.getState().currentProject?.path
  if (!projectKey) return
  const text = useLocaleStore.getState().text
  useEditorStore.getState().openFile({ id: 'knowledge-base', name: text('知识库', 'Knowledge base'), type: 'knowledge', projectKey })
}

async function openManuscript(): Promise<void> {
  const session = currentSession()
  const work = useStageStore.getState().work
  if (!session || !work || !sameProjectSessionContext(work.session, session)) {
    openPageTab('blueprint')
    return
  }
  const drafts = useDraftStore.getState()
  const target = focusChapter(deriveChapters({
    blueprints: work.blueprints,
    drafts: sameProjectSessionContext(drafts.dataProjectSession, session) ? drafts.draftsByChapter : {},
    runningChapters: new Set(),
  }))
  if (target) await openChapter(target.number)
  else openPageTab('blueprint')
}

export function stageNavigate(intent: NavigationIntent): void {
  if (intent.kind === 'settings') {
    const open = () => useLayoutStore.setState({ settingsOpen: true, settingsSection: intent.section })
    const { settingsOpen, settingsSection } = useLayoutStore.getState()
    if (settingsOpen && settingsSection !== intent.section) leaveSettings(open)
    else open()
    return
  }
  if (intent.kind === 'chapter' && intent.write) {
    const { chapterNumber } = intent
    leaveSettingsThen(() => {
      const session = currentSession()
      if (session) useStageStore.setState({ writeRequest: { session, chapterNumber } })
      arrive(intent)
    })
    return
  }
  const staysInSettings = (intent.kind === 'run' || (intent.kind === 'stage' && !intent.stage))
    && useLayoutStore.getState().sidebarView !== 'home'
  if (staysInSettings) arrive(intent)
  else leaveSettingsThen(() => arrive(intent))
}

function arrive(intent: Exclude<NavigationIntent, { kind: 'settings' }>): void {
  enterWork()
  if ((intent.kind === 'stage' && intent.stage) || intent.kind === 'resource') openChapterRequest++
  switch (intent.kind) {
    case 'stage':
      if (!intent.stage) {
        if (useStageStore.getState().sheet?.kind === 'run') useStageStore.setState({ sheet: null })
      } else if (intent.stage === 'manuscript') void openManuscript()
      else openPageTab(intent.stage)
      return
    case 'resource':
      if (intent.page === 'knowledge') openKnowledge()
      else openPageTab(intent.page)
      return
    case 'run':
      useStageStore.setState({ sheet: { kind: 'run', tab: intent.facet === 'log' || intent.facet === 'models' ? 'diagnostics' : 'active', runId: intent.runId } })
      return
    case 'chapter':
      void openChapter(intent.chapterNumber)
  }
}
