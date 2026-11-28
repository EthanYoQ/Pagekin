import { afterEach, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc-client', () => ({ ipc: { invoke } }))

import { appErrorMessage } from '../../i18n/app-errors'
import { shown } from '../../i18n/__tests__/shown-locale'
import { useLocaleStore } from '../../stores/locale-store'
import { selectPlanningMaterials } from '../knowledge-service'

const original = useLocaleStore.getState()
afterEach(() => useLocaleStore.setState(original, true))

it('读不了选中的资料又说不出原因时，按界面语言说出是哪个文件，不露英文原文', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'dialog:select-knowledge-files') return [{ grantId: 'g1', displayName: '人物设定.md' }]
    return { success: false, content: '' }
  })

  const thrown = await selectPlanningMaterials().catch((error: unknown) => error)

  expect(appErrorMessage(shown('zh-CN'), thrown)).toBe('读不了「人物设定.md」，请重新选择。')
  expect(appErrorMessage(shown('en-US'), thrown)).toBe('Could not read “人物设定.md”. Choose it again.')
})
