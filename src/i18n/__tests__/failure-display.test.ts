import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AuthorError, AuthorNote, authorOwned, failureOf, note, type Failure } from '../../shared/failure'
import { appErrorMessage, authorError, catalogNote, caughtFailure, displayedErrorMessage, failureText, knownAppErrorMessage } from '../app-errors'
import { translate } from '../core'
import { shown } from './shown-locale'

const zh = shown('zh-CN')
const en = shown('en-US')
const raw = 'connect ECONNREFUSED 127.0.0.1:7890'
const generic = translate(zh, 'error.unregisteredCode')
const networkGeneric = translate(zh, 'error.generationNetworkFailed')
const proxy = translate(zh, 'error.proxyUnreachable')

let warn: MockInstance<typeof console.warn>
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('旧显示入口收到 AuthorError 时显示它的说明', () => {
  const error = authorError(zh, { code: 'NETWORK_ERROR', note: catalogNote('error.proxyUnreachable') })

  it('三个旧入口都显示说明，不被码盖成通用网络说明', () => {
    expect(error.message).toBe(proxy)
    expect(error.code).toBe('NETWORK_ERROR')
    expect(displayedErrorMessage(zh, error)).toBe(proxy)
    expect(appErrorMessage(zh, error)).toBe(proxy)
    expect(knownAppErrorMessage(zh, error)).toBe(proxy)
  })

  it('按显示语言取说明', () => {
    expect(displayedErrorMessage(en, error)).toBe(translate(en, 'error.proxyUnreachable'))
  })

  it('说不出时 knownAppErrorMessage 留给调用方，displayedErrorMessage 用调用方的兜底', () => {
    const unexplained = new AuthorError({ code: 'WORKFLOW_UNREGISTERED_TEST_CODE' }, '')
    expect(knownAppErrorMessage(zh, unexplained)).toBeUndefined()
    expect(displayedErrorMessage(zh, unexplained, '这一步没完成。')).toBe('这一步没完成。')
    expect(appErrorMessage(zh, unexplained)).toBe(generic)
  })

  it('概述接原因：中文用冒号，英文用空格，相同的句子只留一句', () => {
    const failure: Failure = { note: note('无法导入 {file}', 'Could not import {file}', { file: authorOwned('大纲.md') }), because: { code: 'PROJECT_NOT_OPEN' } }
    expect(failureText(zh, failure)).toBe(`无法导入 大纲.md：${translate(zh, 'error.projectNotOpen')}`)
    expect(failureText(en, failure)).toBe(`Could not import 大纲.md ${translate(en, 'error.projectNotOpen')}`)
    expect(failureText(en, failure, { join: 'colon' })).toBe(`Could not import 大纲.md: ${translate(en, 'error.projectNotOpen')}`)
    expect(failureText(zh, failure, { join: 'paragraph' })).toBe(`无法导入 大纲.md\n\n${translate(zh, 'error.projectNotOpen')}`)
    expect(failureText(zh, { code: 'NETWORK_ERROR', because: { code: 'NETWORK_ERROR' } })).toBe(networkGeneric)
  })

  it('未迁移通道给的原文只在中文界面附上，已登记码按码说明', () => {
    const summary = note('知识库没有更新。', 'The knowledge base was not updated.')
    expect(failureText(zh, { note: summary, because: { legacy: '数据库被占用' } })).toBe('知识库没有更新。：数据库被占用')
    expect(failureText(en, { note: summary, because: { legacy: 'database is locked' } })).toBe('The knowledge base was not updated.')
    expect(failureText(en, { note: summary, because: { legacy: 'PROJECT_NOT_OPEN' } })).toBe(`The knowledge base was not updated. ${translate(en, 'error.projectNotOpen')}`)
  })
})

describe('不是受控入口造的说明不显示', () => {
  it('硬转的说明对象：有码按码说明，没码用通用说明，原文都不出现', () => {
    const withCode = { code: 'NETWORK_ERROR', note: { key: undefined, copy: { zh: raw, en: raw }, params: undefined } } as unknown as Failure
    const withoutCode = { note: { kind: 'copy', zh: raw, en: raw } } as unknown as Failure
    expect(failureText(zh, withCode)).toBe(networkGeneric)
    expect(failureText(zh, withoutCode)).toBe(generic)
    expect(AuthorNote.minted({ ...catalogNote('error.proxyUnreachable') })).toBe(false)
  })

  it('空说明当作没写', () => {
    expect(failureText(zh, { code: 'NETWORK_ERROR', note: note('', '') })).toBe(networkGeneric)
  })
})

describe('目录键不存在时按码说明', () => {
  it('有码按码说明，没码用通用说明，不显示键名', () => {
    expect(failureText(zh, { code: 'NETWORK_ERROR', note: AuthorNote.catalogOf('error.noSuchKey') })).toBe(networkGeneric)
    expect(failureText(zh, { note: AuthorNote.catalogOf('error.noSuchKey') })).toBe(generic)
  })
})

describe('同一个失败渲染多次只记一次日志', () => {
  it('认不出的错误：渲染 1000 次只记一次', () => {
    const error = new Error('某处中文原文')
    for (let i = 0; i < 1000; i++) expect(failureText(zh, caughtFailure(error))).toBe(generic)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('未登记的码与假说明：反复渲染各只记一次', () => {
    const forged = { note: { kind: 'copy', zh: '伪造', en: 'forged' } } as unknown as Failure
    for (let i = 0; i < 100; i++) {
      failureText(zh, { code: 'WORKFLOW_ONCE_ONLY_TEST_CODE' })
      failureText(zh, forged)
    }
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('failureOf', () => {
  it('认得出：整条是码、IPC 包着的码、message 为空而码挂在 code 或 errorCode 上', () => {
    expect(failureOf(new Error('PROJECT_NOT_OPEN'))).toEqual({ code: 'PROJECT_NOT_OPEN' })
    expect(failureOf("Error invoking remote method 'db:save': Error: PROJECT_NOT_OPEN")).toEqual({ code: 'PROJECT_NOT_OPEN' })
    expect(failureOf(Object.assign(new Error(''), { code: 'PROJECT_NOT_OPEN' }))).toEqual({ code: 'PROJECT_NOT_OPEN' })
    expect(failureOf({ errorCode: 'PROJECT_NOT_OPEN' })).toEqual({ code: 'PROJECT_NOT_OPEN' })
  })

  it('认不出：句子另挂码、message 与对象上的码不一致、平台码', () => {
    expect(failureOf(Object.assign(new Error(proxy), { code: 'NETWORK_ERROR' }))).toBeUndefined()
    expect(failureOf(Object.assign(new Error('WORKFLOW_UNREGISTERED_TEST_CODE'), { code: 'PROJECT_NOT_OPEN' }))).toBeUndefined()
    expect(failureOf(new Error('ENOENT'))).toBeUndefined()
  })

  it('普通对象的 message 同样参与判断', () => {
    expect(failureOf({ message: 'PROJECT_NOT_OPEN', code: 'NETWORK_ERROR' })).toBeUndefined()
    expect(failureOf({ message: proxy, code: 'NETWORK_ERROR' })).toBeUndefined()
    expect(failureOf({ message: 'PROJECT_NOT_OPEN' })).toEqual({ code: 'PROJECT_NOT_OPEN' })
    expect(failureOf({ message: '', errorCode: 'PROJECT_NOT_OPEN' })).toEqual({ code: 'PROJECT_NOT_OPEN' })
  })

  it('认不出且 message 为空：caughtFailure 不造码也不造说明，显示时用通用说明', () => {
    const failure = caughtFailure(new Error(''))
    expect(failure).toBeUndefined()
    expect(failureText(zh, failure)).toBe(generic)
  })
})
