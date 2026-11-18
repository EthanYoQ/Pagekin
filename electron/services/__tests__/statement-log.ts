import type Database from 'better-sqlite3'

export interface Execution { readonly source: string; readonly params: readonly unknown[] }

const METHODS = ['run', 'get', 'all', 'iterate'] as const

/** action 期间这个库句柄上执行的每条语句与它的绑定参数；同一条语句执行几次记几次。 */
export function recordExecutions<T>(db: Database.Database, action: () => T): { result: T; executions: Execution[] } {
  const statement = Object.getPrototypeOf(db.prepare('SELECT 1')) as Record<(typeof METHODS)[number], (...params: unknown[]) => unknown>
  const originals = Object.fromEntries(METHODS.map(method => [method, statement[method]])) as typeof statement
  const executions: Execution[] = []
  for (const method of METHODS) statement[method] = function (this: Database.Statement, ...params: unknown[]) {
    if (this.database === db) executions.push({ source: this.source, params })
    return originals[method].apply(this, params)
  }
  try {
    return { result: action(), executions }
  } finally {
    Object.assign(statement, originals)
  }
}

export function countBySource(executions: readonly Execution[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { source } of executions) counts[source] = (counts[source] ?? 0) + 1
  return counts
}

const READS_BINDING = /binding_json|SELECT \*\s+FROM generation_runs/iu

/**
 * 读绑定的语句落在哪些运行或根上：参数里出现的运行号、根号，加上参数里 JSON 数组列出的号。
 * 参数里既没有已知的号、也没有号的列表，按全表算（返回 'all'）。
 */
export function bindingReads(executions: readonly Execution[], knownIds: ReadonlySet<string>): { source: string; keys: ReadonlySet<string> | 'all' }[] {
  return executions.filter(execution => READS_BINDING.test(execution.source)).map(({ source, params }) => {
    const keys = new Set<string>()
    let listed = false
    for (const param of params.flatMap(value => value && typeof value === 'object' ? Object.values(value) : [value])) {
      if (typeof param !== 'string') continue
      if (knownIds.has(param)) keys.add(param)
      let parsed: unknown
      try { parsed = JSON.parse(param) } catch { continue }
      if (!Array.isArray(parsed)) continue
      listed = true
      for (const item of parsed) if (typeof item === 'string' && knownIds.has(item)) keys.add(item)
    }
    return { source, keys: keys.size || listed ? keys : 'all' }
  })
}
