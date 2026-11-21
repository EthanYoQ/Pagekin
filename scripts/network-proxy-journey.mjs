// 不替换主进程 fetch；远端地址用不存在的域名，只有经过代理才到得了本机假服务。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

let app
let root
let proxy
const targetSaw = []
const target = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    targetSaw.push(req.headers.host)
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }))
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }))
  })
})
const counts = {}
try {
  const targetPort = await new Promise(resolve => target.listen(0, '::', () => resolve(target.address().port)))

  const proxySaw = []
  proxy = http.createServer((req, res) => {
    proxySaw.push(req.url)
    res.writeHead(502).end()
  })
  proxy.on('connect', (req, socket, head) => {
    proxySaw.push(`CONNECT ${req.url}`)
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const proxyPort = await new Promise(resolve => proxy.listen(0, '::', () => resolve(proxy.address().port)))
  const closed = [http.createServer(), http.createServer()]
  const [closedPort, deadLocalPort] = await Promise.all(closed.map(listen))
  await Promise.all(closed.map(server => new Promise(resolve => server.close(resolve))))

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-journey-'))
  const roots = Object.fromEntries(['canonical', 'legacy', 'home', 'appData', 'localAppData', 'temp', 'userData'].map(name => [name, path.join(root, name)]))
  for (const [name, dir] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData, TEMP: roots.temp, TMP: roots.temp }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete env[name]

  const model = (baseUrl, purposes = ['generation']) => ({ id: `probe-${purposes[0]}`, name: 'probe', provider: 'custom', protocol: 'openai',
    modelName: 'probe-model', apiKey: 'sk-probe-not-a-secret', baseUrl, temperature: 0.7, maxTokens: 256, purposes })
  const REMOTE = 'http://model-probe.test/v1'
  const PROXY_DOWN = '连不上「网络代理」里设置的代理'

  app = await electron.launch({ cwd: repository, env, timeout: 90_000,
    args: ['-r', path.join(repository, 'scripts/redesign/offscreen-window.cjs'), '.', `--user-data-dir=${roots.userData}`, '--lang=zh-CN'] })
  const page = await app.firstWindow({ timeout: 90_000 })
  await page.waitForFunction(() => Boolean(window.aiNovelAPI), null, { timeout: 90_000 })
  const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
  const setProxy = proxySettings => invoke('config:set', { proxy: { type: 'http', host: '127.0.0.1', ...proxySettings } })
  const calls = {
    'test-connection http': () => invoke('llm:test-connection', model(REMOTE)),
    'test-connection https': () => invoke('llm:test-connection', model('https://model-probe.test/v1')),
    'discover-models': () => invoke('llm:discover-models', { provider: 'custom', protocol: 'openai', baseUrl: REMOTE, apiKey: 'sk-probe-not-a-secret', purposes: ['generation'] }),
    'test-connection embedding': () => invoke('llm:test-connection', model(REMOTE, ['embedding'])),
    'test-connection rerank': () => invoke('llm:test-connection', model(REMOTE, ['rerank'])),
    'cloud-backup connect': () => invoke('cloud-backup:connect', { endpoint: 'https://webdav-probe.test/dav/', username: 'probe', secret: 'probe-not-a-secret' }),
  }
  const local = {
    'local 127.0.0.1': () => invoke('llm:test-connection', model(`http://127.0.0.1:${targetPort}/v1`)),
    'local localhost': () => invoke('llm:test-connection', model(`http://localhost:${targetPort}/v1`)),
    'local [::1]': () => invoke('llm:test-connection', model(`http://[::1]:${targetPort}/v1`)),
  }
  const run = async (phase, table) => {
    const results = {}
    for (const [name, call] of Object.entries(table)) {
      const before = proxySaw.length
      const reachedBefore = targetSaw.length
      const result = await call()
      results[name] = { result, proxied: proxySaw.slice(before), viaProxy: targetSaw.slice(reachedBefore).filter(host => host === 'model-probe.test').length }
    }
    counts[phase] = { proxyLog: Object.fromEntries(Object.entries(results).map(([name, { proxied }]) => [name, proxied])),
      remoteHostReached: Object.fromEntries(Object.entries(results).map(([name, { viaProxy }]) => [name, viaProxy])) }
    return results
  }

  assert.deepEqual(await setProxy({ enabled: false, port: proxyPort }), { success: true })
  const off = await run('proxy off', { ...calls, ...local })
  for (const [name, { proxied, viaProxy }] of Object.entries(off)) {
    assert.equal(proxied.length + viaProxy, 0, `${name}: proxy off sends nothing to the proxy`)
  }

  assert.deepEqual(await setProxy({ enabled: true, port: proxyPort }), { success: true })
  const on = await run('proxy on', { ...calls, ...local })
  // undici 复用隧道，同一目标代理日志里只有一次 CONNECT。
  for (const name of ['test-connection http', 'discover-models', 'test-connection embedding', 'test-connection rerank']) {
    assert.ok(on[name].viaProxy > 0, `${name}: proxy on routes the request through the proxy`)
  }
  assert.equal(on['test-connection http'].result.success, true, 'test connection succeeds through the proxy')
  assert.equal(on['discover-models'].result.success, true, 'model list arrives through the proxy')
  assert.ok(on['test-connection https'].proxied.includes('CONNECT model-probe.test:443'), 'https tunnels through the proxy')
  assert.ok(on['cloud-backup connect'].proxied.includes('CONNECT webdav-probe.test:443'), 'WebDAV tunnels through the proxy')
  for (const name of Object.keys(local)) {
    assert.equal(on[name].proxied.length, 0, `${name}: local model bypasses the proxy`)
    assert.equal(on[name].result.success, true, `${name}: local model still works with the proxy on`)
  }

  assert.deepEqual(await setProxy({ enabled: true, port: closedPort }), { success: true })
  const down = await run('proxy closed port', { ...calls, ...local })
  for (const name of ['test-connection http', 'test-connection https', 'test-connection embedding', 'test-connection rerank']) {
    assert.ok(String(down[name].result.error).startsWith(PROXY_DOWN), `${name}: author is told the proxy is unreachable, got ${down[name].result.error}`)
  }
  assert.equal(down['discover-models'].result.errorCode, 'proxy', 'model list reports the unreachable proxy')
  assert.equal(down['cloud-backup connect'].result.errorCode, 'CLOUD_BACKUP_PROXY_UNREACHABLE', 'cloud backup reports the unreachable proxy')
  for (const name of Object.keys(local)) assert.equal(down[name].result.success, true, `${name}: local model ignores the dead proxy`)
  assert.equal((await invoke('cloud-backup:connect', { endpoint: `http://127.0.0.1:${deadLocalPort}/dav/`, username: 'probe', secret: 'probe-not-a-secret' })).errorCode,
    'CLOUD_BACKUP_NETWORK_FAILED', 'a dead local WebDAV is not blamed on the proxy')

  for (const host of ['[::1]', '::1']) {
    assert.deepEqual(await setProxy({ enabled: true, host, port: proxyPort }), { success: true }, `IPv6 proxy host ${host} is accepted`)
    assert.equal((await calls['test-connection http']()).success, true, `IPv6 proxy host ${host} carries requests`)
  }
  assert.deepEqual(await setProxy({ enabled: true, host: 'http://127.0.0.1', port: proxyPort }),
    { success: false, error: 'NETWORK_PROXY_INVALID' }, 'a host with a scheme is rejected before it is saved')
  assert.equal((await invoke('config:get')).proxy.host, '::1', 'the rejected proxy was not saved')

  const appPid = app.process().pid
  console.log(JSON.stringify({ appPid, counts }, null, 1))
  console.log('network proxy journey passed')
} catch (error) {
  console.log(JSON.stringify({ counts }, null, 1))
  throw error
} finally {
  if (app) await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 10_000))])
  for (const server of [target, proxy]) if (server?.listening) { server.closeAllConnections(); server.close() }
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
