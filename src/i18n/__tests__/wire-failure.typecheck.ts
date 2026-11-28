import { wireNote } from '../app-errors'
import { authorOwned, type IpcFailure, type WireFailure, type WireNote } from '../../shared/failure'

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
    // @ts-expect-error 参数不能是对象
    wireNote('error.projectPathTooDeepForDatabase', { max: error }),
    // @ts-expect-error 新形状没有写好的句子这一栏
    { success: false, failure: { code: 'PROJECT_NOT_OPEN' }, message: sentence } satisfies IpcFailure,
    // @ts-expect-error 过 IPC 的失败必须有码
    { success: false, failure: { note: wireNote('error.projectNotOpen') } } satisfies IpcFailure,
  ]
}

export function caughtTextCannotFillWireParams(error: Error, fileName: string): unknown[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = JSON.parse(fileName)
    return [
      wireNote('error.importRunCheckFailed', { code: authorOwned(fileName) }),
      // @ts-expect-error 直接传 err.message
      wireNote('error.importRunCheckFailed', { code: error.message }),
      // @ts-expect-error 直接传 String(err)
      wireNote('error.importRunCheckFailed', { code: String(error) }),
      // @ts-expect-error 直接传模板串
      wireNote('error.importRunCheckFailed', { code: `${error}` }),
      // @ts-expect-error 普通 string 也不行，作者数据要经 authorOwned
      wireNote('error.importRunCheckFailed', { code: fileName }),
      // @ts-expect-error JSON.parse 出来的 any
      wireNote('error.importRunCheckFailed', { code: JSON.parse(fileName).message }),
      // @ts-expect-error 整个参数对象是 any
      wireNote('error.importRunCheckFailed', JSON.parse(fileName)),
      // @ts-expect-error 先把 any 赋给变量再传
      wireNote('error.importRunCheckFailed', parsed),
    ]
  } catch (caught) {
    try {
      // @ts-expect-error 直接传 catch 变量
      return [wireNote('error.importRunCheckFailed', { code: caught })]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch ({ message }: any) {
      // @ts-expect-error 解构 catch 取出的 message
      return [wireNote('error.importRunCheckFailed', { code: message })]
    }
  }
}
