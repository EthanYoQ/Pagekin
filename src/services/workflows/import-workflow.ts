/** Persisted, resumable reference-import workflow. */
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  assertImportRunEffectReceiptMetadata,
  type ImportRunChapterSnapshot,
  type ImportRunSnapshot,
  type ImportRunStage,
  type ImportRunExecutionLease,
} from '../../shared/import-run'
import type { ImportGlobalFactsReceipt } from '../../shared/import-global-facts'
import type { BlueprintRangeCommitReceipt } from '../../../electron/repositories/blueprint-repository'
import type { FinalizedDraftImportReceipt } from '../../shared/finalized-draft-import'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import { useProjectStore } from '../../stores/project-store'
import { currentInterfaceLocale } from '../../stores/locale-store'
import { workflowResourceKey, type StepCallbacks, type WorkflowContext, type WorkflowDefinition, type WorkflowStep } from '../../stores/workflow-store'
import {
  IMPORT_CHAPTER_PAGE_SIZE,
  ImportRunOrchestrator,
  importRecordError,
  type ImportRunOrchestratorDependencies,
} from './import-run-orchestrator'
import { configFieldsFromCore } from './import-suggestions'
import { promptLanguageText } from '../prompt-language'
import { retryDirectoryCharacterSync } from './directory-character-sync-recovery'
import type { WritingLanguage } from '../../shared/writing-language'
import { countDraftUnits } from '../../shared/draft-units'
import { note, type AuthorNote, type Failure } from '../../shared/failure'
import { authorError, catalogNote, isRegisteredErrorCode, resultFailure } from '../../i18n/app-errors'
import { errorLocaleForRun } from '../../i18n/core'
import { FINALIZATION_SHARED_WRITE_RESOURCE_KINDS } from '../../shared/workflow-resource-claims'

export interface ImportWorkflowParams {
  projectPath: string
  projectSession: ProjectSessionContext
  run: ImportRunSnapshot
  /** One frozen renderer execution identity for every step in this workflow. */
  executionOwner: string
  /** Durable manifest chapter numbers; required for author-manuscript writes. */
  authorChapterNumbers?: readonly number[]
}

function textForLocale(locale: ImportRunSnapshot['locale'], zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : zhCNText
}

function incompleteAuthorManifestError(run: ImportRunSnapshot): Error {
  return authorError(errorLocaleForRun(run.locale, currentInterfaceLocale()), { note: note(
    '作者原稿的持久化章节清单不完整，无法安全启动导入。',
    'The persisted author-manuscript chapter manifest is incomplete, so the import cannot start safely.',
  ) })
}

function normalizeAuthorChapterNumbers(
  run: ImportRunSnapshot,
  values: readonly number[] | undefined,
): readonly number[] {
  const chapterNumbers = [...new Set(values ?? [])].sort((left, right) => left - right)
  if (
    chapterNumbers.length !== run.totalChapters
    || chapterNumbers.some(number => !Number.isSafeInteger(number) || number < 1)
  ) {
    throw incompleteAuthorManifestError(run)
  }
  return Object.freeze(chapterNumbers)
}

export async function loadAuthorImportChapterNumbers(
  run: ImportRunSnapshot,
  projectSession: ProjectSessionContext,
  projectPath: string,
): Promise<readonly number[]> {
  const chapterNumbers: number[] = []
  let afterChapterNumber = 0
  let hasMore = true
  while (hasMore) {
    const page = await ipc.invokeWithProjectSession(
      projectSession,
      'db:import-run-list-chapters',
      run.id,
      afterChapterNumber,
      IMPORT_CHAPTER_PAGE_SIZE,
      projectPath,
    )
    if (page.length === 0) {
      hasMore = false
      continue
    }
    chapterNumbers.push(...page.map(chapter => chapter.number))
    const nextAfterChapterNumber = page[page.length - 1]!.number
    if (nextAfterChapterNumber <= afterChapterNumber) throw incompleteAuthorManifestError(run)
    afterChapterNumber = nextAfterChapterNumber
  }
  return normalizeAuthorChapterNumbers(run, chapterNumbers)
}

function importedChapter(chapter: ImportRunChapterSnapshot) {
  return {
    number: chapter.number,
    title: chapter.title,
    content: chapter.content,
    wordCount: countDraftUnits(chapter.content),
  }
}

function currentNovelConfigSummary(writingLanguage: WritingLanguage): string {
  const config = useProjectStore.getState().currentProject?.novelConfig
  if (!config) return promptLanguageText(
    writingLanguage, '（配置概要不可用）', '(configuration summary unavailable)',
  )
  const none = promptLanguageText(writingLanguage, '（无）', '(none)')
  return promptLanguageText(
    writingLanguage,
    `类型: ${config.genre || none}\n大纲: ${config.coreOutline || none}\n世界观: ${config.worldSetting || none}\n主角: ${config.protagonistProfile || none}`,
    `Genre: ${config.genre || none}\nOutline: ${config.coreOutline || none}\nWorld: ${config.worldSetting || none}\nProtagonist: ${config.protagonistProfile || none}`,
  )
}

function productionDependencies(
  context: WorkflowContext,
  callbacks: StepCallbacks,
): ImportRunOrchestratorDependencies {
  const session = context.projectSession
  const projectPath = context.projectPath
  // 兜底说明按导入运行的语言写，不跟随当前界面语言（interfaceLocale 随 run.locale）。
  const required = <T extends { success: boolean; failure?: Failure }>(result: T, fallback: AuthorNote): T => {
    if (!result.success) throw authorError(context.interfaceLocale, resultFailure(result) ?? { note: fallback })
    return result
  }
  return {
    interfaceLocale: context.interfaceLocale,
    getRun: runId => ipc.invokeWithProjectSession(session, 'db:import-run-get', runId, projectPath),
    startOrResume: async (runId, owner) => {
      const start = required(
        await ipc.invokeWithProjectSession(session, 'db:import-run-start-resume', runId, owner, projectPath),
        note('无法开始或继续这次导入。', 'Could not start or resume the import run.'),
      ).start!
      context.data.importRunExecution = start.execution
      return start
    },
    renewExecution: async (runId, execution) => {
      const renewed = required(
        await ipc.invokeWithProjectSession(
          session, 'db:import-run-renew-execution', runId, execution, projectPath,
        ),
        note('无法延长这次导入的写入时限。', 'Could not renew the import execution lease.'),
      ).execution!
      context.data.importRunExecution = renewed
      return renewed
    },
    getEffectReceipt: (runId, stage, checkpoint) => ipc.invokeWithProjectSession(
      session,
      'db:import-run-effect-receipt-get',
      runId,
      stage,
      checkpoint,
      projectPath,
    ),
    prepareEffectReceipt: async (request, execution) => required(
      await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-prepare',
        request,
        execution,
        projectPath,
      ),
      catalogNote('error.importOutputFreezeFailed'),
    ).receipt!,
    commitEffectReceipt: async (runId, stage, checkpoint, execution) => required(
      await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-commit',
        runId,
        stage,
        checkpoint,
        execution,
        projectPath,
      ),
      catalogNote('error.importOutputCommitFailed'),
    ).result!,
    replayCommittedEffect: async (receipt, run) => {
      // Re-read through the main-process repository so replay receives the
      // same canonical rehash and schema checks as get/commit, then reject any
      // renderer-side object that differs from that durable receipt.
      const durableReceipt = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-get',
        run.id,
        receipt.stage,
        receipt.batchId,
        projectPath,
      )
      if (!durableReceipt || JSON.stringify(durableReceipt) !== JSON.stringify(receipt)) {
        throw importRecordError(
          context.interfaceLocale,
          'error.importRecordReceiptMismatch',
        )
      }
      assertImportRunEffectReceiptMetadata(durableReceipt, run)
      if (durableReceipt.state !== 'committed') {
        throw importRecordError(context.interfaceLocale, 'error.importRecordNotCommitted')
      }
      if (durableReceipt.kind === 'chapter-blueprint-range') {
        const committed = durableReceipt.effectReceipt as BlueprintRangeCommitReceipt | undefined
        if (!committed?.characterSyncOperation?.operationId) {
          throw importRecordError(context.interfaceLocale, 'error.importRecordBlueprintIncomplete')
        }
        await retryDirectoryCharacterSync(
          committed.characterSyncOperation.operationId,
          projectPath,
          session,
          context.interfaceLocale,
        )
        return
      }
      if (durableReceipt.kind === 'author-finalized-batch') {
        const authorReceipt = durableReceipt.effectReceipt as FinalizedDraftImportReceipt | undefined
        if (
          !authorReceipt
          || authorReceipt.operationId !== `author-import:${run.id}`
          || authorReceipt.drafts.length !== run.totalChapters
        ) throw importRecordError(context.interfaceLocale, 'error.importRecordAuthorIncomplete')
        return
      }
      const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath)
      const current = useProjectStore.getState().currentProject
      if (!core || !current || !sameProjectSessionContext(
        session,
        projectSessionContextFromProject(current),
      )) {
        throw authorError(context.interfaceLocale, { note: catalogNote('error.importProjectChangedBeforeRestore') })
      }
      useProjectStore.getState().publishSavedNovelConfig(configFieldsFromCore(core), session, 'unsaved-edits')
      context.data.novelConfigSummary = currentNovelConfigSummary(context.writingLanguage)
    },
    listChapters: (runId, after, limit) => ipc.invokeWithProjectSession(
      session, 'db:import-run-list-chapters', runId, after, limit, projectPath,
    ),
    importReference: async (chapter, run, executionAuthority) => {
      const result = await ipc.invokeWithProjectSession(
        session,
        'kb:import-reference-text',
        chapter.number,
        run.id,
        executionAuthority,
      )
      // 取消判定只凭这个码，必须带上。
      if (!result.success) {
        const failure = resultFailure(result)
        const chapterNote = catalogNote('error.importReferenceChapterNotWritten', { number: chapter.number })
        const explained = failure && (failure.note || isRegisteredErrorCode(failure.code))
        throw authorError(errorLocaleForRun(run.locale, context.interfaceLocale), explained ? failure
          : failure?.code ? { code: failure.code, note: chapterNote } : { note: chapterNote })
      }
      callbacks.log(textForLocale(
        run.locale,
        `参照章节 ${chapter.number} 已进入知识库${result.idempotent ? '（已存在）' : ''}`,
        `Reference Chapter ${chapter.number} is in the knowledge base${result.idempotent ? ' (already present)' : ''}.`,
      ))
    },
    inferGlobal: async (chapters, stats, run, commit) => {
      context.data.importGenerationSlot = { runId: run.id, stage: 'global', batchId: 'done' }
      context.data.importRunPurpose = run.purpose
      context.data.chapters = chapters.map(importedChapter)
      context.data.importRunTotalChapters = stats.totalChapters
      context.data.importRunTotalWords = stats.totalWords
      const { InferGlobalSettingsCommand } = await import('./commands/import-novel.command')
      await new InferGlobalSettingsCommand(undefined, async request => (
        await commit(request)
      ) as ImportGlobalFactsReceipt, run.purpose === 'author-manuscript').execute({ step: {} as never, context, callbacks })
    },
    analyzeStyle: async (chapters, run, commit) => {
      context.data.importGenerationSlot = { runId: run.id, stage: 'style', batchId: 'done' }
      context.data.importRunPurpose = run.purpose
      const { AnalyzeWritingStyleCommand } = await import('./commands/analyze-style.command')
      const style = await new AnalyzeWritingStyleCommand(
        { chapters: chapters.map(importedChapter), fillEmpty: true },
        undefined,
        async (writingStyle, generationRunHandle) => {
          const saved = await commit({ writingStyle, ...(generationRunHandle ? { generationRunHandle } : {}) }) as { writingStyle: string }
          return saved.writingStyle
        },
      )
        .execute({ step: {} as never, context, callbacks })
      if (!style.trim()) throw authorError(context.interfaceLocale, { note: catalogNote('error.importStyleEmpty') })
    },
    inferBlueprints: async (chapters, checkpoint, run, commit) => {
      context.data.importGenerationSlot = { runId: run.id, stage: 'blueprints', batchId: checkpoint }
      context.data.importRunPurpose = run.purpose
      context.data.chapters = chapters.map(importedChapter)
      context.data.novelConfigSummary = currentNovelConfigSummary(context.writingLanguage)
      const { InferBlueprintsPerChapterCommand } = await import('./commands/import-novel.command')
      await new InferBlueprintsPerChapterCommand(undefined, async request => (
        await commit(request)
      ) as BlueprintRangeCommitReceipt).execute({ step: {} as never, context, callbacks })
    },
    listBlueprintChapterNumbers: async () => new Set(
      (await ipc.invokeWithProjectSession(session, 'db:blueprint-get-all', projectPath))
        .map(blueprint => blueprint.chapterNumber),
    ),
    commitAuthorManuscript: async (run, commit) => {
      if (!run.authorityFingerprint || !run.manifestFingerprint) {
        throw authorError(context.interfaceLocale, { note: catalogNote('error.importAuthorAuthorityMissing') })
      }
      await commit({
        operationId: `author-import:${run.id}`,
        runId: run.id,
        authorityFingerprint: run.authorityFingerprint,
        manifestFingerprint: run.manifestFingerprint,
      })
    },
    getAuthorCommitReceipt: async runId => {
      const receipt = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-get',
        runId,
        'author-commit',
        'done',
        projectPath,
      )
      if (!receipt) return null
      if (receipt.state !== 'committed' || receipt.kind !== 'author-finalized-batch') {
        throw importRecordError(
          context.interfaceLocale,
          'error.importRecordAuthorFinalizationPending',
        )
      }
      return receipt.effectReceipt as FinalizedDraftImportReceipt
    },
    isAuthorDraftReplaced: async draft => {
      const meta = await ipc.invokeWithProjectSession(session, 'db:draft-get-meta', draft.draftId, projectPath)
      return meta?.status === 'superseded'
    },
    publishAuthorChapter: async (chapter, draft, run) => {
      const { finalizationFailure, retryFinalizationPublication } = await import('../finalization-client')
      const result = await retryFinalizationPublication(draft.finalizationId, session)
      if (!result.success || result.publicationStatus !== 'published') {
        throw authorError(context.interfaceLocale, finalizationFailure(result) ?? { note: catalogNote('error.importAuthorChapterPublishFailed', { number: chapter.number }) })
      }
      callbacks.log(textForLocale(
        run.locale,
        `第 ${chapter.number} 章实体正文已发布`,
        `Chapter ${chapter.number} was published to the manuscript directory.`,
      ))
    },
    postprocessAuthorChapter: async (chapter, draft, run) => {
      const current = useProjectStore.getState().currentProject
      if (!current || !sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
        throw authorError(context.interfaceLocale, { note: catalogNote('error.importProjectChangedBeforeContinuity') })
      }
      const { RunFinalizePostProcessCommand } = await import('./commands/finalize-chapter.command')
      const status = await new RunFinalizePostProcessCommand({
        project: current,
        chapterNumber: chapter.number,
        chapterTitle: chapter.title,
        draftContent: chapter.content,
        draftId: draft.draftId,
        finalizedSource: {
          draftId: draft.draftId,
          finalizationId: draft.finalizationId,
          chapterNumber: chapter.number,
          contentHash: draft.contentHash,
        },
        sourceLabel: textForLocale(
          run.locale,
          `第${chapter.number}章作者原稿定稿`,
          `Author manuscript Chapter ${chapter.number} finalization`,
        ),
        stopOnFailure: true,
        onlyFailed: true,
        onStepStart: label => callbacks.setActivityText?.(textForLocale(
          run.locale, `第 ${chapter.number} 章 · ${label}`, `Chapter ${chapter.number} · ${label}`,
        )),
      }).execute({ step: {} as never, context, callbacks })
      if (!status.allCriticalPassed) {
        throw authorError(context.interfaceLocale, { note: catalogNote('error.importContinuityIncomplete', { number: chapter.number }) })
      }
    },
    refresh: async run => {
      callbacks.log(textForLocale(run.locale, '正在刷新项目数据...', 'Refreshing project data...'))
      const [{ useCharacterStore }, { useDraftStore }] = await Promise.all([
        import('../../stores/character-store'),
        import('../../stores/draft-store'),
      ])
      await useCharacterStore.getState().loadCharacters(projectPath, session)
      await useDraftStore.getState().loadAllDrafts(projectPath, session)
    },
    completeBatch: async (runId, stage, checkpoint, execution) => {
      const result = required(
        await ipc.invokeWithProjectSession(
          session, 'db:import-run-complete-batch', runId, stage, checkpoint, execution, projectPath,
        ),
        catalogNote('error.importCheckpointSaveFailed'),
      )
      return { cancelApplied: result.cancelApplied ?? false, run: result.run! }
    },
    advanceStage: async (runId, completedStage, nextStage, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-advance-stage', runId, completedStage, nextStage, execution, projectPath,
      ),
      catalogNote('error.importCheckpointAdvanceFailed'),
    ).run!,
    fail: async (runId, stage, failure, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-fail', runId, stage, failure, execution, projectPath,
      ),
      catalogNote('error.importFailureRecordSaveFailed'),
    ).run!,
    cancelAtBoundary: async (runId, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-cancel-at-boundary', runId, execution, projectPath,
      ),
      note('无法保存导入取消状态。', 'Could not save import cancellation.'),
    ).run!,
    complete: async (runId, execution) => required(
      await ipc.invokeWithProjectSession(session, 'db:import-run-complete', runId, execution, projectPath),
      catalogNote('error.importRunCompleteFailed'),
    ).run!,
  }
}

function importStep(
  run: ImportRunSnapshot,
  executionOwner: string,
  stage: Exclude<ImportRunStage, 'completed'>,
  name: [string, string],
  description: [string, string],
) {
  return {
    name: textForLocale(run.locale, ...name),
    description: textForLocale(run.locale, ...description),
    executor: async (_step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
      await new ImportRunOrchestrator(productionDependencies(context, callbacks))
        .executeStage(run.id, stage, executionOwner, context, callbacks)
    },
  }
}

export function createImportWorkflow(params: ImportWorkflowParams): WorkflowDefinition {
  const project = useProjectStore.getState().currentProject
  if (!project || !sameProjectSessionContext(params.projectSession, projectSessionContextFromProject(project))) {
    throw authorError(errorLocaleForRun(params.run.locale, currentInterfaceLocale()), { note: note(
      '当前项目已切换，无法启动导入工作流',
      'The project changed, so the import workflow cannot start.',
    ) })
  }
  const session = Object.freeze({ ...params.projectSession })
  const count = params.run.totalChapters
  const chapterCountEn = `${count} ${count === 1 ? 'chapter' : 'chapters'}`
  const contextReadResourceKeys = [
    workflowResourceKey('novel-config'),
    workflowResourceKey('architecture'),
    workflowResourceKey('blueprints'),
  ]
  const durableCancelHooks: Pick<WorkflowDefinition, 'onCancelRequested'> = {
    onCancelRequested: async context => {
      const execution = context.data.importRunExecution as ImportRunExecutionLease | undefined
      if (!execution) return
      const result = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-request-cancel',
        params.run.id,
        execution,
        params.projectPath,
      )
      if (!result.success) throw authorError(context.interfaceLocale, resultFailure(result) ?? { note: note('无法保存导入取消请求', 'Could not persist the import cancellation request.') })
    },
  }
  const fillEmptyInferenceSteps = [
    importStep(params.run, params.executionOwner, 'global',
      ['反推设定、架构与角色', 'Infer settings, architecture, and characters'],
      ['只补空白的设定与架构，已有内容不动；不同的反推结果留作建议，角色以提议保存', 'Fill only empty settings and architecture; differing results become suggestions and characters become proposals.']),
    importStep(params.run, params.executionOwner, 'style',
      ['反推文风', 'Infer writing style'],
      ['文风为空才写入，已有文风留作建议', 'Write the style only when it is empty; otherwise keep it as a suggestion.']),
    importStep(params.run, params.executionOwner, 'blueprints',
      ['为没有蓝图的章反推蓝图', 'Infer blueprints for chapters without one'],
      ['已有蓝图的章不调用模型、不改动', 'Chapters that already have a blueprint are left untouched.']),
  ]
  if (params.run.purpose === 'author-manuscript') {
    const authorChapterNumbers = normalizeAuthorChapterNumbers(
      params.run,
      params.authorChapterNumbers,
    )
    const inference = params.run.authorInference === true
    const inferenceSteps = inference ? fillEmptyInferenceSteps : []
    return {
      runId: params.run.id,
      type: 'novel_import',
      title: textForLocale(
        params.run.locale,
        `导入作者原稿（${count} 章）`,
        `Import author manuscript (${chapterCountEn})`,
      ),
      projectPath: params.projectPath,
      projectSession: session,
      uiLocale: params.run.locale,
      resourceKeys: [
        ...authorChapterNumbers.map(chapterNumber => workflowResourceKey('chapter', chapterNumber)),
        ...FINALIZATION_SHARED_WRITE_RESOURCE_KINDS.map(kind => workflowResourceKey(kind)),
        ...(inference ? contextReadResourceKeys : []),
      ],
      readResourceKeys: inference ? [] : contextReadResourceKeys,
      ...durableCancelHooks,
      steps: [
        importStep(params.run, params.executionOwner, 'author-commit',
          ['提交权威定稿快照', 'Commit authoritative finalized snapshots'],
          ['以单个 SQLite 事务提交不可变定稿与发布 outbox', 'Atomically commit immutable finalized snapshots and publication outbox records.']),
        importStep(params.run, params.executionOwner, 'author-publish',
          ['发布实体正文', 'Publish manuscript files'],
          ['按持久检查点发布正文文件；失败后可安全重试', 'Publish manuscript files with durable checkpoints and safe retries.']),
        importStep(params.run, params.executionOwner, 'author-postprocess',
          ['更新连续性事实', 'Update continuity facts'],
          ['从权威定稿更新章节事实与角色状态，不导入参照语料', 'Update chapter facts and character state from authoritative text without importing reference prose.']),
        ...inferenceSteps,
        importStep(params.run, params.executionOwner, 'refresh',
          ['刷新项目状态', 'Refresh project state'],
          ['刷新正文树、角色卡与定稿状态', 'Refresh the manuscript tree, character cards, and finalized status.']),
      ],
      onComplete: {
        mode: 'silent',
        message: textForLocale(
          params.run.locale,
          '作者原稿已作为权威定稿导入，可以从下一章继续创作。',
          'The manuscript is now authoritative finalized text. You can continue from the next chapter.',
        ),
      },
    }
  }
  return {
    runId: params.run.id,
    type: 'novel_import',
    title: textForLocale(
      params.run.locale,
      `小说拆解与仿写（${count} 章）`,
      `Novel analysis and style study (${chapterCountEn})`,
    ),
    projectPath: params.projectPath,
    projectSession: session,
    uiLocale: params.run.locale,
    resourceKeys: [
      workflowResourceKey('novel-config'),
      workflowResourceKey('architecture'),
      workflowResourceKey('character-roster'),
      workflowResourceKey('blueprints'),
    ],
    ...durableCancelHooks,
    steps: [
      importStep(params.run, params.executionOwner, 'knowledge',
        ['导入参照文本与构建知识库', 'Import reference text and build the knowledge base'],
        [`按有界批次导入 ${count} 章参照文本，不写入草稿或正文`, `Import ${chapterCountEn} of reference text in bounded batches without creating drafts or manuscript text`]),
      ...fillEmptyInferenceSteps,
      importStep(params.run, params.executionOwner, 'refresh',
        ['刷新项目状态', 'Refresh project state'],
        ['刷新项目树、角色卡与蓝图', 'Refresh the project tree, character cards, and blueprints.']),
    ],
    onComplete: {
      mode: 'silent',
      message: textForLocale(
        params.run.locale,
        '小说拆解与仿写准备完成，可以开始续写。',
        'Novel analysis and style study is ready. You can start writing.',
      ),
    },
  }
}

export function estimateImportCost(_totalWords: number, chapterCount: number): {
  globalTokens: number
  blueprintTokens: number
  estimatedTokens: number
  estimatedMinutes: number
} {
  const globalTokens = 15_000
  const blueprintTokens = 4_000 * chapterCount
  return {
    globalTokens,
    blueprintTokens,
    estimatedTokens: globalTokens + blueprintTokens,
    estimatedMinutes: Math.ceil((1 + Math.ceil(chapterCount / 5)) * 12 / 60),
  }
}
