import { wireNote } from '../app-errors'
import type { IpcFailure, WireFailure, WireNote } from '../../shared/failure'

export function writtenSentencesCannotCrossIpc(error: Error, sentence: string, maxLength: number): unknown[] {
  return [
    { success: false, failure: { code: 'PROJECT_STORAGE_PATH_UNSUPPORTED', note: wireNote('error.projectPathTooDeepForDatabase', { max: maxLength }) } } satisfies IpcFailure,
    // @ts-expect-error 手写的目录键：只有 wireNote() 造得出
    { key: 'error.projectNotOpen' } satisfies WireNote,
    // @ts-expect-error 说明里放写好的句子
    { code: 'PROJECT_NOT_OPEN', note: { key: sentence } } satisfies WireFailure,
    // @ts-expect-error 说明本身是句子
    { code: 'PROJECT_NOT_OPEN', note: error.message } satisfies WireFailure,
    // @ts-expect-error 键不在目录里
    wireNote('请先打开项目。'),
    // @ts-expect-error 键是变量
    wireNote(sentence),
    // @ts-expect-error 「发生错误：{message}」整句只装原文，不许过 IPC
    wireNote('error.unknown', { message: error.message }),
    // @ts-expect-error 参数不能是对象
    wireNote('error.projectPathTooDeepForDatabase', { max: error }),
    // @ts-expect-error 新形状没有写好的句子这一栏
    { success: false, failure: { code: 'PROJECT_NOT_OPEN' }, message: sentence } satisfies IpcFailure,
    // @ts-expect-error 过 IPC 的失败必须有码
    { success: false, failure: { note: wireNote('error.projectNotOpen') } } satisfies IpcFailure,
  ]
}
