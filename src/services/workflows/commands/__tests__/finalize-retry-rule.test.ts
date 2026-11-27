import { afterEach, expect, it, vi } from 'vitest'

import type { WorkflowContext } from '../../../../stores/workflow-store'
import { buildFinalizePostProcessSteps, type FinalizePostProcessGeneration } from '../finalize-chapter.command'
import { planFinalizationRetry } from '../../../../shared/finalization-step-error'
import { shown } from '../../../../i18n/__tests__/shown-locale'

const PROJECT_PATH = 'C:\\novels\\A'
const SESSION = { projectId: 'A', leaseId: 'lease-A', projectPath: PROJECT_PATH }
const generation: FinalizePostProcessGeneration = { complete: async () => { throw new Error('unused') } }
const callbacks = () => ({ log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })

function context(uiLocale: 'zh-CN' | 'en-US'): WorkflowContext {
  return { runId: 'retry-rule', projectPath: PROJECT_PATH, projectSession: SESSION, uiLocale, interfaceLocale: shown(uiLocale), writingLanguage: 'zh-CN', data: {}, cancelled: false }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function stepError(uiLocale: 'zh-CN' | 'en-US', importResult: object, withContext = true): Promise<string> {
  vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async () => importResult) } })
  const [kbImport] = buildFinalizePostProcessSteps({ path: PROJECT_PATH }, 1, '雾钟', '正文', generation, 42, [], uiLocale)
  const failure = await kbImport!.executor(callbacks(), withContext ? context(uiLocale) : undefined).then(() => undefined, (error: unknown) => error)
  return (failure as Error).message
}

it('定稿后处理的重试规则不变', async () => {
  const expected = {
    'zh-CN': ['定稿后处理缺少冻结工作流上下文', '知识库导入成功但缺少文档身份收据', 'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED'],
    'en-US': [
      'Post-finalization processing is missing the frozen workflow context.',
      'The knowledge-base import succeeded but returned no document identity receipt.',
      'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED',
    ],
  } as const
  for (const uiLocale of ['zh-CN', 'en-US'] as const) {
    const recorded = [
      await stepError(uiLocale, { success: true, chunkCount: 1, docId: 'doc-1' }, false),
      await stepError(uiLocale, { success: true, chunkCount: 1 }),
      await stepError(uiLocale, { success: false, error: 'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED' }),
    ]
    // 落库的步骤原因就是 executor 抛出的 message，重试规则只读它。
    expect(recorded).toEqual(expected[uiLocale])
    for (const error of recorded) {
      const plan = planFinalizationRetry({ kb_import: { ok: false, error }, chapter_notes: { ok: false, error: 'POST_PROCESS_INTERRUPTED' }, character_cards: { ok: true } })
      expect({ rows: [...plan.rows], card: plan.card, retired: [...plan.retired] }).toEqual({
        rows: [['kb_import', ['kb_import']], ['chapter_notes', ['chapter_notes']]], card: ['kb_import', 'chapter_notes'], retired: [],
      })
    }
  }
})
