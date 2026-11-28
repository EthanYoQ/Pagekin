export type FailureCode = `${Uppercase<string>}_${Uppercase<string>}`

const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u

export function failureCode(value: unknown): FailureCode | undefined {
  return typeof value === 'string' && CODE_SHAPE.test(value) ? value as FailureCode : undefined
}

declare const ownedBrand: unique symbol
export type AuthorOwned = string & { readonly [ownedBrand]: true }
export const authorOwned = (value: string): AuthorOwned => value as AuthorOwned
export type NoteParams = Readonly<Record<string, number | AuthorOwned>>

export type Literal<T extends string> = Record<never, never> extends Record<T, 1> ? never : T

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

  static catalogOf<const K extends string>(key: Literal<K>, params?: NoteParams): AuthorNote {
    return new AuthorNote(key, undefined, params)
  }

  static minted(value: unknown): value is AuthorNote {
    return typeof value === 'object' && value !== null && #minted in value
  }
}
export const note = AuthorNote.copyOf
export const catalogKeyNote = AuthorNote.catalogOf

export type Recovery = 'resume-plot-outline' | 'restart-plot-outline'

interface FailureExtras {
  readonly because?: Failure
  readonly recovery?: Recovery
}

export type Failure =
  | ({ readonly code: FailureCode; readonly note?: AuthorNote } & FailureExtras)
  | ({ readonly code?: undefined; readonly note: AuthorNote } & FailureExtras)

declare const wireKeyBrand: unique symbol
/** 只有 wireNote() 造得出。 */
export type WireNoteKey = string & { readonly [wireKeyBrand]: true }
export interface WireNote { readonly key: WireNoteKey; readonly params?: NoteParams }
export interface WireFailure { readonly code: FailureCode; readonly note?: WireNote }
export interface IpcFailure { readonly success: false; readonly failure: WireFailure }

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

export function codeOf(failure: Failure): FailureCode | undefined {
  if (failure.code) return failure.code
  return failure.because ? codeOf(failure.because) : undefined
}

const CODE_ONLY = /^(?:Error invoking remote method '[^']+': )?(?:[A-Za-z]*Error: )?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/u

export function failureOf(error: unknown): Failure | undefined {
  if (error instanceof AuthorError) return error.failure
  const message = typeof error === 'string' ? error : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : undefined
  const carried = typeof error === 'object' && error !== null
    ? failureCode((error as { code?: unknown }).code) ?? failureCode((error as { errorCode?: unknown }).errorCode)
    : undefined
  const inMessage = message === undefined ? undefined : failureCode(CODE_ONLY.exec(message.trim())?.[1])
  if (inMessage) return carried && carried !== inMessage ? undefined : { code: inMessage }
  return carried && !message?.trim() ? { code: carried } : undefined
}
