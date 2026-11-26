/** 稳定错误码的形状。类型只挡小写和不带下划线的值，汉字句子挡不住，所以边界上一律用 failureCode() 判。 */
export type FailureCode = `${Uppercase<string>}_${Uppercase<string>}`

const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u

export function failureCode(value: unknown): FailureCode | undefined {
  return typeof value === 'string' && CODE_SHAPE.test(value) ? value as FailureCode : undefined
}

declare const ownedBrand: unique symbol
/** 作者自己的数据（文件名、书名、章节名、模型名），可以插进说明。 */
export type AuthorOwned = string & { readonly [ownedBrand]: true }
export const authorOwned = (value: string): AuthorOwned => value as AuthorOwned
export type NoteParams = Readonly<Record<string, number | AuthorOwned>>

/** 只收字符串字面量或字面量的联合；string 和带插值的模板都不收。 */
export type Literal<T extends string> = Record<never, never> extends Record<T, 1> ? never : T

/**
 * 给作者看的说明。带私有字段的类按名义比较，对象字面量和展开出来的对象都不是它；
 * 构造函数私有，只有两个静态入口能造。显示时再用 minted() 认一次，挡住 as 硬转。
 */
export class AuthorNote {
  readonly #minted = true
  private constructor(
    readonly key: string | undefined,
    readonly copy: { readonly zh: string; readonly en: string } | undefined,
    readonly params: NoteParams | undefined,
  ) {
    Object.freeze(this)
  }

  static copyOf<const Z extends string, const E extends string>(zh: Literal<Z>, en: Literal<E>, params?: NoteParams): AuthorNote {
    return new AuthorNote(undefined, { zh, en }, params)
  }

  /** 带目录键检查的入口是 src/i18n/app-errors.ts 的 catalogNote。 */
  static catalogOf<const K extends string>(key: Literal<K>, params?: NoteParams): AuthorNote {
    return new AuthorNote(key, undefined, params)
  }

  static minted(value: unknown): value is AuthorNote {
    return typeof value === 'object' && value !== null && #minted in value
  }
}
export const note = AuthorNote.copyOf
export const catalogKeyNote = AuthorNote.catalogOf

/** 还没迁移的主进程通道给的原因：来路不明的文字，按旧规则显示。 */
export interface LegacyReason { readonly legacy: string }

/** 失败之后作者还能接着做的事。run-failure.ts 凭它出按钮，不凭码。 */
export type Recovery = 'resume-plot-outline' | 'restart-plot-outline'

interface FailureExtras {
  readonly because?: Failure | LegacyReason
  readonly recovery?: Recovery
}

/** 一次失败：码和说明至少有一个。码只拿去查目录和分流，从不直接显示；异常原文没有槽位。 */
export type Failure =
  | ({ readonly code: FailureCode; readonly note?: AuthorNote } & FailureExtras)
  | ({ readonly code?: undefined; readonly note: AuthorNote } & FailureExtras)

/** 过 IPC 的失败是纯数据：类实例过不了结构化克隆，所以说明只带目录键和参数。 */
export interface WireNote { readonly key: string; readonly params?: Readonly<Record<string, number | string>> }
export interface WireFailure { readonly code: FailureCode; readonly note?: WireNote }

/** 渲染端带着失败描述的错误。码由 failure 决定，造完改不了。 */
export class AuthorError extends Error {
  readonly failure: Failure
  constructor(failure: Failure, renderedMessage: string, options?: { cause?: unknown }) {
    super(renderedMessage, options)
    this.name = 'AuthorError'
    this.failure = failure
  }

  get code(): FailureCode | undefined {
    return codeOf(this.failure)
  }
}

/** 本层有码用本层的，没有就沿 because 往下取。 */
export function codeOf(failure: Failure): FailureCode | undefined {
  if (failure.code) return failure.code
  return failure.because && !('legacy' in failure.because) ? codeOf(failure.because) : undefined
}

const CODE_ONLY = /^(?:Error invoking remote method '[^']+': )?(?:[A-Za-z]*Error: )?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/u

/**
 * catch 处认失败。认得出三种：AuthorError；整条 message 就是码；message 为空而 code 或 errorCode 上挂着码。
 * message 是句子又另挂码（句子可能比码的目录文案具体），或 message 与对象上的码不一致，都认不出，走旧字段。
 */
export function failureOf(error: unknown): Failure | undefined {
  if (error instanceof AuthorError) return error.failure
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined
  const carried = typeof error === 'object' && error !== null
    ? failureCode((error as { code?: unknown }).code) ?? failureCode((error as { errorCode?: unknown }).errorCode)
    : undefined
  const inMessage = message === undefined ? undefined : failureCode(CODE_ONLY.exec(message.trim())?.[1])
  if (inMessage) return carried && carried !== inMessage ? undefined : { code: inMessage }
  return carried && !message?.trim() ? { code: carried } : undefined
}
