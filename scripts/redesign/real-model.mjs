import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'

export const REAL_KEY_ENV = 'SILICONFLOW_API_KEY'
export const REAL_ORIGIN = 'https://api.siliconflow.cn'
const REAL_BASE_URL = `${REAL_ORIGIN}/v1`
export const REAL_GENERATION_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash'
export const REAL_MODEL_ENV = 'SILICONFLOW_GENERATION_MODEL'
export const REAL_REASONING_ENV = 'SILICONFLOW_REASONING_OVERRIDE'
export const REAL_EMBEDDING_MODEL = 'BAAI/bge-m3'

export function realModelProfiles(apiKey, generationModel = process.env[REAL_MODEL_ENV]?.trim() || REAL_GENERATION_MODEL) {
  const common = { provider: 'siliconflow', protocol: 'openai', baseUrl: REAL_BASE_URL, apiKey, temperature: 0.7 }
  return {
    generation: { ...common, id: 'realtest-generation', name: '真实测试生成模型', modelName: generationModel,
      maxTokens: 16_384, purposes: ['generation'], reasoningOverride: process.env[REAL_REASONING_ENV]?.trim() || 'auto' },
    embedding: { ...common, id: 'realtest-embedding', name: '真实测试检索模型', modelName: REAL_EMBEDDING_MODEL,
      maxTokens: 0, purposes: ['embedding'], embeddingOptions: { chunkSize: 500, chunkOverlap: 50, batchSize: 50 } },
  }
}

export function fetchRoute(href, { fakePort, realOrigin }) {
  const url = new URL(href)
  if (fakePort !== null && url.origin === `http://127.0.0.1:${fakePort}`) return 'pass'
  if (realOrigin !== null) return url.origin === realOrigin && url.pathname.startsWith('/v1/') ? 'pass' : 'refuse'
  if (fakePort !== null && url.origin === 'https://api.openai.com' && url.pathname.startsWith('/v1/')) return 'fake'
  return 'refuse'
}

export function guardFetch(originalFetch, route, policy, sink) {
  return async (input, options) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const decision = route(url.href, policy)
    if (decision === 'refuse') {
      sink.externalRequests.push(url.origin)
      throw new Error('DRIVE_EXTERNAL_FETCH_REFUSED')
    }
    if (decision === 'fake') return originalFetch(`http://127.0.0.1:${policy.fakePort}${url.pathname}`, options)
    if (policy.realOrigin === null) return originalFetch(input, options)
    const started = Date.now()
    const record = status => sink.modelRequests.push({ path: url.pathname, status, ms: Date.now() - started })
    let response
    try {
      response = await originalFetch(input, { ...options, redirect: 'manual' })
    } catch (error) {
      record(String(error?.name ?? 'error'))
      throw error
    }
    record(response.status)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      sink.externalRequests.push(location ? new URL(location, url).origin : `${url.origin}（重定向没有 Location）`)
      throw new Error('DRIVE_EXTERNAL_FETCH_REFUSED')
    }
    return response
  }
}

export function summarizeModelRequests(log) {
  const byPath = {}
  for (const entry of log) {
    const row = byPath[entry.path] ??= { count: 0, failed: 0, maxMs: 0, totalMs: 0 }
    row.count++
    if (entry.status !== 200) row.failed++
    row.maxMs = Math.max(row.maxMs, entry.ms)
    row.totalMs += entry.ms
  }
  return { count: log.length, byPath, failures: log.filter(entry => entry.status !== 200) }
}

const reasonOf = error => error?.code ?? error?.name ?? 'error'

function filesUnder(target, problems = null) {
  try {
    const stat = fs.lstatSync(target)
    if (!stat.isDirectory()) return stat.isFile() ? [target] : []
    return fs.readdirSync(target).flatMap(name => filesUnder(path.join(target, name), problems))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    if (!problems) throw error
    problems.push({ file: target, reason: reasonOf(error) })
    return []
  }
}

const stamp = file => { try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}` } catch { return null } }

const resolvedRoot = target => { try { return fs.realpathSync(target) } catch { return target } }

export function fileStamps(target) {
  return new Map(filesUnder(resolvedRoot(target)).map(file => [file, stamp(file)]))
}

export function changedFiles(target, before, problems = []) {
  return filesUnder(resolvedRoot(target), problems).filter(file => before.get(file) !== stamp(file))
}

export function redactSecret(value, secret) {
  const text = JSON.stringify(value)
  const escaped = JSON.stringify(secret).slice(1, -1)
  if (!text.includes(escaped)) return { value, redacted: false }
  return { value: JSON.parse(text.split(escaped).join('[已遮蔽]')), redacted: true }
}

export function filesContaining(targets, secret, read = fs.readFileSync) {
  if (!secret) throw new Error('要查找的密钥为空')
  const needle = Buffer.from(secret, 'utf8')
  const unreadable = []
  const files = targets.flatMap(target => filesUnder(target, unreadable))
  const hits = []
  for (const file of files) {
    try {
      if (read(file).includes(needle)) hits.push(file)
    } catch (error) {
      if (error.code !== 'ENOENT') unreadable.push({ file, reason: reasonOf(error) })
    }
  }
  return { scanned: files.length, hits, unreadable }
}

export function removePath(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    return null
  } catch (error) { return reasonOf(error) }
}

export function removeModelConfigs(canonical, remove = removePath) {
  const removed = []
  const failures = []
  for (const file of filesUnder(canonical)) {
    const name = path.basename(file)
    if (name !== 'models.json' && !name.startsWith('.models.json.')) continue
    const reason = remove(file)
    if (reason) failures.push({ file, reason })
    else removed.push(file)
  }
  return { removed, failures }
}
