import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rankPassages } from '../../electron/rerank'
import { DEFAULT_MATERIAL_ADMISSION, materialBudgetFrom } from '../../src/shared/generation-owner-contract'
import { assembleChapterMaterials } from '../../src/services/workflows/chapter-materials'
import { finalPromptCoverage, identityRank, promptBudgets, rerankHealth, timedRank } from '../eval/knowledge-rerank-prompt.mjs'

const script = path.resolve(__dirname, '../eval/knowledge-rerank.mjs')
const budgets = promptBudgets({ DEFAULT_MATERIAL_ADMISSION, materialBudgetFrom })
const chapterInfo = { title: '铁匣', keyEvents: '沈砚打开铁匣', characters: ['沈砚'] }

const passage = (id: string, filler = '盐河的风吹过渡口，') => ({
  paragraphSha256: id,
  text: `段落${id}。${filler.repeat(Math.ceil(330 / filler.length))}`.slice(0, 340),
  fileName: `${id}.md`,
  score: 0.5,
})
const fact = ({ paragraphSha256, text }: { paragraphSha256: string; text: string }) => ({ paragraphSha256, text })
const coverage = (ranked: ReturnType<typeof passage>[], requiredFacts: { paragraphSha256: string; text: string }[], budget: keyof typeof budgets) =>
  finalPromptCoverage(assembleChapterMaterials, { ranked, requiredFacts, chapterInfo, admission: budgets[budget] })

describe('最终提示词必要事实覆盖率', () => {
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id => passage(id))

  it('预算够时，排在第 5 的等级 2 段落也进提示词，不发生裁剪', async () => {
    const result = await coverage([b, c, d, e, a], [fact(a)], 'production-default')
    expect(result).toMatchObject({ coverage: 1, factsInPrompt: 1, factsTotal: 1, passagesOffered: 5, passagesInPrompt: 5 })
  })

  it('小窗口裁掉排在后面的等级 2 段落时覆盖率下降，排到前面就保住', async () => {
    const dropped = await coverage([b, c, d, e, a], [fact(a)], 'tight')
    expect(dropped.coverage).toBe(0)
    expect(dropped.passagesInPrompt).toBeLessThan(5)
    expect((await coverage([a, b, c, d, e], [fact(a)], 'tight')).coverage).toBe(1)
  })

  it('两条必要事实只进一条时覆盖率是一半', async () => {
    expect((await coverage([a, b, c, d, e], [fact(a), fact(e)], 'tight')).coverage).toBe(0.5)
  })

  it('不在排序结果里的必要事实不算进提示词', async () => {
    expect((await coverage([b, c], [fact(a)], 'production-default')).coverage).toBe(0)
  })

  it('裁剪按知识库排名走，不被字面相关词命中数改写', async () => {
    const literalHit = ['p', 'q', 'r', 's'].map(id => passage(id, '沈砚打开铁匣，铁匣里只有灰，'))
    const top = passage('top')
    expect((await coverage([top, ...literalHit], [fact(top)], 'tight')).coverage).toBe(1)
  })
})

describe('重排失败不中断评估', () => {
  let server: Server
  let baseUrl: string
  beforeEach(async () => {
    server = createServer((_req, res) => { res.statusCode = 500; res.end('boom') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await new Promise(resolve => server.close(resolve))
  })

  it('真实重排请求失败时返回原顺序，并计入失败比例', async () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => passage(id))
    const config = { kind: 'reuse-embedding', endpoint: { baseUrl, apiKey: 'k', modelName: 'm' } } as const
    const { items, call } = await timedRank(() => rankPassages('查询', candidates, config, 5))
    expect(items.map(item => item.paragraphSha256)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(call).toMatchObject({ method: 'original', reason: 'http-error' })
    expect(rerankHealth([call])).toMatchObject({ requests: 1, failures: 1, failureRate: 1 })
  })
})

describe('重排健康度', () => {
  const ok = (latencyMs: number) => ({ method: 'rerank', latencyMs })

  it('P50、P95 取排序后的最近秩，样本数一并给出', () => {
    const health = rerankHealth(Array.from({ length: 20 }, (_, index) => ok(index + 1)))
    expect(health).toMatchObject({ requests: 20, failures: 0, failureRate: 0, latencyMs: { samples: 20, p50: 10, p95: 19 } })
  })

  it('原序对照不发请求，不进健康度统计', async () => {
    const { items, call } = await identityRank([passage('a'), passage('b')], 1)
    expect(items.map(item => item.paragraphSha256)).toEqual(['a'])
    expect(rerankHealth([call])).toMatchObject({ requests: 0, failures: 0, latencyMs: { samples: 0 } })
  })

  it('没有发请求的回退（无候选）不算失败，也不进延迟样本', () => {
    const health = rerankHealth([ok(10), { method: 'original', reason: 'no-candidates', latencyMs: 0 }])
    expect(health).toMatchObject({ requests: 1, failures: 0, latencyMs: { samples: 1 } })
  })
})

const judgedRow = (id: string, covered: { original: number; rerank: number }, latencyMs = 100, method = 'rerank') => ({
  id,
  metrics: { 'nDCG@5': 0.2, 'Distractor@5': 0.4 },
  rerank: { metrics: { 'nDCG@5': 0.4, 'Distractor@5': 0.2 }, outcome: 'win', call: { method, ...(method === 'rerank' ? {} : { reason: 'timeout' }), latencyMs } },
  promptCoverage: { 'production-default': {
    original: { coverage: covered.original, passagesOffered: 5, passagesInPrompt: 5 },
    rerank: { coverage: covered.rerank, passagesOffered: 5, passagesInPrompt: 5 },
    outcome: covered.rerank > covered.original ? 'win' : covered.rerank < covered.original ? 'loss' : 'tie',
  } },
})
const receiptOf = (group: string, rows: ReturnType<typeof judgedRow>[]) => ({
  schemaVersion: 1,
  kind: 'knowledge-rerank-eval',
  group,
  fixture: { sha256: { corpus: 'c' }, queries: rows.length },
  models: { embedding: 'm', rerank: { name: 'r', model: 'r' } },
  summary: { 'nDCG@5': 0.2, 'Distractor@5': 0.4 },
  rerankSummary: { 'nDCG@5': 0.4, 'Distractor@5': 0.2 },
  rerankOutcomes: { win: rows.length, tie: 0, loss: 0 },
  decisionRules: {},
  queries: rows,
})

describe('knowledge-rerank aggregate 汇总多次重复并逐条判定', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'knowledge-rerank-aggregate-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function aggregate(receipts: unknown[]) {
    const files = receipts.map((receipt, index) => {
      const file = path.join(dir, `r${index}.json`)
      writeFileSync(file, JSON.stringify(receipt))
      return file
    })
    const out = path.join(dir, 'out.json')
    const child = spawnSync(process.execPath, [script, 'aggregate', ...files, '--out', out], { encoding: 'utf8' })
    return { status: child.status, stderr: child.stderr, out: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null }
  }
  const rows = (losses: number, wins = 10 - losses) => [
    ...Array.from({ length: wins }, (_, index) => judgedRow(`w${index}`, { original: 0, rerank: 1 })),
    ...Array.from({ length: losses }, (_, index) => judgedRow(`l${index}`, { original: 1, rerank: 0 })),
  ]

  it('重排覆盖率更高、变差不超过 20% 时规则通过，并报告重复次数与波动', () => {
    const result = aggregate([receiptOf('vector', rows(2)), receiptOf('vector', rows(1))])
    expect(result.status).toBe(0)
    expect(result.out.repetitions).toBe(2)
    expect(result.out.promptCoverage['production-default']).toMatchObject({
      original: { min: 0.1, max: 0.2 },
      rerank: { min: 0.8, max: 0.9 },
      worseFraction: 0.15,
    })
    expect(result.out.rules.promptCoverage['production-default'].pass).toBe(true)
    expect(result.out.rules.recommendAutoReuse).toBe(true)
  })

  it('变差的查询超过 20% 时覆盖率规则不过，向量组不建议打开', () => {
    const result = aggregate([receiptOf('vector', rows(4, 6))])
    expect(result.out.rules.promptCoverage['production-default'].pass).toBe(false)
    expect(result.out.rules.recommendAutoReuse).toBe(false)
  })

  it('失败比例超过 5% 时健康度不过', () => {
    const failing = [...rows(0, 9), judgedRow('t', { original: 0, rerank: 1 }, 10000, 'original')]
    const result = aggregate([receiptOf('vector', failing)])
    expect(result.out.rerankHealth).toMatchObject({ requests: 10, failures: 1 })
    expect(result.out.rules.health.pass).toBe(false)
  })

  it('P95 超过 3 秒时健康度不过', () => {
    const slow = [...rows(0, 9), judgedRow('s', { original: 0, rerank: 1 }, 3500)]
    expect(aggregate([receiptOf('vector', slow)]).out.rules.health.pass).toBe(false)
  })

  it('全文组不给自动复用建议', () => {
    expect(aggregate([receiptOf('fts', rows(0))]).out.rules.recommendAutoReuse).toBeUndefined()
  })

  it('夹具不同的收据拒绝汇总，不写结果', () => {
    const other = { ...receiptOf('vector', rows(0)), fixture: { sha256: { corpus: 'x' }, queries: 10 } }
    const result = aggregate([receiptOf('vector', rows(0)), other])
    expect(result.status).not.toBe(0)
    expect(result.out).toBeNull()
  })
})
