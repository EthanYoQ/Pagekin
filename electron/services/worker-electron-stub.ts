import { registerHooks } from 'node:module'

/**
 * worker 线程没有 electron 内置模块，打包后也没有 npm 的 electron 包。主进程这边有模块在加载时 import 了 electron，
 * 只在主进程里调用它的 API；这里把它解析成同名导出全为 undefined 的空模块，真调用到会直接报错。
 * 装好之后再用动态 import 加载这些模块。
 */
export function stubElectron(electronExports: readonly string[]): void {
  const stub = [
    'export default {}',
    ...electronExports.filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name)).map(name => `export const ${name} = undefined`),
  ].join('\n')
  registerHooks({
    resolve: (specifier, context, next) => specifier === 'electron'
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : next(specifier, context),
  })
}
