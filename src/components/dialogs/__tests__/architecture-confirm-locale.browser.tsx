import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { translate } from '../../../i18n/core'
import type { InterfaceLocale } from '../../../i18n/types'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import ArchitectureConfirmDialog from '../ArchitectureConfirmDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NO_OUTLINE = { synopsis: '', totalChapters: 10, writingLanguage: 'zh-CN' as const }
const NOTHING_GENERATED = { premise: false, characters: false, worldbuilding: false, synopsis: false }

const baseConfig = {
  genre: '奇幻', subGenre: '', targetAudience: '', totalChapters: 10, wordsPerChapter: 3000,
  plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '完整的故事构想',
  worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
}

let root: Root
let container: HTMLDivElement
let blueprintChapterNumbers: number[]

function useInterface(locale: InterfaceLocale) {
  useLocaleStore.setState({ interfaceLocale: locale, locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US' })
}

function openProject(config: Partial<typeof baseConfig> = {}) {
  useProjectStore.setState({
    currentProject: { id: 'locale', sessionLease: 'lease-locale', name: 'Locale', path: 'C:\\novels\\locale', novelConfig: { ...baseConfig, ...config } } as never,
  })
}

async function renderDialog(props: Partial<Parameters<typeof ArchitectureConfirmDialog>[0]> = {}) {
  await act(async () => root.render(
    <ArchitectureConfirmDialog
      isOpen
      onClose={vi.fn()}
      archStatus={NOTHING_GENERATED}
      synopsisSource={NO_OUTLINE}
      initialSelectedSteps={['premise']}
      onConfirm={vi.fn().mockResolvedValue(undefined)}
      {...props}
    />,
  ))
}

const submit = () => page.getByRole('button', { name: /确认生成|Generate \(/ })
const shownGuard = () => document.querySelector('[role="dialog"] .whitespace-pre-line')?.textContent

beforeEach(() => {
  blueprintChapterNumbers = []
  openProject()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'config:get') return {}
        if (channel === 'db:blueprint-get-all') return blueprintChapterNumbers.map(chapterNumber => ({ chapterNumber }))
        return { success: true }
      }),
      on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useInterface('zh-CN')
  useProjectStore.setState({ currentProject: null })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('架构确认表单的前置说明按界面语言显示（#939）', () => {
  it.each([
    ['zh-CN', '请先填写「小说配置」中的核心大纲或主角人设，AI 才能据此生成故事架构。\n\n当前类型：奇幻'],
    ['en-US', 'Fill in the core outline or protagonist profile in Novel Configuration before generating the story architecture.\n\nCurrent genre: 奇幻'],
    ['ja-JP', '物語の構成を生成する前に、「Novel configuration」でコアアウトラインか主人公の設定を入力してください。\n\n現在のジャンル：奇幻'],
  ] as const)('小说配置没填（%s）', async (locale, expected) => {
    useInterface(locale)
    openProject({ coreOutline: '' })
    await renderDialog()

    await act(async () => submit().click())

    await vi.waitFor(() => expect(shownGuard()).toBe(expected))
  })

  it.each([
    ['zh-CN', '还没有情节大纲，请从第 1 章起生成。'],
    ['en-US', 'There is no plot outline yet. Start from chapter 1.'],
    ['ja-JP', 'プロットのアウトラインがまだありません。第1章から生成してください。'],
  ] as const)('情节大纲范围接不上（%s）', async (locale, expected) => {
    useInterface(locale)
    await renderDialog({ initialSelectedSteps: ['synopsis'] })

    await act(async () => page.getByRole('spinbutton', { name: /本次生成范围的起始章|First chapter of this batch/ }).fill('3'))

    await expect.element(page.getByRole('alert')).toHaveTextContent(expected)
    expect(page.getByRole('alert').element().textContent).toBe(expected)
  })

  it.each([
    ['zh-CN', '情节大纲范围无效。请选择第 1–10 章内连续的 1–10 章。'],
    ['en-US', 'Invalid plot-outline range. Select 1-10 consecutive chapters within chapters 1-10.'],
    ['ja-JP', 'プロットのアウトラインの範囲が無効です。第1–10章の中から、連続する1–10章を選んでください。'],
  ] as const)('情节大纲范围超出全书章数（%s）', async (locale, expected) => {
    useInterface(locale)
    await renderDialog({ initialSelectedSteps: ['synopsis'] })

    await act(async () => page.getByRole('spinbutton', { name: /本次生成范围的结束章|Last chapter of this batch/ }).fill('11'))

    await vi.waitFor(() => expect(page.getByRole('alert').element().textContent).toBe(expected))
  })

  it.each([
    ['zh-CN', '已有章节蓝图，不能重新生成角色卡，否则现有蓝图和已写章节都会失效。\n\n要改角色，请直接编辑角色卡。'],
    ['en-US', 'Character cards cannot be regenerated while chapter blueprints exist, because that would invalidate existing blueprints and drafted chapters.\n\nEdit the character cards directly instead.'],
    ['ja-JP', '章のブループリントがすでにあるため、人物カードを再生成できません。再生成すると、既存のブループリントと執筆済みの章が使えなくなります。\n\n人物を変えるには、人物カードを直接編集してください。'],
  ] as const)('已有蓝图时重新生成角色卡（%s）', async (locale, expected) => {
    useInterface(locale)
    blueprintChapterNumbers = [1]
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await renderDialog({ archStatus: { ...NOTHING_GENERATED, characters: true }, initialSelectedSteps: ['characters'], onConfirm })

    await act(async () => submit().click())

    await vi.waitFor(() => expect(shownGuard()).toBe(expected))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it.each([
    ['zh-CN', '每章大纲目标须为 1–1000 的整数。'],
    ['en-US', 'The outline target must be an integer from 1 to 1000.'],
    ['ja-JP', '章ごとのアウトラインの目標は 1–1000 の整数にしてください。'],
  ] as const)('每章大纲目标不是合法整数（%s）', async (locale, expected) => {
    useInterface(locale)
    await renderDialog({ initialSelectedSteps: ['synopsis'] })
    const target = page.getByRole('spinbutton', { name: /每章大纲目标|Outline target/ })
    await expect.element(target).toBeEnabled()

    await act(async () => target.fill('0'))
    await act(async () => submit().click())

    await vi.waitFor(() => expect(shownGuard()).toBe(expected))
  })

  it.each(['zh-CN', 'en-US', 'ja-JP'] as const)('未标记的原始错误不露原文，只显示通用说明（%s）', async locale => {
    useInterface(locale)
    await renderDialog({ onConfirm: vi.fn().mockRejectedValue(new Error('架构启动被领域门禁拒绝')) })

    await act(async () => submit().click())

    await vi.waitFor(() => expect(shownGuard()).toBe(translate(locale, 'error.unregisteredCode')))
    expect(document.body.textContent).not.toContain('架构启动被领域门禁拒绝')
  })
})
