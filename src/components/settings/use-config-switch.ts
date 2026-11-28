import { useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { currentInterfaceLocale } from '../../stores/locale-store'
import { displayedErrorMessage, resultFailure, authorErrorOr, catalogNote } from '../../i18n/app-errors'
import type { GlobalConfig } from '../../shared/ipc-channels'

type SwitchKey = 'autoOpenNextChapterAfterFinalize' | 'backgroundStageNotifications'

/** 键缺省时取 fallback。 */
export function useConfigSwitch(key: SwitchKey, fallback: boolean, failure: (reason: string) => string) {
  const [enabled, setEnabled] = useState(fallback)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke('config:get').then((config: GlobalConfig) => {
      setEnabled(config[key] ?? fallback)
    }).catch(() => {})
  }, [key, fallback])

  const set = async (checked: boolean) => {
    const previous = enabled
    setEnabled(checked)
    setSaving(true)
    setError(null)
    try {
      const result = await ipc.invoke('config:set', { [key]: checked })
      if (!result.success) throw authorErrorOr(currentInterfaceLocale(), resultFailure(result), catalogNote('error.unregisteredCode'))
    } catch (cause) {
      setEnabled(previous)
      setError(failure(displayedErrorMessage(currentInterfaceLocale(), cause)))
    } finally {
      setSaving(false)
    }
  }

  return { enabled, saving, error, set }
}
