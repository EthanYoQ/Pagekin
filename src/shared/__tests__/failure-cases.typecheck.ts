import { AuthorError, AuthorNote, authorOwned, catalogKeyNote, note, type Failure, type FailureCode, type WireFailure } from '../failure'

/** tsc 检查（原文放不进说明）：合法写法编译通过，下面每条反例都必须报错。 */
export function legalShapes(fileName: string, n: number, error: Error, key: 'error.proxyUnreachable' | 'error.unregisteredCode'): unknown[] {
  const proxy: Failure = { code: 'NETWORK_ERROR', note: catalogKeyNote('error.proxyUnreachable') }
  return [
    proxy,
    { note: note('无法导入 {file}', 'Could not import {file}', { file: authorOwned(fileName) }), because: { code: 'LEGACY_VECTOR_MIGRATION_BLOCKED' } } satisfies Failure,
    { code: 'PROJECT_NOT_OPEN' } satisfies Failure,
    { note: note('第 {n} 章没有生成。', 'Chapter {n} was not generated.', { n }) } satisfies Failure,
    { code: 'EMBEDDING_MODEL_NOT_CONFIGURED', note: { key: 'error.embeddingModelNotConfigured' } } satisfies WireFailure,
    { note: note('大纲没有写完。', 'The outline is incomplete.'), recovery: 'resume-plot-outline' } satisfies Failure,
    catalogKeyNote(key),
    new AuthorError(proxy, '已渲染的说明', { cause: error }),
    'A1_B2' satisfies FailureCode,
  ]
}

export function rawTextIsRejected(error: Error, n: number, zhSummary: string, enSummary: string, minted: AuthorNote, thrown: AuthorError): unknown[] {
  return [
    // @ts-expect-error 句子不是码
    { code: 'fetch failed' } satisfies Failure,
    // @ts-expect-error error.message 不是码
    { code: error.message } satisfies Failure,
    // @ts-expect-error 说明不能是字符串
    { code: 'NETWORK_ERROR', note: error.message } satisfies Failure,
    // @ts-expect-error 模板里不能直接放 error.message
    note(error.message, error.message),
    // @ts-expect-error 带插值的模板字符串不是字面量
    note(`失败：${error.message}`, `Failed: ${error.message}`),
    // @ts-expect-error 数字插值也要走参数
    note(`第 ${n} 章`, `Chapter ${n}`),
    // @ts-expect-error 参数不能是未标记的字符串
    note('失败：{reason}', 'Failed: {reason}', { reason: error.message }),
    // @ts-expect-error 码和说明都没有
    {} satisfies Failure,
    // @ts-expect-error 过 IPC 的失败不能带类实例的说明
    { code: 'NETWORK_ERROR', note: note('甲', 'A') } satisfies WireFailure,
    // @ts-expect-error 过 IPC 的失败必须有码
    { note: { key: 'x' } } satisfies WireFailure,
    // @ts-expect-error 小写不是码
    'network_error' satisfies FailureCode,
    // @ts-expect-error 手写 copy 对象字面量
    { code: 'NETWORK_ERROR', note: { kind: 'copy', zh: error.message, en: error.message } } satisfies Failure,
    // @ts-expect-error 照着说明类的字段手写
    { note: { key: undefined, copy: { zh: error.message, en: error.message }, params: undefined } } satisfies Failure,
    // @ts-expect-error 手写目录对象字面量
    { note: { kind: 'catalog', key: error.message } } satisfies Failure,
    // @ts-expect-error 照着说明类的字段手写目录键
    { note: { key: error.message, copy: undefined, params: undefined } } satisfies Failure,
    // @ts-expect-error 展开已有说明再改字段
    { note: { ...minted, copy: { zh: error.message, en: error.message } } } satisfies Failure,
    // @ts-expect-error 展开已有说明再改键
    { ...minted, key: error.message } satisfies AuthorNote,
    // @ts-expect-error 工厂传变量：目录键
    catalogKeyNote(error.message),
    // @ts-expect-error 工厂传变量：String(error)
    catalogKeyNote(String(error)),
    // @ts-expect-error 工厂传变量：string 形参的概述
    note(zhSummary, enSummary),
    // @ts-expect-error 构造函数私有
    new AuthorNote(error.message, undefined, undefined),
    // @ts-expect-error 说明造出来之后改不了
    minted.key = error.message,
    // @ts-expect-error 码造出来之后改不了
    thrown.code = 'NETWORK_ERROR',
    // @ts-expect-error 续写标记不是码，走 recovery
    { code: 'architecture-synopsis-resume-available' } satisfies Failure,
    // @ts-expect-error recovery 是封闭的几个值
    { code: 'NETWORK_ERROR', recovery: error.message } satisfies Failure,
    // @ts-expect-error 模型发现的通道枚举不进 Failure
    { code: 'network' } satisfies Failure,
  ]
}
