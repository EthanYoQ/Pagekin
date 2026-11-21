import http from 'node:http'
import net from 'node:net'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from './utils/config-utils'
import type { GlobalConfig } from '../src/shared/ipc-channels'

type ProxySettings = GlobalConfig['proxy']

let installed: { host: string; port: number; restore: () => void } | null = null

/** 主进程的 fetch 不读 HTTP(S)_PROXY 环境变量，要装成全局代理才生效；本机模型直连。主机地址不合法时抛 NETWORK_PROXY_INVALID，此时不走代理。 */
export function applyNetworkProxy(proxy: ProxySettings): void {
  installed?.restore()
  installed = null
  if (!proxy?.enabled || !proxy.host) return
  const url = `${proxy.type === 'socks5' ? 'socks5' : 'http'}://${proxy.host}:${proxy.port}`
  try {
    const restore = http.setGlobalProxyFromEnv({ HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,::1' } as http.ProxyEnv)
    installed = { host: proxy.host, port: proxy.port, restore }
  } catch {
    throw new Error('NETWORK_PROXY_INVALID')
  }
}

/** 按 config.json 里保存的代理设置生效；启动时和保存失败后用。 */
export function applySavedNetworkProxy(): void {
  try {
    applyNetworkProxy(readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG).proxy)
  } catch (error) {
    console.warn('[network-proxy] saved proxy not applied', error instanceof Error ? error.message : error)
  }
}

/** 开着代理且代理端口现在连不上：经代理的请求不可能成功，这就是失败的原因。 */
export function proxyUnreachable(): Promise<boolean> {
  const proxy = installed
  if (!proxy) return Promise.resolve(false)
  return new Promise(resolve => {
    const socket = net.connect({ host: proxy.host, port: proxy.port, timeout: 3000 })
    const done = (unreachable: boolean) => { socket.destroy(); resolve(unreachable) }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    socket.once('timeout', () => done(true))
  })
}
