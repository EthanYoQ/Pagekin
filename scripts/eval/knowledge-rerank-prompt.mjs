const REQUEST_FAILURES = new Set(["timeout", "request-failed", "http-error", "invalid-response"])

const COVERAGE_MAX_WORSE = 0.2
const HEALTH_MAX_FAILURE_RATE = 0.05
const HEALTH_MAX_P95_MS = 3000
const FTS_MIN_NDCG_GAIN = 0.1
const FTS_MIN_NOT_WORSE = 0.7
const FTS_MIN_DISTRACTOR_DROP = 0.3
const VECTOR_MAX_WORSE = 0.2
export const PRODUCTION_BUDGET = "production-default"

export function promptBudgets({ DEFAULT_MATERIAL_ADMISSION, materialBudgetFrom }) {
  return {
    [PRODUCTION_BUDGET]: DEFAULT_MATERIAL_ADMISSION,
    tight: { kind: "budget", budget: materialBudgetFrom({ contextWindowTokens: 1500, contextWindowSource: "manual", reservedOutputTokens: 0, safetyMarginTokens: 0 }) },
  }
}

/** 片段的渲染模板与 generate-draft.command.ts 一致；裁剪全部交给生产的 assemble。 */
export async function finalPromptCoverage(assemble, { ranked, requiredFacts, chapterInfo, admission }) {
  const assembly = await assemble({
    identity: { projectId: "knowledge-rerank-eval", epoch: "knowledge-rerank-eval" },
    writingLanguage: "zh-CN",
    authorProjectFacts: [],
    characterProfiles: "",
    futurePlans: "（无后续蓝图）",
    references: ranked.map((passage, index) => ({
      text: passage.text,
      rendered: `[${index + 1}] (${passage.fileName}, 相关度 ${(passage.score * 100).toFixed(0)}%)\n${passage.text}`,
      deduplicateAgainstFinalized: true,
      knowledgeRank: index + 1,
    })),
    finalized: [],
    candidates: [],
    relevanceTerms: [chapterInfo.title, chapterInfo.keyEvents, ...chapterInfo.characters],
    admission,
    nonMaterialUnits: 0,
  })
  const factsInPrompt = requiredFacts.filter(fact => assembly.text.includes(fact.text)).length
  return {
    coverage: requiredFacts.length ? factsInPrompt / requiredFacts.length : 0,
    factsInPrompt,
    factsTotal: requiredFacts.length,
    passagesOffered: ranked.length,
    passagesInPrompt: assembly.selection.included.filter(material => material.ref.sourceId.startsWith("reference:")).length,
  }
}

export async function timedRank(rank) {
  const started = performance.now()
  const { items, ranking } = await rank()
  return { items, call: { method: ranking.method, ...(ranking.method === "original" ? { reason: ranking.reason } : {}), latencyMs: performance.now() - started } }
}

function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.ceil(fraction * sorted.length) - 1] : null
}

export function rerankHealth(calls) {
  const requests = calls.filter(call => call.method === "rerank" || REQUEST_FAILURES.has(call.reason))
  const failures = requests.filter(call => call.method === "original")
  const latencies = requests.map(call => call.latencyMs).sort((a, b) => a - b)
  return {
    requests: requests.length,
    failures: failures.length,
    failureRate: requests.length ? failures.length / requests.length : 0,
    failureReasons: Object.fromEntries([...new Set(failures.map(call => call.reason))].map(reason => [reason, failures.filter(call => call.reason === reason).length])),
    latencyMs: { samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  }
}

const average = values => values.reduce((sum, value) => sum + value, 0) / values.length

function spread(values) {
  return { mean: average(values), min: Math.min(...values), max: Math.max(...values) }
}

function pooledFraction(counts, key) {
  const total = counts.reduce((sum, item) => sum + item.win + item.tie + item.loss, 0)
  return counts.reduce((sum, item) => sum + item[key], 0) / total
}

function countOutcomes(outcomes) {
  return Object.fromEntries(["win", "tie", "loss"].map(outcome => [outcome, outcomes.filter(item => item === outcome).length]))
}

function coverageAcrossRuns(receipts, budget) {
  const perRun = receipts.map(receipt => {
    const rows = receipt.queries.map(row => row.promptCoverage[budget])
    return {
      original: average(rows.map(row => row.original.coverage)),
      rerank: average(rows.map(row => row.rerank.coverage)),
      outcomes: countOutcomes(rows.map(row => row.outcome)),
      trimmedOriginal: rows.filter(row => row.original.passagesInPrompt < row.original.passagesOffered).length,
      trimmedRerank: rows.filter(row => row.rerank.passagesInPrompt < row.rerank.passagesOffered).length,
    }
  })
  const outcomes = perRun.map(run => run.outcomes)
  const original = spread(perRun.map(run => run.original))
  const rerank = spread(perRun.map(run => run.rerank))
  return {
    original,
    rerank,
    delta: spread(perRun.map(run => run.rerank - run.original)),
    outcomesPerRun: outcomes,
    worseFraction: pooledFraction(outcomes, "loss"),
    queriesTrimmedPerRun: { original: perRun.map(run => run.trimmedOriginal), rerank: perRun.map(run => run.trimmedRerank) },
  }
}

function retrievalRule(group, retrieval, outcomes) {
  const gain = retrieval["nDCG@5"].rerank.mean - retrieval["nDCG@5"].original.mean
  const worse = pooledFraction(outcomes, "loss")
  if (group === "vector") return { pass: gain >= 0 && worse <= VECTOR_MAX_WORSE, nDCGGain: gain, worseFraction: worse }
  const before = retrieval["Distractor@5"].original.mean
  const distractorDrop = before > 0 ? (before - retrieval["Distractor@5"].rerank.mean) / before : 0
  return {
    pass: gain >= FTS_MIN_NDCG_GAIN && 1 - worse >= FTS_MIN_NOT_WORSE && distractorDrop >= FTS_MIN_DISTRACTOR_DROP,
    nDCGGain: gain, notWorseFraction: 1 - worse, distractorDrop,
  }
}

export function aggregateReceipts(receipts) {
  const [first] = receipts
  const retrieval = Object.fromEntries(Object.keys(first.summary).map(key => [key, {
    original: spread(receipts.map(receipt => receipt.summary[key])),
    rerank: spread(receipts.map(receipt => receipt.rerankSummary[key])),
  }]))
  const promptCoverage = Object.fromEntries(Object.keys(first.queries[0].promptCoverage).map(budget => [budget, coverageAcrossRuns(receipts, budget)]))
  const health = rerankHealth(receipts.flatMap(receipt => receipt.queries.map(row => row.rerank.call)))
  const rules = {
    retrieval: retrievalRule(first.group, retrieval, receipts.map(receipt => receipt.rerankOutcomes)),
    promptCoverage: Object.fromEntries(Object.entries(promptCoverage).map(([budget, item]) => [budget, {
      pass: item.rerank.mean > item.original.mean && item.worseFraction <= COVERAGE_MAX_WORSE,
      delta: item.rerank.mean - item.original.mean,
      worseFraction: item.worseFraction,
    }])),
    health: { pass: health.requests > 0 && health.failureRate <= HEALTH_MAX_FAILURE_RATE && health.latencyMs.p95 <= HEALTH_MAX_P95_MS },
  }
  return {
    schemaVersion: 1,
    kind: "knowledge-rerank-aggregate",
    group: first.group,
    repetitions: receipts.length,
    fixture: first.fixture,
    models: first.models,
    metricDefinitions: first.metricDefinitions,
    decisionRules: first.decisionRules,
    retrieval,
    rerankOutcomesPerRun: receipts.map(receipt => receipt.rerankOutcomes),
    promptCoverage,
    rerankHealth: health,
    rules: {
      ...rules,
      ...(first.group === "vector" ? { recommendAutoReuse: rules.retrieval.pass && rules.promptCoverage[PRODUCTION_BUDGET].pass && rules.health.pass } : {}),
    },
  }
}
