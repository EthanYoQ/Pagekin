// 错误形状取自 Electron 44.9.3 主进程实测：fetch 只报 fetch failed，连不上的端点在 cause 里。
const connectRefused = (address: string, port: number) =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}:${port}`), { code: 'ECONNREFUSED', errno: -4078, syscall: 'connect', address, port })

export const refused = (address: string, port: number) =>
  Object.assign(new TypeError('fetch failed'), { cause: connectRefused(address, port) })

export const refusedLocalhost = (port: number) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new AggregateError([connectRefused('::1', port), connectRefused('127.0.0.1', port)], ''), { code: 'ECONNREFUSED' }),
  })

export const hostNotFound = (hostname: string) => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { errno: -3008, code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname }),
})

export const tunnelRefused = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('Request was cancelled.'), {
    code: 0,
    cause: Object.assign(new Error('Proxy response (502) !== 200 when HTTP Tunneling'), { name: 'AbortError', code: 'UND_ERR_ABORTED' }),
  }),
})

/** 替身：Node 22 没有 http.setGlobalProxyFromEnv。和 Electron 一样先解析地址，非法就抛。 */
export const dispatcher = { proxy: null as string | null }

export function setGlobalProxyFromEnv(env: { HTTP_PROXY?: string }) {
  new URL(env.HTTP_PROXY!)
  const previous = dispatcher.proxy
  dispatcher.proxy = env.HTTP_PROXY!
  return () => { dispatcher.proxy = previous }
}
