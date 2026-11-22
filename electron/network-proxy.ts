import http from 'node:http'
import net from 'node:net'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from './utils/config-utils'
import type { GlobalConfig } from '../src/shared/ipc-channels'

type ProxySettings = GlobalConfig['proxy']

let installed: { settings: ProxySettings; host: string; port: number; restore: () => void } | null = null

const LOOPBACK = new Set(['127.0.0.1', '::1'])
const MCP_INHERITED_PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const

function install(proxy: ProxySettings): void {
  if (installed) {
    installed.restore()
    for (const key of MCP_INHERITED_PROXY_ENV_KEYS) delete process.env[key]
  }
  installed = null
  if (!proxy?.enabled || !proxy.host) return
  const host = proxy.host.replace(/^\[(.*)\]$/, '$1')
  const url = `${proxy.type === 'socks5' ? 'socks5' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${proxy.port}`
  try {
    const restore = http.setGlobalProxyFromEnv({ HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,[::1]' } as http.ProxyEnv)
    installed = { settings: proxy, host, port: proxy.port, restore }
    for (const key of MCP_INHERITED_PROXY_ENV_KEYS) process.env[key] = url
  } catch {
    throw new Error('NETWORK_PROXY_INVALID')
  }
}

/** 主进程的 fetch 不读 HTTP(S)_PROXY 环境变量，要装成全局代理才生效。新地址非法时装回原来的再抛；返回的函数撤销这次更换。 */
export function applyNetworkProxy(proxy: ProxySettings): () => void {
  const previous = installed?.settings
  try {
    install(proxy)
  } catch (error) {
    install(previous)
    throw error
  }
  return () => install(previous)
}

export function applySavedNetworkProxy(): void {
  try {
    applyNetworkProxy(readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG).proxy)
  } catch (error) {
    console.warn('[network-proxy] saved proxy not applied', error instanceof Error ? error.message : error)
  }
}

type ConnectFailure = { syscall?: unknown; address?: unknown; port?: unknown; hostname?: unknown; errors?: ConnectFailure[] }

/** fetch 失败时，连不上的端点在 cause 里（主机名解析出多个地址时在 cause.errors）；只有它正是当前代理，才是代理连不上。 */
export function failedAtProxy(error: unknown): boolean {
  const proxy = installed
  const cause = (error as { cause?: ConnectFailure } | null)?.cause
  if (!proxy || !cause) return false
  if (cause.syscall === 'getaddrinfo') return String(cause.hostname).toLowerCase() === proxy.host.toLowerCase()
  return [cause, ...(cause.errors ?? [])].some(failure => failure?.syscall === 'connect' && failure.port === proxy.port
    && (net.isIP(proxy.host) ? failure.address === proxy.host : LOOPBACK.has(String(failure.address)) === (proxy.host.toLowerCase() === 'localhost')))
}
