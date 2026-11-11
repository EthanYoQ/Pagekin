import { describe, expect, it } from 'vitest'

import type { PlotTreeSourceBundle } from '../plot-tree'
import {
  buildPlotTreeTask,
  derivePlotTreeSnapshot,
  parsePlotTreeSnapshot,
  PLOT_TREE_INPUT_MAX_CHARACTERS,
  PlotTreeSourceError,
} from '../plot-tree-generation-pure'

const NOW = '2026-09-02T03:04:05.000Z'

function thrownBy(operation: () => unknown): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  return undefined
}

it('records model, normalized, and deterministic derivation without losing source revision', () => {
  const input = sources()
  const now = '2026-09-13T00:00:00.000Z'
  const strict = derivePlotTreeSnapshot(JSON.stringify(modelResponse), input, now)
  expect(strict.kind).toBe('model')
  const repairable = structuredClone(modelResponse)
  repairable.tracks[0]!.startChapter = 999
  expect(derivePlotTreeSnapshot(JSON.stringify(repairable), input, now).kind).toBe('normalized')
  const fallback = derivePlotTreeSnapshot('not JSON', input, now)
  expect(fallback.kind).toBe('deterministic')
  expect(fallback.snapshot).toMatchObject({ generatedAt: now, sourceRevision: input.sourceRevision })
  expect(fallback).toEqual(derivePlotTreeSnapshot('not JSON', input, now))
})

function sources(): PlotTreeSourceBundle {
  const narrativeThread = {
    id: 7,
    title: 'Missing ledger',
    type: 'mystery',
    targetStartChapter: 1,
    targetEndChapter: 5,
    authorIntent: 'Reveal the forger in chapter five.',
    status: 'planted' as const,
    events: [{
      id: 11,
      type: 'planted' as const,
      evidence: 'the ledger was gone',
      reason: 'The finalized chapter plants the mystery.',
      chapterNumber: 1,
    }],
  }
  return {
    writingLanguage: 'en-US',
    synopsis: {
      content: 'A clerk investigates a ledger that vanished from a sealed safe.',
    },
    blueprints: [{
      chapterNumber: 1,
      title: 'The empty safe',
      purpose: 'Launch the investigation',
      keyEvents: 'The clerk discovers the missing ledger.',
    }],
    finalizedChapters: [{
      draftId: 41,
      chapterNumber: 1,
      title: 'The empty safe',
      summary: 'The ledger is missing and the clerk preserves the broken seal.',
    }],
    narrativeThreads: [narrativeThread],
    sourceRevision: '0'.repeat(64),
    snapshot: null,
  }
}

const modelResponse = {
  tracks: [{
    id: 'missing-ledger',
    title: 'Missing ledger investigation',
    role: 'main',
    startChapter: 1,
    endChapter: 5,
    summary: 'The clerk follows the missing ledger to its forger.',
    events: [
      {
        status: 'planned',
        chapterNumber: 1,
        summary: 'The investigation begins.',
        sources: [{ type: 'blueprint', chapterNumber: 1 }],
      },
      {
        status: 'occurred',
        chapterNumber: 1,
        summary: 'The disappearance is confirmed.',
        sources: [{ type: 'finalized-chapter', draftId: 41, chapterNumber: 1 }],
      },
      {
        status: 'occurred',
        chapterNumber: 1,
        summary: 'The mystery thread is planted.',
        sources: [{ type: 'narrative-thread', planId: 7, eventId: 11, chapterNumber: 1 }],
      },
    ],
  }],
}

describe('plot tree AI boundary', () => {
  it.each([
    ['synopsis only', () => {
      const value = sources()
      value.blueprints = []
      value.finalizedChapters = []
      value.narrativeThreads = []
      return value
    }],
    ['non-empty invalid source rows', () => {
      const value = sources()
      value.blueprints = [{ chapterNumber: 0, title: '', purpose: '', keyEvents: '' }]
      value.finalizedChapters = [{ draftId: 0, chapterNumber: 1, title: '', summary: '' }]
      value.narrativeThreads = []
      return value
    }],
  ] as const)('rejects %s before building a model task', (_label, buildSources) => {
    expect(() => buildPlotTreeTask(buildSources())).toThrow(PlotTreeSourceError)
  })

  it('rejects a model-expanded chapter range outside the real source domain', () => {
    const singleChapter = sources()
    singleChapter.narrativeThreads = []

    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        startChapter: 1,
        endChapter: 4_294_967_296,
        events: [modelResponse.tracks[0]!.events[0]],
      }],
    }), singleChapter)).toThrow(/章节范围|chapter range/u)
  })

  it.each([
    ['non-safe integer', Number.MAX_SAFE_INTEGER + 1],
    ['fraction', 1.5],
    ['negative', -1],
    ['missing', undefined],
  ])('rejects a %s track end chapter', (_label, endChapter) => {
    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        startChapter: 1,
        endChapter,
      }],
    }), sources())).toThrow(/章节|chapter/u)
  })

  it('rejects an inverted track range', () => {
    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{ ...modelResponse.tracks[0], startChapter: 5, endChapter: 1 }],
    }), sources())).toThrow(/章节范围|chapter range/u)
  })


  it('parses a complete snapshot and rejects references absent from the supplied facts', () => {
    expect(parsePlotTreeSnapshot(
      JSON.stringify(modelResponse),
      sources(),
      '2026-09-02T03:04:05.000Z',
    )).toMatchObject({
      version: 1,
      generatedAt: '2026-09-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision: '0'.repeat(64),
      tracks: modelResponse.tracks,
    })

    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        events: [{
          status: 'planned', chapterNumber: 2, summary: 'Invented event.',
          sources: [{ type: 'blueprint', chapterNumber: 2 }],
        }],
      }],
    }), sources())).toThrow(/source|来源/u)
  })

  it('accepts one complete JSON fence without searching explanatory prose', () => {
    expect(parsePlotTreeSnapshot(
      `\`\`\`json\n${JSON.stringify(modelResponse)}\n\`\`\``,
      sources(),
      '2026-09-02T03:04:05.000Z',
    ).tracks).toEqual(modelResponse.tracks)

    expect(() => parsePlotTreeSnapshot(
      `Here is the result:\n${JSON.stringify(modelResponse)}`,
      sources(),
    )).toThrow()
  })

  it.each([
    ['occurred event backed only by a blueprint', {
      status: 'occurred', chapterNumber: 1, summary: 'Not yet written.',
      sources: [{ type: 'blueprint', chapterNumber: 1 }],
    }],
    ['event whose source belongs to another chapter', {
      status: 'planned', chapterNumber: 2, summary: 'Wrong chapter.',
      sources: [{ type: 'blueprint', chapterNumber: 1 }],
    }],
    ['planned event disguised as a confirmed narrative event', {
      status: 'planned', chapterNumber: 1, summary: 'Ambiguous source.',
      sources: [{ type: 'narrative-thread', planId: 7, chapterNumber: 1 }],
    }],
  ])('rejects %s', (_label, event) => {
    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{ ...modelResponse.tracks[0], events: [event] }],
    }), sources())).toThrow(/来源|章节/u)
  })

  it('rejects an event when any cited source contradicts its status', () => {
    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        events: [{
          status: 'planned',
          chapterNumber: 1,
          summary: 'Mixed provenance.',
          sources: [
            { type: 'blueprint', chapterNumber: 1 },
            { type: 'finalized-chapter', draftId: 41, chapterNumber: 1 },
          ],
        }],
      }],
    }), sources())).toThrow(/来源|章节/u)
  })

  it('rejects a subplot without a parent main track', () => {
    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        id: 'orphan-subplot',
        role: 'subplot',
      }],
    }), sources())).toThrow(/支线|父轨道/u)
  })

  it('builds one bilingual structured task and stamps the derived snapshot', () => {
    const task = buildPlotTreeTask(sources())
    const result = derivePlotTreeSnapshot(JSON.stringify(modelResponse), sources(), NOW).snapshot

    expect(task).toMatchObject({
      purpose: 'plot-tree-snapshot',
      reasoningStage: 'planning',
      output: 'structured-data',
    })
    expect(task.messages[0]?.content).not.toMatch(/[㐀-鿿]/u)
    expect(result.generatedAt).toBe(NOW)
    expect(result.tracks).toEqual(modelResponse.tracks)
  })

  it('removes an incompatible blueprint citation from an occurred event', () => {
    const plotSources = sources()
    plotSources.writingLanguage = 'zh-CN'
    plotSources.narrativeThreads = []
    plotSources.blueprints = [1, 2, 3].map(chapterNumber => ({
      chapterNumber,
      title: `第${chapterNumber}章`,
      purpose: `推进第${chapterNumber}章`,
      keyEvents: `第${chapterNumber}章计划事件`,
    }))
    plotSources.finalizedChapters = [1, 2, 3].map(chapterNumber => ({
      draftId: 40 + chapterNumber,
      chapterNumber,
      title: `第${chapterNumber}章`,
      summary: `第${chapterNumber}章真实定稿摘要`,
    }))
    const mixed = {
      tracks: [{
        ...modelResponse.tracks[0],
        events: [{
          status: 'occurred',
          chapterNumber: 3,
          summary: '第三章事件已经发生。',
          sources: [
            { type: 'blueprint', chapterNumber: 3 },
            { type: 'finalized-chapter', draftId: 43, chapterNumber: 3 },
          ],
        }],
      }],
    }
    const result = derivePlotTreeSnapshot(JSON.stringify(mixed), plotSources, NOW).snapshot

    expect(result.tracks[0]).toMatchObject({
      startChapter: 3,
      endChapter: 3,
      events: [{
        status: 'occurred',
        sources: [{ type: 'finalized-chapter', draftId: 43, chapterNumber: 3 }],
      }],
    })
  })

  it('builds a deterministic snapshot from narrative sources after invalid JSON', () => {
    const threadSources = sources()
    threadSources.blueprints = []
    threadSources.finalizedChapters = []
    threadSources.narrativeThreads[0]!.targetEndChapter = 3
    threadSources.narrativeThreads[0]!.events[0]!.chapterNumber = 4
    const result = derivePlotTreeSnapshot('not JSON', threadSources, NOW).snapshot

    expect(result.tracks).toHaveLength(1)
    expect(result.tracks[0]?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'planned',
        sources: [{ type: 'narrative-thread', planId: 7 }],
      }),
      expect.objectContaining({
        status: 'occurred',
        chapterNumber: 4,
        sources: [{ type: 'narrative-thread', planId: 7, eventId: 11, chapterNumber: 4 }],
      }),
    ]))
    expect(result.tracks[0]?.endChapter).toBe(4)
  })

  it.each([150, 200])('includes every blueprint and finalized chapter for a %i-chapter project', (chapterCount) => {
    const oversized = sources()
    oversized.synopsis.content = 'S'.repeat(10_000)
    oversized.blueprints = Array.from({ length: chapterCount }, (_, index) => ({
      chapterNumber: index + 1,
      title: `Title ${index} ${'T'.repeat(500)}`,
      purpose: 'P'.repeat(1_000),
      keyEvents: 'K'.repeat(1_000),
    }))
    oversized.finalizedChapters = Array.from({ length: chapterCount }, (_, index) => ({
      draftId: 41 + index,
      chapterNumber: index + 1,
      title: `Final ${index} ${'T'.repeat(500)}`,
      summary: 'F'.repeat(1_000),
    }))
    oversized.narrativeThreads = Array.from({ length: 41 }, (_, index) => ({
      id: 7 + index,
      title: `Thread ${index} ${'T'.repeat(500)}`,
      type: `Type ${index} ${'Y'.repeat(500)}`,
      targetStartChapter: 1,
      targetEndChapter: 5,
      authorIntent: 'A'.repeat(1_000),
      status: 'planted' as const,
      events: Array.from({ length: 13 }, (_, eventIndex) => ({
        id: 11 + eventIndex,
        chapterNumber: 1,
        type: 'planted' as const,
        evidence: 'E'.repeat(1_000),
        reason: 'R'.repeat(1_000),
      })),
    }))
    const task = buildPlotTreeTask(oversized)

    const facts = JSON.parse(task.messages[1]?.content ?? '{}')
    expect(facts.synopsis).toHaveLength(3_000)
    expect(facts.blueprints).toHaveLength(chapterCount)
    expect(facts.finalizedChapters).toHaveLength(chapterCount)
    expect(facts.narrativeThreads).toHaveLength(41)
    expect(facts.narrativeThreads[0].events).toHaveLength(13)
    expect(facts.blueprints.at(-1).chapterNumber).toBe(chapterCount)
    expect(facts.finalizedChapters.at(-1).chapterNumber).toBe(chapterCount)
    expect(task?.messages[1]?.content.length).toBeLessThanOrEqual(PLOT_TREE_INPUT_MAX_CHARACTERS)
    expect(task.messages[1]?.content.length).toBeLessThanOrEqual(PLOT_TREE_INPUT_MAX_CHARACTERS)
    expect(facts.narrativeThreads[0].events.at(-1).id).toBe(23)
    expect(facts.blueprints[0]).toMatchObject({
      title: expect.stringMatching(/^Title 0/u),
      purpose: expect.stringMatching(/^P+…P+$/u),
      keyEvents: expect.stringMatching(/^K+…K+$/u),
    })
  })

  it('rejects sources beyond the complete-input ceiling before building a model task', () => {
    const oversized = sources()
    oversized.blueprints = Array.from({ length: 201 }, (_, index) => ({
      chapterNumber: index + 1,
      title: `Chapter ${index + 1}`,
      purpose: 'Advance the plot.',
      keyEvents: 'A sourced event occurs.',
    }))
    expect(thrownBy(() => buildPlotTreeTask(oversized))).toMatchObject({
      name: 'PlotTreeSourceLimitError',
      code: 'SOURCE_LIMIT_EXCEEDED',
    })
  })

  it('rejects complete source facts that exceed the explicit context budget before building a model task', () => {
    const oversized = sources()
    oversized.narrativeThreads = Array.from({ length: 1_000 }, (_, index) => ({
      id: index + 1,
      title: `Thread ${index + 1}`,
      type: 'subplot',
      targetStartChapter: 1,
      targetEndChapter: 1,
      authorIntent: 'A'.repeat(1_000),
      status: 'planned' as const,
      events: Array.from({ length: 5 }, (_, eventIndex) => ({
        id: eventIndex + 1,
        chapterNumber: 1,
        type: 'planted' as const,
        evidence: 'E'.repeat(1_000),
        reason: 'R'.repeat(1_000),
      })),
    }))
    expect(thrownBy(() => buildPlotTreeTask(oversized))).toMatchObject({
      name: 'PlotTreeInputLimitError',
      code: 'SOURCE_INPUT_TOO_LARGE',
      maximumCharacters: PLOT_TREE_INPUT_MAX_CHARACTERS,
    })
  })

  it.each([
    ['invalid_json', 'PRIVATE_MODEL_OUTPUT is not JSON'],
    ['invalid_contract', JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        events: [{
          status: 'planned',
          chapterNumber: 1,
          summary: 'PRIVATE_MODEL_OUTPUT',
          sources: [{ type: 'synopsis', chapterNumber: 1 }],
        }],
      }],
    })],
  ])('uses one source-backed fallback after %s', (_reason, content) => {
    const plotSources = sources()
    plotSources.writingLanguage = 'zh-CN'

    const task = buildPlotTreeTask(plotSources)
    const result = derivePlotTreeSnapshot(content, plotSources, NOW).snapshot

    expect(result.tracks).toHaveLength(1)
    expect(result.tracks[0]?.id).toBe('source-backed-progress')
    expect(task.purpose).toBe('plot-tree-snapshot')
    expect(task.messages.map(message => message.content).join('\n'))
      .toContain('绝不能输出 source.type="synopsis"')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MODEL_OUTPUT')
  })

  it('does not rebind a wrong source ID and falls back to exact source facts', () => {
    const content = JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        events: [{
          status: 'occurred',
          chapterNumber: 1,
          summary: 'PRIVATE_MODEL_OUTPUT',
          sources: [{ type: 'finalized-chapter', draftId: 999, chapterNumber: 1 }],
        }],
      }],
    })

    const result = derivePlotTreeSnapshot(content, sources(), NOW).snapshot

    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_MODEL_OUTPUT|999/u)
    expect(result.tracks[0]?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sources: [{ type: 'finalized-chapter', draftId: 41, chapterNumber: 1 }],
      }),
    ]))
  })
})
