import type { ErrorDisplayLocale, InterfaceLocale } from '../types'

/** 测试里直接指定作者看到的界面语言；生产代码只从 locale-store 与主进程配置取得。 */
export function shown(locale: InterfaceLocale): ErrorDisplayLocale {
  return locale as ErrorDisplayLocale
}
