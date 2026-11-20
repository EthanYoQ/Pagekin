import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { CharacterRosterEntry } from '../../../../shared/character-roster'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { InferGlobalSettingsCommand as RuntimeInferGlobalSettingsCommand } from '../import-novel.command'
import { useFakeModelStream, workflowRuntimeDependencies, type FakeGenerateStream } from './workflow-generation-runtime.fixture'
import { shown } from '../../../../i18n/__tests__/shown-locale'

class InferGlobalSettingsCommand extends RuntimeInferGlobalSettingsCommand {
  constructor() { super(workflowRuntimeDependencies) }
}

const originalGenerateStream = useFakeModelStream.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

function createContext(importRunPurpose: 'reference' | 'author-manuscript' = 'reference'): WorkflowContext {
  return {
    runId: 'test-run',
    projectPath: 'C:\\tmp\\vela-import-test',
    projectSession: {
      projectId: 'project-1',
      leaseId: 'lease-project-1',
      projectPath: 'C:\\tmp\\vela-import-test',
    },
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN', interfaceLocale: shown('zh-CN'),
    data: {
      importRunPurpose,
      novelConfigSummary: '类型: 玄幻',
      chapters: [
        {
          number: 1,
          title: '启程',
          content: '主角在雨夜发现异常，并踏上旅程。',
          wordCount: 18,
        },
      ],
    },
    cancelled: false,
  }
}

function card(name: string, role: CharacterRosterEntry['role']): CharacterRosterEntry {
  return {
    name,
    role,
    gender: '未知',
    age: '18',
    appearance: '外貌明确',
    personality: '性格明确',
    background: '背景明确',
    abilities: '能力明确',
    motivation: '动机明确',
    relationships: [],
    arc: '角色弧光',
    notes: '待确认',
    currentState: {
      location: '城中',
      powerLevel: '普通',
      physicalState: '正常',
      mentalState: '警觉',
      keyItems: '无',
      recentEvents: '启程',
      updatedAtChapter: 1,
    },
  }
}

function validInference() {
  return {
    novelConfig: {
      genre: '现实',
      subGenre: '讽刺',
      targetAudience: '通用',
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '主角在冲突中逐步认识世界。',
      worldSetting: '现实社会。',
      goldenFinger: '无。',
      protagonistProfile: '敏感而倔强。',
      globalGuidance: '保持克制叙事。',
    },
    architectureFiles: {
      premise: '个人与环境持续冲突。',
      worldbuilding: '现实社会结构。',
      synopsis: '主角经历挫折并作出选择。',
    },
    characterCards: [
      card('陆舟', 'protagonist'),
      card('苏绾', 'supporting'),
      card('顾岩', 'antagonist'),
    ],
  }
}

function withMissingEndpoint(name = '韩烁') {
  const inference = validInference()
  inference.characterCards[0].relationships.push({ target: name, relation: '旧债牵连' })
  return inference
}

function stubIpcInvoke(handler: (channel: string, ...args: unknown[]) => unknown) {
  const invoke = vi.fn((channel: string, ...args: unknown[]) => Promise.resolve(
    channel === 'prompt:load-global' ? { templates: [], diagnostics: [] }
      : channel === 'fs:check-exists' && String(args[0]).endsWith('/.ai-novel/prompts') ? false
        : handler(channel, ...args),
  ))
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  return invoke
}

function stubSuccessfulImportIpc() {
  return stubIpcInvoke((channel, request) => {
    if (channel === 'kb:search') return []
    if (channel === 'db:character-roster-read') return { status: 'ready', revision: 7, entries: [] }
    if (channel === 'db:import-global-facts-commit') {
      const candidate = request as { operationId: string; core: object; characterEntries: unknown[] }
      return {
        success: true,
        receipt: {
          operationId: candidate.operationId,
          payloadHash: 'f'.repeat(64),
          idempotent: false,
          core: candidate.core,
          roster: { snapshot: { status: 'ready', entries: candidate.characterEntries } },
        },
      }
    }
    throw new Error(`unexpected IPC ${channel}`)
  })
}

function committedEntries(invoke: ReturnType<typeof stubIpcInvoke>): CharacterRosterEntry[] {
  const commit = invoke.mock.calls.find(([channel]) => channel === 'db:import-global-facts-commit')
  if (!commit) throw new Error('global facts were not committed')
  return (commit[1] as { characterEntries: CharacterRosterEntry[] }).characterEntries
}

function relationshipsOf(entries: CharacterRosterEntry[]) {
  return Object.fromEntries(entries.map(entry => [entry.name, entry.relationships]))
}

function stubNoCommitIpc() {
  return stubIpcInvoke((channel) => {
    if (channel === 'kb:search') return []
    throw new Error(`unexpected IPC ${channel}`)
  })
}

function respondWith(responses: unknown[], finishReasons: Array<'stop' | 'length'> = []) {
  const serialized = responses.map(response => typeof response === 'string' ? response : JSON.stringify(response))
  let callCount = 0
  const generateStream = vi.fn<FakeGenerateStream>(
    async (_messages, streamCallbacks) => {
      const output = serialized[callCount]
      if (output === undefined) throw new Error('unexpected import inference request')
      const finishReason = finishReasons[callCount] ?? 'stop'
      callCount += 1
      streamCallbacks.onDone?.(output, undefined, finishReason)
      return `request-${callCount}`
    },
  )
  useLLMStore.setState({ defaultModelId: 'model-a' })
  useFakeModelStream.setState({ generateStream })
  return generateStream
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({
    currentProject: {
      id: 'project-1',
      name: '导入项目',
      path: 'C:\\tmp\\vela-import-test',
      sessionLease: 'lease-project-1',
      novelConfig: {
        genre: '玄幻',
        subGenre: '',
        targetAudience: '男频',
        totalChapters: 1,
        wordsPerChapter: 3000,
        plotStructure: 'three_act',
        narrativePOV: 'third_limited',
        coreOutline: '',
        worldSetting: '',
        goldenFinger: '',
        protagonistProfile: '',
        globalGuidance: '',
      },
      characterStates: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ defaultModelId: originalDefaultModelId })
  useFakeModelStream.setState({ generateStream: originalGenerateStream })
})

describe('InferGlobalSettingsCommand relationship endpoint recovery', () => {
  it.each(['reference', 'author-manuscript'] as const)('%s import gives every named person a card: main cards first, the rest in batches of three, keeping relationships to later batches', async (purpose) => {
    const invoke = stubSuccessfulImportIpc()
    const others = ['林照', '白榆', '沈珩', '周砚', '秦若', '叶宁', '韩烁', '秦川', '许砚', '唐霁', '闻策']
    const initial = { ...validInference(), otherCharacters: others.map(name => ({ name, role: 'supporting', note: '原稿里出场的人物' })) }
    initial.characterCards[0].relationships.push({ target: '苏绾', relation: '同窗' }, { target: '闻策', relation: '旧债牵连' })
    const batches = [others.slice(0, 3), others.slice(3, 6), others.slice(6, 9), others.slice(9)]
    const deltas = batches.map(names => ({ characterCards: names.map(name => card(name, 'supporting')) }))
    deltas[0].characterCards[0].relationships.push({ target: '唐霁', relation: '师兄' })
    const generateStream = respondWith([initial, ...deltas])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(purpose), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(5)
    const entries = committedEntries(invoke)
    expect(entries.map(entry => entry.name)).toEqual(['陆舟', '苏绾', '顾岩', ...others])
    expect(relationshipsOf(entries)).toMatchObject({
      陆舟: [{ target: '苏绾', relation: '同窗' }, { target: '闻策', relation: '旧债牵连' }],
      林照: [{ target: '唐霁', relation: '师兄' }],
    })
    expect(callbacks.log).not.toHaveBeenCalledWith(expect.stringMatching(/已丢弃/))
  })

  it('still asks for cards when the first round is complete but lists people without cards', async () => {
    const invoke = stubSuccessfulImportIpc()
    const initial = { ...validInference(), otherCharacters: [{ name: '韩烁', role: 'minor', note: '码头脚夫' }] }
    const generateStream = respondWith([initial, { characterCards: [card('韩烁', 'minor')] }])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(committedEntries(invoke).map(entry => entry.name)).toEqual(['陆舟', '苏绾', '顾岩', '韩烁'])
  })

  it('keeps the batches that came back right and tells the author who is still missing a card', async () => {
    const invoke = stubSuccessfulImportIpc()
    const others = ['林照', '白榆', '沈珩', '周砚']
    const initial = { ...validInference(), otherCharacters: others.map(name => ({ name, role: 'supporting', note: '原稿人物' })) }
    initial.characterCards[0].relationships.push({ target: '周砚', relation: '旧识' })
    const generateStream = respondWith([initial, { characterCards: others.slice(0, 3).map(name => card(name, 'supporting')) }, { characterCards: [card('任意新增', 'minor')] }])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(3)
    expect(committedEntries(invoke).map(entry => entry.name)).toEqual(['陆舟', '苏绾', '顾岩', '林照', '白榆', '沈珩'])
    const logged = vi.mocked(callbacks.log).mock.calls.map(([line]) => line).join('\n')
    expect(logged).toMatch(/周砚/)
    expect(logged).toMatch(/新建角色/)
    expect(logged).not.toMatch(/最多 8/)
  })

  it('still fails a first round whose relationship violates another contract rule', async () => {
    const invoke = stubNoCommitIpc()
    const initial = validInference()
    initial.characterCards[0].relationships.push({ target: '陆舟', relation: '自我' })
    const generateStream = respondWith([initial])

    await expect(new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow()

    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:import-global-facts-commit')
  })

  it('adds only missing endpoint cards from a strict delta through one bounded correction before the atomic global-facts commit', async () => {
    const invoke = stubSuccessfulImportIpc()
    const initial = withMissingEndpoint()
    const delta = { characterCards: [card('韩烁', 'supporting')] }
    const generateStream = respondWith([initial, delta])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('正在补 1 张角色卡：韩烁'))
    expect(invoke).toHaveBeenLastCalledWith(
      'db:import-global-facts-commit',
      expect.objectContaining({
        expectedRosterRevision: 7,
        characterEntries: [
          expect.objectContaining({
            name: '陆舟',
            relationships: [{ target: '韩烁', relation: '旧债牵连' }],
          }),
          expect.objectContaining({ name: '苏绾' }),
          expect.objectContaining({ name: '顾岩' }),
          expect.objectContaining({ name: '韩烁', relationships: [] }),
        ],
      }),
      'C:\\tmp\\vela-import-test',
      expect.objectContaining({ projectId: 'project-1' }),
    )
  })

  it.each([
    ['a full-object correction', (initial: ReturnType<typeof validInference>) => ({
      ...initial,
      characterCards: [
        { ...initial.characterCards[0], relationships: [{ target: '韩烁', relation: '改写关系' }] },
        initial.characterCards[1],
        initial.characterCards[2],
        card('韩烁', 'supporting'),
      ],
    })],
    ['a delta card with extra keys', () => ({
      characterCards: [{ ...card('韩烁', 'supporting'), extraFact: '不允许的字段' }],
    })],
    ['a delta with an arbitrary extra card', () => ({
      characterCards: [card('韩烁', 'supporting'), card('任意新增', 'minor')],
    })],
    ['a delta card with an invalid role', () => ({
      characterCards: [{ ...card('韩烁', 'supporting'), role: '配角' }],
    })],
    ['a delta relationship with a non-text target', () => ({
      characterCards: [{ ...card('韩烁', 'supporting'), relationships: [{ target: null, relation: '旧识' }] }],
    })],
    ['a delta relationship with a non-text relation to a missing character', () => ({
      characterCards: [{ ...card('韩烁', 'supporting'), relationships: [{ target: '无名氏', relation: 5 }] }],
    })],
  ])('adopts no card from %s and commits the original cards without the dangling relationship', async (_name, correction) => {
    const invoke = stubSuccessfulImportIpc()
    const initial = withMissingEndpoint()
    initial.characterCards[0].relationships.unshift({ target: '苏绾', relation: '同窗' })
    const generateStream = respondWith([initial, correction(initial)])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(2)
    const entries = committedEntries(invoke)
    expect(entries.map(entry => entry.name)).toEqual(['陆舟', '苏绾', '顾岩'])
    expect(relationshipsOf(entries).陆舟).toEqual([{ target: '苏绾', relation: '同窗' }])
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringMatching(/陆舟→韩烁.*角色/))
  })

  it('adopts no card from duplicate delta cards that omit another endpoint and drops both dangling relationships', async () => {
    const invoke = stubSuccessfulImportIpc()
    const initial = withMissingEndpoint('韩烁')
    initial.characterCards[1].relationships.push({ target: '叶宁', relation: '暗中相助' })
    const generateStream = respondWith([initial, { characterCards: [card('韩烁', 'supporting'), card('韩烁', 'minor')] }])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(2)
    const entries = committedEntries(invoke)
    expect(entries.map(entry => entry.name)).toEqual(['陆舟', '苏绾', '顾岩'])
    expect(relationshipsOf(entries)).toMatchObject({ 陆舟: [], 苏绾: [] })
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringMatching(/已丢弃 2 条关系/))
  })

  it('matches names and relationship targets the way the decoder trims them', async () => {
    const invoke = stubSuccessfulImportIpc()
    const initial = validInference()
    initial.characterCards[1].name = '苏绾 '
    initial.characterCards[0].relationships.push(
      { target: '苏绾', relation: '同窗' },
      { target: '韩烁 ', relation: '旧债牵连' },
    )
    const generateStream = respondWith([initial, { characterCards: [card('韩烁', 'supporting')] }])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(JSON.stringify(generateStream.mock.calls[1][0])).toContain(JSON.stringify(JSON.stringify(['韩烁'])).slice(1, -1))
    const entries = committedEntries(invoke)
    expect(entries.map(entry => entry.name)).toEqual(['陆舟', '苏绾', '顾岩', '韩烁'])
    expect(relationshipsOf(entries).陆舟).toEqual([
      { target: '苏绾', relation: '同窗' },
      { target: '韩烁', relation: '旧债牵连' },
    ])
  })

  it('adopts a correction card whose name differs from the endpoint only by surrounding whitespace', async () => {
    const invoke = stubSuccessfulImportIpc()
    const generateStream = respondWith([withMissingEndpoint(), { characterCards: [card(' 韩烁 ', 'supporting')] }])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(2)
    const entries = committedEntries(invoke)
    expect(entries.map(entry => entry.name)).toEqual(['陆舟', '苏绾', '顾岩', '韩烁'])
    expect(relationshipsOf(entries).陆舟).toEqual([{ target: '韩烁', relation: '旧债牵连' }])
  })

  it('still fails before commit when the correction reply is truncated', async () => {
    const invoke = stubNoCommitIpc()
    const generateStream = respondWith(
      [withMissingEndpoint(), { characterCards: [card('韩烁', 'supporting')] }],
      ['stop', 'length'],
    )

    await expect(new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow()

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:import-global-facts-commit')
  })
})
