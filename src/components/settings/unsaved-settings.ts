import { useEffect } from 'react'
import { create } from 'zustand'
import { ipc } from '../../services/ipc-client'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { toast } from '../ui/Toast'

const unsaved = new Set<symbol>()
export function useUnsavedSettings(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const token = Symbol('unsaved-settings')
    unsaved.add(token)
    return () => { unsaved.delete(token) }
  }, [dirty])
}

export const useSettingsLeave = create<{ pending: { proceed: () => void; stay?: () => void } | null }>(() => ({ pending: null }))

export function settleSettingsLeave(discard: boolean): void {
  const pending = useSettingsLeave.getState().pending
  useSettingsLeave.setState({ pending: null })
  if (discard) pending?.proceed()
  else pending?.stay?.()
}

export function useSettingsLeaveHost(): void {
  useEffect(() => () => settleSettingsLeave(false), [])
}

export function leaveSettings(action: () => void, stay?: () => void): void {
  if (unsaved.size === 0) action()
  else if (useSettingsLeave.getState().pending) {
    stay?.()
    toast.info(useLocaleStore.getState().text('请先处理「放弃未保存的修改？」', 'Resolve “Discard unsaved changes?” first'))
  } else useSettingsLeave.setState({ pending: { proceed: action, stay } })
}

export function leaveSettingsThen(action: () => void, stay?: () => void): void {
  leaveSettings(() => {
    useLayoutStore.getState().closeSettings()
    action()
  }, stay)
}

export function openProjectFolder(): void {
  leaveSettings(() => void ipc.invoke('dialog:select-folder', 'project-open').then(folder => {
    if (!folder) return
    useLayoutStore.getState().closeSettings()
    return useProjectStore.getState().openProject(folder)
  }))
}

export function confirmLeaveSettings(): Promise<'left' | 'stayed' | 'busy'> {
  if (useSettingsLeave.getState().pending) return Promise.resolve('busy')
  return new Promise(resolve => leaveSettingsThen(() => resolve('left'), () => resolve('stayed')))
}
