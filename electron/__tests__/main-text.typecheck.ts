import { mainText } from '../i18n'

/** tsc 检查：主进程文案的日文只能写在英文之后，参数对象只能放在最后。 */
export function mainJapaneseCopyComesBeforeParams(systemLocale: string | undefined): void {
  const params = { n: 1 }
  mainText(systemLocale, '{n} 个文件', '{n} files', '{n} 件のファイル', params)
  // @ts-expect-error 参数对象不能放在日文之前
  mainText(systemLocale, '{n} 个文件', '{n} files', params, '{n} 件のファイル')
}
