// 评测脚本打包时替换 electron：评测只调用纯函数，用不到这两个对象。
export const app = { getPath: () => '', isPackaged: false, getVersion: () => '0', on: () => {} }
export const nativeImage = {}
export default { app, nativeImage }
