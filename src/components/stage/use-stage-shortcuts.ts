import { useEffect } from 'react'
import { editorSaveHandler, useEditorStore } from '../../stores/editor-store'
import { useLayoutStore } from '../../stores/layout-store'
import { leaveSettings } from '../settings/unsaved-settings'
import { useStageStore } from '../../stores/navigation/stage-store'
import { IS_MAC, isCommand, isComposing, isModalOpen } from './shortcut-keys'
import { requestCloseTab } from './tab-close'

function saveActiveTab(): void {
  const { tabs, activeTabId } = useEditorStore.getState()
  const tab = tabs.find(candidate => candidate.id === activeTabId)
  if (!tab?.dirty) return
  void editorSaveHandler(tab)?.().catch(() => undefined)
}

export function useStageShortcuts({ library, focus, mac = IS_MAC }: { library: boolean; focus: boolean; mac?: boolean }): void {
  useEffect(() => {
    const onCommand = (event: KeyboardEvent) => {
      const close = isCommand(event, 'w', mac)
      if (close) event.preventDefault()
      if (isComposing(event)) return
      const commands = isCommand(event, 'k', mac)
      const chapters = isCommand(event, 'p', mac)
      if (!close && !commands && !chapters) return
      if (useStageStore.getState().palette) {
        if (commands) {
          event.preventDefault()
          useStageStore.setState({ palette: null })
        }
        return
      }
      if (isModalOpen()) return
      if (close && useLayoutStore.getState().settingsOpen) {
        leaveSettings(() => useLayoutStore.getState().closeSettings())
        return
      }
      if (commands) {
        event.preventDefault()
        useStageStore.setState({ palette: 'commands' })
      } else if (chapters && !library) {
        event.preventDefault()
        useStageStore.setState({ palette: 'chapters' })
      } else if (close && !library) {
        const { activeTabId } = useEditorStore.getState()
        if (activeTabId) requestCloseTab(activeTabId)
      }
    }
    const onUnhandled = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposing(event)) return
      if (event.key === 'Escape') {
        if (!focus || useStageStore.getState().palette || isModalOpen() || useLayoutStore.getState().settingsOpen) return
        event.preventDefault()
        useStageStore.setState({ focus: false })
      } else if (!library && isCommand(event, 's', mac) && !isModalOpen()) {
        event.preventDefault()
        if (!useLayoutStore.getState().settingsOpen) saveActiveTab()
      }
    }
    window.addEventListener('keydown', onCommand, true)
    window.addEventListener('keydown', onUnhandled)
    return () => {
      window.removeEventListener('keydown', onCommand, true)
      window.removeEventListener('keydown', onUnhandled)
    }
  }, [library, focus, mac])
}
