import { describe, expect, it } from 'vitest'

import {
  isProjectStoragePreflightError,
  projectStoragePreflightFailure,
  ProjectStoragePreflightError,
  assertProjectMigrationPathsSupported,
} from '../project-storage-preflight'
import { failureText, publicWireFailure, wireFailure } from '../../../src/i18n/app-errors'
import type { ErrorDisplayLocale } from '../../../src/i18n/types'

describe('project storage preflight failure seam', () => {
  it('includes the longer vector staging path before any project migration write', () => {
    expect(() => assertProjectMigrationPathsSupported('C:\\short', { platform: 'win32' })).not.toThrow()
    expect(() => assertProjectMigrationPathsSupported(`C:\\${'a'.repeat(140)}`, { platform: 'win32' })).toThrow(ProjectStoragePreflightError)
  })
  it('maps the typed preflight error to one sanitized AppFailure contract', () => {
    const error = new ProjectStoragePreflightError(250, 120, 'knowledge-base')

    expect(isProjectStoragePreflightError(error)).toBe(true)
    expect(projectStoragePreflightFailure(error)).toEqual({
      success: false,
      errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      error: error.message,
      failure: { code: 'PROJECT_STORAGE_PATH_UNSUPPORTED', note: { key: 'error.projectPathTooDeepForKnowledgeBase', params: { max: 120 } } },
    })
  })

  it('路径过深的说明过 IPC 后按界面语言显示，旧 error 字段与 master 相同', () => {
    for (const [storage, zh] of [
      ['project', '项目路径过深，打不开项目数据库。请把项目文件夹移到靠近磁盘根目录处（例如 D:\\Novels），路径不超过 120 个字符。'],
      ['knowledge-base', '项目路径过深，知识库不可用，项目内容仍可打开和导出。请把项目文件夹移到靠近磁盘根目录处（例如 D:\\Novels），路径不超过 120 个字符。'],
    ] as const) {
      const shown = projectStoragePreflightFailure(new ProjectStoragePreflightError(250, 120, storage))!
      expect(shown.error).toBe(zh)
      const received = wireFailure(publicWireFailure(JSON.parse(JSON.stringify(shown.failure))))!
      expect(failureText('zh-CN' as ErrorDisplayLocale, received)).toBe(zh)
      expect(failureText('en-US' as ErrorDisplayLocale, received)).toMatch(/^The project path is too deep.* at most 120 characters\.$/u)
      expect(failureText('ja-JP' as ErrorDisplayLocale, received)).toContain('120 文字以内')
    }
  })

  it('accepts a cross-realm Error carrying the exact stable code but rejects plain duck-typed objects', () => {
    const serializedError = Object.assign(new Error('move the project'), {
      code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
    })

    expect(projectStoragePreflightFailure(serializedError)).toEqual({
      success: false,
      errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      error: 'move the project',
      failure: { code: 'PROJECT_STORAGE_PATH_UNSUPPORTED' },
    })
    expect(isProjectStoragePreflightError({
      code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      message: 'forged object',
    })).toBe(false)
    expect(projectStoragePreflightFailure(new Error('ordinary failure'))).toBeUndefined()
  })
})
