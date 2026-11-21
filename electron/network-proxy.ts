import http from 'node:http'
import net from 'node:net'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from './utils/config-utils'
import type { GlobalConfig } from '../src/shared/ipc-channels'

type ProxySettings = GlobalConfig['proxy']

let installed: { host: string; port: number; restore: () => void } | null = null

/** 主进程的 fetch 不读 HTTP(S)_PROXY 环境变量，要装成全局代理才生效。 */
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

export function applySavedNetworkProxy(): void {
  try {
    applyNetworkProxy(readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG).proxy)
  } catch (error) {
    console.warn('[network-proxy] saved proxy not applied', error instanceof Error ? error.message : error)
  }
}

/** 代理端口连不上时，经代理的请求不可能成功，所以它就是失败的原因。 */
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
