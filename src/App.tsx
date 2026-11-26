import { useEffect } from 'react'
import { useThemeStore } from './stores/theme-store'
import { useLayoutStore } from './stores/layout-store'
import { navigate } from './stores/navigation/navigation-intents'
import { useLLMStore } from './stores/llm-store'
import { useProjectStore } from './stores/project-store'
import { useWorkflowStore } from './stores/workflow-store'
import { useLocaleStore } from './stores/locale-store'
import { ipc } from './services/ipc-client'
import { useWindowCloseGuard } from './components/layout/use-window-close-guard'
import ImportNovelDialog from './components/dialogs/ImportNovelDialog'
import ExportDialog from './components/dialogs/ExportDialog'
import { leaveSettingsThen, openProjectFolder } from './components/settings/unsaved-settings'
import StageRoot from './components/stage/StageRoot'
import StageShell from './components/stage/StageShell'
import { actionToast } from './components/ui/ActionToast'
import { UpdateNotifier } from './components/updates/UpdateNotifier'
import { globalEventBus } from './shared/event-bus'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from './shared/project-session-context'
import { getAutoNextChapterPrefill, type NextChapterBlueprint } from './services/auto-next-chapter'

export default function App() {
  const initTheme = useThemeStore((s) => s.initTheme)
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme)
  const initLocale = useLocaleStore((s) => s.init)
  const exportOpen = useLayoutStore(s => s.exportOpen)
  const closeExport = useLayoutStore(s => s.closeExport)
  const importNovelOpen = useLayoutStore(s => s.importNovelOpen)
  const closeImportNovel = useLayoutStore(s => s.closeImportNovel)
  const initLLM = useLLMStore((s) => s.init)
  const loadRecentProjects = useProjectStore((s) => s.loadRecentProjects)
  const exitGuard = useWindowCloseGuard()

  useEffect(() => {
    initLocale()
    initTheme()
    initLLM()
    loadRecentProjects()
    import('./services/project-service').then(({ initProjectService }) => {
      initProjectService()
    }).catch(e => console.warn('[ProjectService] 初始化失败:', e))

    const unsubActionToast = globalEventBus.on('WORKFLOW_COMPLETE', ({ projectSession, runId }) => {
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) return
      const text = useLocaleStore.getState().text
      const { activeRuns, history } = useWorkflowStore.getState()
      const completedRun = activeRuns.find(r => r.id === runId)
        ?? history.find(r => r.id === runId)
      if (!completedRun) return
      actionToast.workflowComplete(
        text(`「${completedRun.title}」已完成`, `“${completedRun.title}” completed`),
        () => navigate({ kind: 'run', facet: 'output', runId }),
      )
    })

    const unsubAutoOpenNextChapter = globalEventBus.on('FINALIZE_COMPLETE', ({
      chapterNumber,
      projectSession,
      source,
    }) => {
      void (async () => {
        try {
          if (source === 'batch') return
          const isCurrentProjectSession = () => sameProjectSessionContext(
            projectSession,
            projectSessionContextFromProject(useProjectStore.getState().currentProject),
          )
          if (!isCurrentProjectSession()) return
          const config = await ipc.invoke('config:get')
          if (!isCurrentProjectSession()) return
          if (!config.autoOpenNextChapterAfterFinalize) return

          const nextChapterNumber = chapterNumber + 1
          const [blueprint, existingDraft] = await Promise.all([
            ipc.invokeWithProjectSession(
              projectSession,
              'db:blueprint-get',
              nextChapterNumber,
              projectSession.projectPath,
            ),
            ipc.invokeWithProjectSession(
              projectSession,
              'db:draft-get-latest',
              nextChapterNumber,
              projectSession.projectPath,
            ),
          ])
          if (!isCurrentProjectSession()) return
          const prefill = getAutoNextChapterPrefill(
            true,
            chapterNumber,
            blueprint as NextChapterBlueprint | null,
            existingDraft !== null,
          )
          if (prefill) navigate({ kind: 'chapter', chapterNumber: nextChapterNumber, write: prefill })
        } catch (error) {
          console.warn('[AutoNextChapter] 无法打开下一章创作窗口:', error)
        }
      })()
    })

    return () => {
      import('./services/project-service').then(({ disposeProjectService }) => {
        disposeProjectService()
      }).catch(() => {})
      unsubActionToast()
      unsubAutoOpenNextChapter()
    }
  }, [initLocale, initTheme, initLLM, loadRecentProjects])

  useEffect(() => {
    if (!ipc.isElectron) return
    void ipc.invoke('project:smoke-open-request').then(async (request) => {
      if (!request) return
      const opened = await useProjectStore.getState().openProject(request.projectPath)
      // i18n-exempt: 烟测打开只在测试驱动发起，失败只进控制台日志
      if (!opened) throw new Error('烟测项目打开失败')
      const confirmed = await ipc.invoke('project:smoke-open-confirm', request.projectPath)
      // i18n-exempt: 同上，只进控制台日志
      if (!confirmed.success) throw new Error(confirmed.error || '烟测项目确认失败')
    }).catch(error => console.error('[SmokeProjectOpen]', error))
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        leaveSettingsThen(() => useLayoutStore.getState().openNewProject())
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault()
        openProjectFolder()
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        useThemeStore.getState().zoomIn()
      } else if (e.key === '-') {
        e.preventDefault()
        useThemeStore.getState().zoomOut()
      } else if (e.key === '0') {
        e.preventDefault()
        useThemeStore.getState().zoomReset()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const globalDialogs = (
    <>
      {}
      <ImportNovelDialog
        open={importNovelOpen}
        onClose={closeImportNovel}
      />
      <ExportDialog
        isOpen={exportOpen}
        onClose={closeExport}
      />
    </>
  )

  return (
    <>
      <StageRoot theme={resolvedTheme} exitGuard={exitGuard}>
        <StageShell theme={resolvedTheme} />
      </StageRoot>
      <UpdateNotifier />
      {globalDialogs}
    </>
  )
}
