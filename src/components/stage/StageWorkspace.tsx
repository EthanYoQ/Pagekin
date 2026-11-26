import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useEditorStore, type EditorTab } from '../../stores/editor-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useStageStore } from '../../stores/navigation/stage-store'
import type { ProjectData } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import { ErrorBoundary } from '../ErrorBoundary'
import ArchFileViewer from '../editor/ArchFileViewer'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { DangerConfirm } from '../ui/DangerConfirm'
import RunSheet from './run/RunSheet'
import StageArchitecture from './architecture/StageArchitecture'
import StageCharacters from './characters/StageCharacters'
import StageLibrary from './library/StageLibrary'
import { SettingsPage, SetupPage } from './stage-pages'
import StageHistory from './history/StageHistory'
import StageKnowledge from './knowledge/StageKnowledge'
import StagePlot from './plot/StagePlot'
import StageTabMenu, { CloseTabsConfirm } from './StageTabMenu'
import StageTabs from './StageTabs'
import { commandLabel, isComposing, isModalOpen } from './shortcut-keys'
import BlueprintRecovery from './blueprint/BlueprintRecovery'
import StageBlueprint from './blueprint/StageBlueprint'
import ChapterView from './chapter/ChapterView'
import ProseDocument from './chapter/ProseDocument'
import { installChapterTabRouting, isChapterViewTab, isProseDocumentTab } from './chapter/chapter-tab-routing'
import { stageTabName } from './stage-text'
import { cancelCloseTab, closeCleanTabs, confirmCloseTab, requestCloseTab, STAGE_CONTENT_ID } from './tab-close'

function TabContent({ tab, project }: { tab: EditorTab; project: ProjectData }) {
  const text = useLocaleStore(s => s.text)
  const sameProject = sameProjectPathKey(tab.projectKey, project.path)
  if (tab.type === 'config' && tab.projectKey) return <SetupPage projectKey={tab.projectKey} />
  if (tab.type === 'world-building' && tab.projectKey) return <StageArchitecture projectKey={tab.projectKey} />
  if (tab.type === 'character' && tab.projectKey) return <StageCharacters projectKey={tab.projectKey} />
  if (isChapterViewTab(tab)) return <ChapterView tab={tab} />
  if (isProseDocumentTab(tab) && sameProject) return <ProseDocument tab={tab} project={project} />
  if (tab.type === 'chapter-card' && tab.projectKey && tab.planningRecovery) {
    return <BlueprintRecovery key={`${tab.id}:${project.sessionLease}`} tab={tab} projectKey={tab.projectKey} />
  }
  if (tab.type === 'chapter-card' && tab.projectKey) {
    return <StageBlueprint projectKey={tab.projectKey} initialChapterNumber={tab.chapterNumber} selectRequest={tab.chapterSelectRequest} />
  }
  if (tab.type === 'version-history' && sameProject) return <StageHistory projectKey={project.path} />
  if (tab.type === 'knowledge' && sameProject) return <StageKnowledge tabId={tab.id} />
  if (tab.type === 'narrative-thread' && sameProject) {
    return <StagePlot projectKey={project.path} initialView={tab.narrativeThreadView ?? 'plans'} viewRequest={tab.narrativeThreadViewRequest} />
  }
  if (tab.type === 'arch-file' && tab.filePath && tab.projectKey) {
    return <ArchFileViewer key={tab.id} tabId={tab.id} filePath={tab.filePath} projectKey={tab.projectKey} content={tab.content ?? ''} savedContent={tab.savedContent ?? tab.content ?? ''} />
  }
  return (
    <EmptyState
      heading={text('这个标签没有可显示的页面', 'This tab has no page to show')}
      description={text('它可能属于另一部作品，或者来自旧版界面。关掉它不会改动作品。', 'It may belong to another book or come from the old interface. Closing it does not change the book.')}
      action={<Button variant="secondary" onClick={() => requestCloseTab(tab.id)}>{text('关闭标签', 'Close tab')}</Button>}
    />
  )
}

const TABBABLE = 'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]'
const tabbables = (root: Element) => [...root.querySelectorAll<HTMLElement>(TABBABLE)]
  .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)

const isEditable = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)

const floatingSheet = (slot: HTMLElement | null) => slot && getComputedStyle(slot).position === 'absolute' ? slot : null

function moveFocusOffSheet(body: Element, target: Element, sheetSlot: HTMLElement, backward: boolean) {
  if (sheetSlot.contains(target)) return
  const sheet = sheetSlot.getBoundingClientRect()
  const covered = (element: Element) => element.getBoundingClientRect().left >= sheet.left
  if (!covered(target)) return
  const region = [...body.children].find(child => child.contains(target)) as HTMLElement | undefined
  if (!region) return
  const follows = (element: Element) => (target.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  const order = tabbables(region).filter(element => element !== target && follows(element) !== backward)
  const next = (backward ? order.reverse() : order).find(element => !covered(element))
  ;(next ?? (backward && region.hasAttribute('tabindex') ? region : tabbables(sheetSlot)[0]))?.focus()
}

function skipCoveredFocus(event: FocusEvent<HTMLElement>, slot: HTMLElement | null) {
  const sheetSlot = floatingSheet(slot)
  if (!sheetSlot) return
  const target = event.target
  const backward = event.relatedTarget instanceof Node && (target.compareDocumentPosition(event.relatedTarget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  moveFocusOffSheet(event.currentTarget, target, sheetSlot, backward)
}

export default function StageWorkspace({ library, focus }: { library: boolean; focus: boolean }) {
  const settingsOpen = useLayoutStore(s => s.settingsOpen)
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const sheet = useStageStore(s => s.sheet)
  const tabDomId = (tabId: string) => `${STAGE_CONTENT_ID}-tab-${tabId.replace(/[^\w-]/g, '_')}`
  const closingTabId = useStageStore(s => s.closingTabId)
  const pending = tabs.find(tab => tab.id === closingTabId) ?? null
  const pendingName = pending ? stageTabName(pending, text) : ''
  const [closingMany, setClosingMany] = useState<readonly string[] | null>(null)
  const sheetSlotRef = useRef<HTMLDivElement>(null)
  const closeFloatingSheet = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return
    if (isComposing(event.nativeEvent) || isModalOpen() || settingsOpen || isEditable(event.target)) return
    if (floatingSheet(sheetSlotRef.current)) useStageStore.setState({ sheet: null })
  }
  const closeMany = (tabIds: readonly string[]) => {
    const dirty = closeCleanTabs(tabIds)
    if (dirty.length > 0) setClosingMany(dirty)
  }

  const activeTab = tabs.find(tab => tab.id === activeTabId)
  useEffect(() => installChapterTabRouting(), [])
  const sheetMounted = sheet?.kind === 'run' && !focus && !library && project !== null
  useEffect(() => {
    const slot = sheetSlotRef.current
    const body = slot?.parentElement
    if (!sheetMounted || !slot || !body) return
    const observer = new ResizeObserver(() => {
      const sheetSlot = floatingSheet(slot)
      const active = document.activeElement
      if (sheetSlot && active && body.contains(active)) moveFocusOffSheet(body, active, sheetSlot, false)
    })
    observer.observe(body)
    return () => observer.disconnect()
  }, [sheetMounted])
  useEffect(() => {
    if (tabs.length > 0 && !activeTab) useEditorStore.getState().setActiveTab(tabs[0].id)
  }, [tabs, activeTab])

  if (library || !project) {
    return (
      <main className="stage-panel" data-page={settingsOpen ? 'settings' : 'library'}>
        {settingsOpen ? <SettingsPage library /> : <div className="stage-library"><StageLibrary /></div>}
      </main>
    )
  }

  const showTabs = !focus && !settingsOpen && tabs.length > 1
  return (
    <main className="stage-panel">
      {showTabs && (
        <div className="stage-tabbar">
          <StageTabs
            tabs={tabs}
            activeTabId={activeTab?.id ?? null}
            onSelect={tabId => useEditorStore.getState().setActiveTab(tabId)}
            onClose={requestCloseTab}
            tabDomId={tabDomId}
            panelId={STAGE_CONTENT_ID}
          />
          <StageTabMenu tabs={tabs} activeTabId={activeTab?.id ?? null} onSelect={tabId => useEditorStore.getState().setActiveTab(tabId)} onCloseMany={closeMany} />
        </div>
      )}
      <div className="stage-body" onKeyDown={closeFloatingSheet} onFocus={event => skipCoveredFocus(event, sheetSlotRef.current)}>
        {settingsOpen && <SettingsPage library={false} />}
        <div
          className="stage-content"
          hidden={settingsOpen}
          id={STAGE_CONTENT_ID}
          tabIndex={-1}
          role={showTabs ? 'tabpanel' : undefined}
          aria-labelledby={showTabs && activeTab ? tabDomId(activeTab.id) : undefined}
        >
          {activeTab
            ? (
              <ErrorBoundary key={activeTab.id} fallbackLabel={text('编辑区渲染失败', 'Editor failed to render')}>
                <TabContent tab={activeTab} project={project} />
              </ErrorBoundary>
            )
            : (
              <EmptyState
                heading={text('从流程脊选一步开始', 'Pick a step in the flow to begin')}
                description={text('左侧按设定、架构、蓝图、正文排列，点任意一步打开它。', 'Setup, architecture, blueprint and manuscript are listed on the left. Open any of them.')}
                action={<Button variant="primary" onClick={() => navigate({ kind: 'stage', stage: 'setup' })}>{text('打开设定', 'Open setup')}</Button>}
              />
            )}
        </div>
        {sheet?.kind === 'run' && !focus && (
          <div ref={sheetSlotRef} className="stage-sheet-slot" data-wide={sheet.tab === 'diagnostics' || undefined}>
            <ErrorBoundary fallbackLabel={text('运行侧页渲染失败', 'Run sheet failed to render')}>
              <RunSheet sheet={sheet} />
            </ErrorBoundary>
          </div>
        )}
      </div>
      <DangerConfirm
        open={pending !== null}
        onOpenChange={open => { if (!open) cancelCloseTab() }}
        title={text('放弃未保存的修改？', 'Discard unsaved changes?')}
        consequence={text(`「${pendingName}」有未保存的修改，关闭后这些修改会丢失。`, `“${pendingName}” has unsaved changes. Closing it discards them.`)}
        recoverability={text(`丢弃后无法恢复。想保留就选「继续编辑」，再按 ${commandLabel('s')} 保存。`, `This cannot be undone. Choose “Keep editing” and press ${commandLabel('s')} to keep them.`)}
        confirmLabel={text('放弃并关闭', 'Discard and close')}
        cancelLabel={text('继续编辑', 'Keep editing')}
        onConfirm={confirmCloseTab}
      />
      <CloseTabsConfirm pending={closingMany} onSettled={() => setClosingMany(null)} />
    </main>
  )
}
