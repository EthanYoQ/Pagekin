import { ImportRunRepository } from '../import-run-repository'
import { wireNote } from '../../../src/i18n/app-errors'
import type { ImportRunExecutionLease } from '../../../src/shared/import-run'

export function importRunFailuresAreCodesNotSentences(error: Error, sentence: string, lease: ImportRunExecutionLease): unknown[] {
  return [
    ImportRunRepository.fail('run', 'knowledge', { code: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' }, lease),
    ImportRunRepository.fail('run', 'knowledge', { code: 'IMPORT_RUN_FAILED', note: wireNote('error.importReferenceChapterNotWritten', { number: 2 }) }, lease),
    ImportRunRepository.failParsedSource('run', 'source', { code: 'IMPORT_SOURCE_SELECTION_FAILED', note: wireNote('error.importSelectionEmpty') }),
    // @ts-expect-error 运行失败记录不收句子
    ImportRunRepository.fail('run', 'knowledge', sentence, lease),
    // @ts-expect-error 也不收 error.message
    ImportRunRepository.fail('run', 'knowledge', error.message, lease),
    // @ts-expect-error 来源失败记录不收句子
    ImportRunRepository.failParsedSource('run', 'source', sentence),
    // @ts-expect-error 说明只能是 wireNote() 造的目录键
    ImportRunRepository.fail('run', 'knowledge', { code: 'IMPORT_RUN_FAILED', note: { key: sentence } }, lease),
  ]
}
