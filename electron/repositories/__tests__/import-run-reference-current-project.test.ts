import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { BlueprintRepository, type BlueprintData, type BlueprintRangeCommitReceipt } from '../blueprint-repository'
import { CharacterProposalService } from '../../services/character-proposal-service'
import { proveCharacterProposal } from '../../services/generation-character-proposal-proof'
import { GenerationRunRepository } from '../generation-run-repository'
import { projectAccess } from '../../services/project-access'
import { ImportRunRepository } from '../import-run-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import {
  ImportRunOrchestrator,
  type ImportRunOrchestratorDependencies,
} from '../../../src/services/workflows/import-run-orchestrator'
import { importStagesFor, type ImportRunChapterSnapshot, type ImportRunPrepareRequest } from '../../../src/shared/import-run'
import type { ImportGlobalFactsRequest } from '../../../src/shared/import-global-facts'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

let root = ''
const RUN_ID = 'reference-into-project-run'

function chapter(number: number): ImportRunChapterSnapshot {
  const content = `参考小说第${number}章：雨夜，侦探推开旧宅的门。`
  return {
    number,
    title: `第${number}章`,
    content,
    contentFingerprint: createHash('sha256').update(content).digest('hex'),
    contentSize: Buffer.byteLength(content, 'utf8'),
  }
}

const CHAPTERS = [chapter(1), chapter(2), chapter(3)]

const INFERRED_CORE: ImportGlobalFactsRequest['core'] = {
  genre: '悬疑', subGenre: '本格', targetAudience: '成人', totalChapters: 3, wordsPerChapter: 2400,
  plotStructure: 'heros_journey', narrativePov: 'first_person', goldenFinger: '过目不忘', globalGuidance: '克制',
  coreOutline: '参考小说的大纲', worldSetting: '参考小说的民国', protagonistProfile: '参考主角',
  premise: '参考前提', worldbuilding: '参考世界观', synopsis: '参考情节大纲',
}
const INFERRED_STYLE = '参考小说的短句'

function inferredFacts(runId: string): ImportGlobalFactsRequest {
  return {
    operationId: `novel-import-global-${runId}`,
    expectedRosterRevision: 0,
    core: INFERRED_CORE,
    characterEntries: [{
      name: '参考主角', role: 'protagonist', gender: '男', age: '35', appearance: '', personality: '冷静',
      background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '',
    }],
  }
}

function inferredBlueprint(number: number): BlueprintData {
  return {
    chapterNumber: number, title: `参考蓝图${number}`, role: 'setup', purpose: `参考目的${number}`,
    keyEvents: `参考事件${number}`, characters: [], suspenseHook: `参考钩子${number}`,
    userGuidance: '', notes: '', notesUpdatedAt: '',
  }
}

function prepareReferenceRun(extra: Partial<ImportRunPrepareRequest> = {}): void {
  ImportRunRepository.prepare({
    runId: RUN_ID,
    purpose: 'reference',
    sourceFingerprint: 'e'.repeat(64),
    sourceDisplay: [{ displayName: '参考.txt', mediaType: 'text/plain', size: 256 }],
    locale: 'zh-CN',
    chapters: CHAPTERS,
    ...extra,
  })
}

function completeBlueprintCharacterSync(receipt: BlueprintRangeCommitReceipt): void {
  const db = getProjectDb()!, project = projectAccess.probeExistingProject(root)
  if (project.kind !== 'manifest') throw new Error('test project identity missing')
  new CharacterProposalService(db, project.projectId, (source, forWrite) => proveCharacterProposal(db,
    new GenerationRunRepository(() => db), project.projectId, source, forWrite, () => {}))
    .stage({ kind: 'directory', operationId: receipt.characterSyncOperation.operationId })
  BlueprintRepository.completeCharacterSyncOperation(receipt.characterSyncOperation.operationId)
}

interface Trace {
  blueprintCalls: number[][]
}

function dependencies(trace: Trace): ImportRunOrchestratorDependencies {
  return { interfaceLocale: shown('zh-CN'),
    getRun: async runId => ImportRunRepository.get(runId),
    startOrResume: async (runId, owner) => ImportRunRepository.startOrResume(runId, owner),
    renewExecution: async (runId, execution) => ImportRunRepository.renewExecution(runId, execution),
    getEffectReceipt: async (runId, stage, batchId) => ImportRunRepository.getEffectReceipt(runId, stage, batchId),
    prepareEffectReceipt: async (request, execution) => ImportRunRepository.prepareEffectReceipt(request, execution),
    commitEffectReceipt: async (runId, stage, batchId, execution) => (
      ImportRunRepository.commitEffectReceipt(runId, stage, batchId, execution)
    ),
    replayCommittedEffect: async receipt => {
      if (receipt.kind === 'chapter-blueprint-range') {
        completeBlueprintCharacterSync(receipt.effectReceipt as BlueprintRangeCommitReceipt)
      }
    },
    listChapters: async (runId, afterChapterNumber, limit) => (
      ImportRunRepository.listChapterBatch(runId, { afterChapterNumber, limit })
    ),
    importReference: async (item, run, authority) => {
      const binding = ImportRunRepository.resolveReferenceImportAuthority(run.id, authority, item.number)
      const documentId = createHash('sha256').update(`reference-import:${binding.stableKey}`).digest('hex')
      getProjectDb()!.prepare(`
        INSERT INTO import_reference_documents (
          document_id, idempotency_key_hash, content_hash, chunk_set_hash,
          expected_chunk_count, corpus_kind, state
        ) VALUES (?, ?, ?, ?, 1, 'reference', 'committed')
      `).run(
        documentId,
        createHash('sha256').update(binding.stableKey).digest('hex'),
        binding.contentFingerprint,
        createHash('sha256').update(`chunks:${item.number}`).digest('hex'),
      )
      ImportRunRepository.commitReferenceImportReceipt(run.id, authority, item.number, documentId)
    },
    inferGlobal: async (_chapters, _stats, run, commit) => { await commit(inferredFacts(run.id)) },
    analyzeStyle: async (_chapters, _run, commit) => { await commit({ writingStyle: INFERRED_STYLE }) },
    inferBlueprints: async (chapters, _checkpoint, run, commit) => {
      trace.blueprintCalls.push(chapters.map(item => item.number))
      const receipt = await commit({
        mode: 'replace-range',
        operationId: `import-blueprints-${run.id}-${chapters[0]!.number}-${chapters.at(-1)!.number}`,
        startChapter: chapters[0]!.number,
        endChapter: chapters.at(-1)!.number,
        blueprints: chapters.map(item => inferredBlueprint(item.number)),
      }) as BlueprintRangeCommitReceipt
      completeBlueprintCharacterSync(receipt)
    },
    listBlueprintChapterNumbers: async () => new Set(BlueprintRepository.getAll().map(item => item.chapterNumber)),
    isAuthorDraftReplaced: async () => false,
    refresh: async () => undefined,
    completeBatch: async (runId, stage, batchId, execution) => (
      ImportRunRepository.completeBatch(runId, stage, batchId, execution)
    ),
    advanceStage: async (runId, completedStage, nextStage, execution) => (
      ImportRunRepository.advanceStage(runId, completedStage, nextStage, execution)
    ),
    fail: async (runId, stage, error, execution) => ImportRunRepository.fail(runId, stage, error, execution),
    cancelAtBoundary: async (runId, execution) => ImportRunRepository.cancelAtBoundary(runId, execution),
    complete: async (runId, execution) => ImportRunRepository.complete(runId, execution),
  }
}

const callbacks = () => ({ log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })

async function runRemainingStages(trace: Trace, runId = RUN_ID): Promise<void> {
  const orchestrator = new ImportRunOrchestrator(dependencies(trace))
  const run = ImportRunRepository.get(runId)!
  const plan = importStagesFor(run)
  for (const stage of plan.slice(plan.indexOf(run.stage))) {
    if (stage === 'completed') break
    await orchestrator.executeStage(runId, stage, 'renderer', { cancelled: false }, callbacks())
  }
}

const AUTHOR_FILLED = {
  genre: '武侠', coreOutline: '作者自己的大纲', worldSetting: '作者的江湖', premise: '作者的前提',
  synopsis: '作者的情节大纲', writingStyle: '作者的长句风格',
}
const AUTHOR_BLUEPRINT: BlueprintData = {
  ...inferredBlueprint(2), title: '作者写的第2章蓝图', purpose: '作者的目的', keyEvents: '作者的事件', userGuidance: '作者的微操',
}

function authorCore() {
  const core = ProjectCoreRepository.get()!
  return Object.fromEntries(Object.keys(AUTHOR_FILLED).map(key => [key, core[key as keyof typeof core]]))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-reference-into-project-'))
  initProjectDatabase(root)
  if (!ProjectCoreRepository.get()) ProjectCoreRepository.init('作者已有项目')
})

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('参考小说导入已有设定的当前项目', () => {
  it('已填字段逐字不变，空字段补上，不同的反推值进导入建议', async () => {
    ProjectCoreRepository.update(AUTHOR_FILLED)
    prepareReferenceRun()

    await runRemainingStages({ blueprintCalls: [] })

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(authorCore()).toEqual(AUTHOR_FILLED)
    expect(ProjectCoreRepository.get()).toMatchObject({
      subGenre: '本格', targetAudience: '成人', goldenFinger: '过目不忘', globalGuidance: '克制',
      protagonistProfile: '参考主角', worldbuilding: '参考世界观',
    })
    const suggestions = (['global', 'style'] as const).flatMap(stage => (
      ImportRunRepository.getEffectReceipt(RUN_ID, stage, 'done')?.effectReceipt as { suggestions?: unknown[] } | undefined
    )?.suggestions ?? [])
    expect(suggestions).toEqual(expect.arrayContaining([
      { field: 'genre', current: '武侠', inferred: '悬疑' },
      { field: 'coreOutline', current: '作者自己的大纲', inferred: '参考小说的大纲' },
      { field: 'worldSetting', current: '作者的江湖', inferred: '参考小说的民国' },
      { field: 'premise', current: '作者的前提', inferred: '参考前提' },
      { field: 'synopsis', current: '作者的情节大纲', inferred: '参考情节大纲' },
      { field: 'writingStyle', current: '作者的长句风格', inferred: INFERRED_STYLE },
    ]))
  })

  it('章节蓝图：已有蓝图的章不变也不调模型，没有蓝图的章写入反推蓝图', async () => {
    BlueprintRepository.upsert(AUTHOR_BLUEPRINT)
    prepareReferenceRun()
    const trace: Trace = { blueprintCalls: [] }

    await runRemainingStages(trace)

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(trace.blueprintCalls).toEqual([[1], [3]])
    expect(BlueprintRepository.getByChapter(2)).toMatchObject({
      title: '作者写的第2章蓝图', purpose: '作者的目的', keyEvents: '作者的事件', userGuidance: '作者的微操',
    })
    expect(BlueprintRepository.getAll().map(item => item.title)).toEqual(['参考蓝图1', '作者写的第2章蓝图', '参考蓝图3'])
  })

  it('每章都已有蓝图时不调模型，蓝图阶段照样走完', async () => {
    for (const number of [1, 2, 3]) BlueprintRepository.upsert({ ...AUTHOR_BLUEPRINT, chapterNumber: number })
    prepareReferenceRun()
    const trace: Trace = { blueprintCalls: [] }

    await runRemainingStages(trace)

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(trace.blueprintCalls).toEqual([])
    expect(BlueprintRepository.getAll().map(item => item.title)).toEqual(Array(3).fill('作者写的第2章蓝图'))
  })
})

describe('升级前进行到一半的参考导入', () => {
  it('没有冻结写入模式的运行续跑时只补空白', async () => {
    ProjectCoreRepository.update(AUTHOR_FILLED)
    BlueprintRepository.upsert(AUTHOR_BLUEPRINT)
    prepareReferenceRun()
    const { execution } = ImportRunRepository.startOrResume(RUN_ID, 'renderer-before-upgrade')
    getProjectDb()!.prepare("UPDATE import_runs SET stage = 'global' WHERE id = ?").run(RUN_ID)
    ImportRunRepository.prepareEffectReceipt({
      runId: RUN_ID, stage: 'global', batchId: 'done', effectKey: 'global-facts',
      kind: 'project-global-facts', payload: inferredFacts(RUN_ID),
    }, execution)
    getProjectDb()!.prepare("UPDATE import_runs SET status = 'failed', lease_expires_at = 0 WHERE id = ?").run(RUN_ID)

    await runRemainingStages({ blueprintCalls: [] })

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(authorCore()).toEqual(AUTHOR_FILLED)
    expect(BlueprintRepository.getByChapter(2)).toMatchObject({ title: '作者写的第2章蓝图', keyEvents: '作者的事件' })
  })
})

describe('参考小说导入对话框新建的项目', () => {
  const AUTHOR_EDITS = { genre: '武侠', totalChapters: 40, writingStyle: '作者的长句风格' }
  const FILLED_AROUND_EDITS = {
    subGenre: '本格', targetAudience: '成人', wordsPerChapter: 2400, plotStructure: 'heros_journey',
    narrativePov: 'first_person', coreOutline: '参考小说的大纲', premise: '参考前提',
  }

  function failBeforeGlobal(): void {
    prepareReferenceRun({ coreWriteMode: 'replace' })
    const { execution } = ImportRunRepository.startOrResume(RUN_ID, 'first-try')
    ImportRunRepository.fail(RUN_ID, 'knowledge', 'provider unavailable', execution)
  }

  it('首次导入：默认值和空白字段都换成反推值，每章写入反推蓝图', async () => {
    prepareReferenceRun({ coreWriteMode: 'replace' })
    const trace: Trace = { blueprintCalls: [] }

    await runRemainingStages(trace)

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(ProjectCoreRepository.get()).toMatchObject({ ...INFERRED_CORE, writingStyle: INFERRED_STYLE })
    expect(trace.blueprintCalls).toEqual([[1, 2, 3]])
    expect(BlueprintRepository.getAll().map(item => item.title)).toEqual(['参考蓝图1', '参考蓝图2', '参考蓝图3'])
  })

  it('失败后作者改了设定再继续导入：改过的字段不变，空白和默认值补上', async () => {
    failBeforeGlobal()
    ProjectCoreRepository.update(AUTHOR_EDITS)

    await runRemainingStages({ blueprintCalls: [] })

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(ProjectCoreRepository.get()).toMatchObject({ ...AUTHOR_EDITS, ...FILLED_AROUND_EDITS })
  })

  it('失败后作者改了设定再重新开始：改过的字段不变，空白和默认值补上', async () => {
    failBeforeGlobal()
    ProjectCoreRepository.update(AUTHOR_EDITS)

    ImportRunRepository.restart(RUN_ID, 'restarted-run')
    await runRemainingStages({ blueprintCalls: [] }, 'restarted-run')

    expect(ImportRunRepository.get('restarted-run')).toMatchObject({ status: 'completed' })
    expect(ProjectCoreRepository.get()).toMatchObject({ ...AUTHOR_EDITS, ...FILLED_AROUND_EDITS })
  })
})

describe('对话框新建项目的导入失败后，作者改了设定再按当前项目导入同一本', () => {
  const SOURCE_ID = '44444444-4444-4444-8444-444444444444'
  const parsedChapters = CHAPTERS.map(item => {
    const content = `参考正文${item.number}`
    return { number: item.number, title: item.title, content,
      contentFingerprint: createHash('sha256').update(content).digest('hex'), contentSize: Buffer.byteLength(content) }
  })
  function selectSource(runId: string, coreWriteMode: 'replace' | 'fill-empty') {
    ImportRunRepository.beginParsing({
      runId, purpose: 'reference', sourceFingerprint: 'f'.repeat(64), sourceIds: [SOURCE_ID],
      sourceFingerprints: ['9'.repeat(64)], sourceDisplay: [{ displayName: '参考.txt', mediaType: 'text/plain', size: 256 }],
      locale: 'zh-CN', coreWriteMode,
    })
  }

  it('复用旧运行时只补空白，作者已填的设定和蓝图逐字不变', async () => {
    selectSource(RUN_ID, 'replace')
    ImportRunRepository.commitParsedSource(RUN_ID, SOURCE_ID, parsedChapters)
    ImportRunRepository.finalizeParsing(RUN_ID)
    const { execution } = ImportRunRepository.startOrResume(RUN_ID, 'first-try')
    ImportRunRepository.fail(RUN_ID, 'knowledge', 'provider unavailable', execution)
    ProjectCoreRepository.update(AUTHOR_FILLED)
    BlueprintRepository.upsert(AUTHOR_BLUEPRINT)

    selectSource('second-selection', 'fill-empty')
    ImportRunRepository.commitParsedSource('second-selection', SOURCE_ID, parsedChapters)
    expect(ImportRunRepository.finalizeParsing('second-selection')).toMatchObject({
      classification: 'resumable', run: { id: RUN_ID, coreWriteMode: 'fill-empty' },
    })
    await runRemainingStages({ blueprintCalls: [] })

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(authorCore()).toEqual(AUTHOR_FILLED)
    expect(BlueprintRepository.getByChapter(2)).toMatchObject({ title: '作者写的第2章蓝图', userGuidance: '作者的微操' })
  })

  it('解析到一半的旧运行被当前项目复用时也只补空白', () => {
    selectSource(RUN_ID, 'replace')
    selectSource('second-selection', 'fill-empty')

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ coreWriteMode: 'fill-empty' })
  })

  it('只补空白的运行被新项目请求复用时不改成整体写入', () => {
    selectSource(RUN_ID, 'fill-empty')
    selectSource('second-selection', 'replace')

    expect(ImportRunRepository.get(RUN_ID)).toMatchObject({ coreWriteMode: 'fill-empty' })
  })
})
