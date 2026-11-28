import { describe, expect, it } from 'vitest'
import { receivedIpcResult } from '../../i18n/app-errors'
import { useLocaleStore } from '../../stores/locale-store'
import { KnowledgeBaseServiceError, unwrapKnowledgeValue } from '../knowledge-service'

describe('knowledge service native failure normalization', () => {
  it('returns successful knowledge values unchanged', () => {
    const value = [{ text: 'sample', score: 0.9, fileName: 'novel.txt' }]
    expect(unwrapKnowledgeValue(value)).toBe(value)
  })

  it('turns a native loader failure into a stable renderer error', () => {
    expect(() => unwrapKnowledgeValue({
      success: false,
      errorCode: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE',
      error: 'Cannot find native binding',
    })).toThrowError(KnowledgeBaseServiceError)

    try {
      unwrapKnowledgeValue({ success: false, errorCode: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' })
    }
  })
})

describe('知识库失败显示主进程给的具体说明（#899）', () => {
  it.each([
    ['en-US', 'The book can still be opened and exported'],
    ['ja-JP', 'ナレッジベースを使えません'],
  ] as const)('%s', (locale, specific) => {
    useLocaleStore.setState({ locale: 'en-US', interfaceLocale: locale, initialized: true })
    const result = receivedIpcResult({
      success: false as const,
      errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED' as const,
      error: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      failure: { code: 'PROJECT_STORAGE_PATH_UNSUPPORTED', note: { key: 'error.projectPathTooDeepForKnowledgeBase', params: { max: 85 } } },
    })
    let thrown: unknown
    try { unwrapKnowledgeValue(result as never) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(KnowledgeBaseServiceError)
    expect((thrown as Error).message).toContain(specific)
    expect((thrown as Error).message).toContain('85')
    expect(thrown).toMatchObject({ code: 'PROJECT_STORAGE_PATH_UNSUPPORTED' })
  })
})
