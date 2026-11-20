import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMITTED_LEDGER_CELLS } from '../generation-ledger-admission'

/**
 * 跨记录（没有主键或外键条件）的账本语句要解析的 JSON 列，必须都在进门清单里：
 * 进门只保证清单里的列读得出，清单外的列坏一格就会让无关的扫描整条失败（ADR-0030）。
 * binding_json 不在清单里，只能按主键或按根解析（ADR-0030 决定 7）。
 * 这是按字符串字面量做的正则启发式：拼接出来的 SQL、跨几个字面量的语句、
 * 以及在 JS 里 JSON.parse 跨记录取出的列都查不到，所以末尾另有按文件的文本扫描兜底。
 */
const LEDGER_TABLES = ['generation_roots', 'generation_runs', 'generation_attempts', 'generation_artifacts']
const LEDGER_JSON_COLUMNS = ['action_json', 'budget_json', 'binding_json', 'attempt_json', 'usage_receipt_json', 'artifact_json', 'open_key', 'idempotency_key']
const IDENTITY_KEYS = ['open_key', 'idempotency_key']
const KEYS = ['run_id', 'root_action_id', 'attempt_id', 'artifact_id', 'open_key', 'invocation_nonce', 'reservation_id']
const ROOT = path.resolve(process.cwd())
/** 文本扫描不解析 SQL，不会漏报；新文件要读绑定，就该改走仓库的按主键或按根读法。 */
const BINDING_FILES = [
  'electron/repositories/generation-run-repository.ts', 'electron/repositories/generation-ledger-admission.ts',
  'electron/migrations/m01-generation-runs.ts', 'electron/migrations/m03-review-cycle.ts',
  'electron/services/project-archive-service.ts', 'electron/services/portable-project-field-policy.json',
  // 按主键读写；跨记录只扫进门清单里的收据列。
  'electron/services/review-proof-tidy.ts',
]

function literals(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  let i = 0, line = 1
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '\n') { line++; i++; continue }
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2), stop = end < 0 ? source.length : end + 2
      line += (source.slice(i, stop).match(/\n/gu) ?? []).length; i = stop; continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const startLine = line
      let j = i + 1, text = ''
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') { text += source[j]! + (source[j + 1] ?? ''); j += 2; continue }
        if (source[j] === '\n') { if (ch !== '`') break; line++ }
        text += source[j]; j++
      }
      out.push({ line: startLine, text }); i = j + 1; continue
    }
    i++
  }
  return out
}

const parsedColumns = (sql: string) => LEDGER_JSON_COLUMNS.filter(column =>
  new RegExp(`json_[a-z_]+\\([^)]*\\b${column}\\b`, 'iu').test(sql) || new RegExp(`\\b${column}\\s*->`, 'iu').test(sql))
/** 每张表的唯一键；整个键都等值限定了，才算只取一条记录。 */
const UNIQUE_KEYS: Record<string, string[][]> = {
  generation_roots: [['root_action_id'], ['idempotency_key']], generation_runs: [['run_id'], ['open_key']],
  generation_attempts: [['attempt_id'], ['reservation_id'], ['run_id', 'invocation_nonce']], generation_artifacts: [['artifact_id']],
}

/** 把顶层的 (SELECT …) 换成 (?) 并单独取出：子查询里的主键条件不限定外层语句。 */
function splitSubqueries(sql: string): { outer: string; subqueries: string[] } {
  const subqueries: string[] = []
  let outer = '', i = 0
  while (i < sql.length) {
    if (sql[i] === '(' && /^\(\s*SELECT\b/iu.test(sql.slice(i))) {
      let depth = 0, j = i
      for (; j < sql.length; j++) {
        if (sql[j] === '(') depth++
        else if (sql[j] === ')' && --depth === 0) break
      }
      subqueries.push(sql.slice(i + 1, j)); outer += '(?)'; i = j + 1; continue
    }
    outer += sql[i]; i++
  }
  return { outer, subqueries }
}

function crossRecordLedgerColumns(literal: string): string[] {
  const { outer, subqueries } = splitSubqueries(literal.replace(/\s+/gu, ' ').trim())
  const found = [...subqueries.flatMap(crossRecordLedgerColumns), ...outerLedgerColumns(outer)]
  return LEDGER_JSON_COLUMNS.filter(column => found.includes(column))
}

function outerLedgerColumns(sql: string): string[] {
  const touchesLedger = LEDGER_TABLES.some(table => new RegExp(`\\b${table}\\b`, 'u').test(sql))
  if (!touchesLedger && !parsedColumns(sql).length) return []
  if (!/\b(SELECT|INSERT|UPDATE|DELETE|WHERE)\b|\bjson_/iu.test(sql)) return []
  const verb = (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE)/iu.exec(sql)?.[1] ?? 'FRAGMENT').toUpperCase()
  if (verb === 'INSERT' || verb === 'CREATE') return []
  const where = / WHERE (.*)$/iu.exec(sql)?.[1]
  // 主键等值只在没有 OR 时才把语句限定到一条记录上。
  const table = /(?:^UPDATE | FROM )(generation_[a-z]+)/iu.exec(sql)?.[1]
  const keys = [['rowid'], ...table === undefined ? KEYS.map(key => [key]) : UNIQUE_KEYS[table] ?? []]
  // 联表时主键条件可能只限定了另一张表。
  const from = / FROM (.*?)(?: WHERE |$)/iu.exec(sql)?.[1] ?? ''
  const joined = /\bJOIN\b|,/iu.test(from)
  const pinned = (key: string) => new RegExp(`\\b(?:[a-z]+\\.)?${key}\\s*=\\s*(\\?|\\(\\?\\)|@[a-z]+)`, 'iu').test(where ?? '')
  const narrowed = where !== undefined && !/\bOR\b/iu.test(where)
  if (narrowed && !joined && keys.some(key => key.every(pinned))) return []
  // 绑定可以按根解析：一棵树的运行有限，读不出时仓库报封存码（ADR-0030 决定 7）。别的列按根仍算跨记录。
  // 联表时，根条件要约束到运行表：直接钉运行表的根，或经 ON 用运行表的主键或根与别的表的同名列对上。CROSS JOIN、逗号联表、ON 里带 OR 都约束不到。
  const runs = /\bgeneration_runs(?: (?:AS )?(?!(?:ON|JOIN|CROSS|LEFT|INNER)\b)([a-z]+))?/iu.exec(from)?.[1]
  const linked = !joined || (!/\bCROSS JOIN\b|,|\bOR\b/iu.test(from) && runs !== undefined
    && (new RegExp(`\\b${runs}\\.root_action_id\\s*=\\s*(\\?|\\(\\?\\)|@[a-z]+)`, 'iu').test(where ?? '')
      || new RegExp(`\\bON\\b.*\\b(?:${runs}\\.(run_id|root_action_id)\\s*=\\s*[a-z]+\\.\\1|[a-z]+\\.(run_id|root_action_id)\\s*=\\s*${runs}\\.\\2)\\b`, 'iu').test(from)))
  const byRoot = narrowed && linked && pinned('root_action_id')
  const head = /^(.*?) FROM /iu.exec(sql)?.[1] ?? ''
  // open_key、idempotency_key 是身份字符串，原样取出不算解析。
  const selected = verb !== 'SELECT' ? [] : LEDGER_JSON_COLUMNS.filter(column => !IDENTITY_KEYS.includes(column)).filter(column =>
    new RegExp(`\\b${column}\\b`, 'u').test(head.replace(/json_[a-z_]+\([^)]*\)/gu, '')) || /SELECT (?:[a-z]+\.)?\*/iu.test(head))
  return LEDGER_JSON_COLUMNS.filter(column => (parsedColumns(sql).includes(column) || selected.includes(column))
    && !(byRoot && column === 'binding_json'))
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '__tests__', 'dist', 'dist-electron', '.runtime'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (/\.(ts|tsx|mjs)$/u.test(entry.name) && !/\.(test|spec)\./u.test(entry.name)) yield full
  }
}

function violations(admitted: readonly string[]): string[] {
  return [...sourceFiles(path.join(ROOT, 'electron')), ...sourceFiles(path.join(ROOT, 'src'))].flatMap(file =>
    literals(fs.readFileSync(file, 'utf8')).flatMap(({ line, text }) => {
      const missing = crossRecordLedgerColumns(text).filter(column => !admitted.includes(column))
      return missing.length ? [`${path.relative(ROOT, file).replace(/\\/gu, '/')}:${line} ${missing.join(',')}`] : []
    }))
}

describe('跨记录解析的账本 JSON 列都在进门清单里', () => {
  const admitted = ADMITTED_LEDGER_CELLS.map(cell => cell.column)

  it('现有源码没有漏网的语句', () => {
    expect(violations(admitted)).toEqual([])
  })

  it('拦得下新写的跨记录解析，只放过按主键取数', () => {
    expect(crossRecordLedgerColumns("SELECT run_id FROM generation_runs WHERE json_extract(open_key,'$[0]')=?")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns('SELECT run_id,binding_json FROM generation_runs ORDER BY rowid')).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns("SELECT json_extract(open_key,'$[0]') FROM generation_runs WHERE run_id=?")).toEqual([])
    expect(crossRecordLedgerColumns("SELECT json_extract(open_key,'$[0]') AS k FROM generation_runs WHERE status='running'")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns("SELECT json_extract(json_extract(open_key,'$[0]'),'$[2]') AS k FROM generation_runs WHERE json_extract(binding_json,'$.a')=?")).toEqual(['binding_json', 'open_key'])
    expect(crossRecordLedgerColumns("SELECT run_id FROM generation_runs WHERE run_id=? OR json_extract(open_key,'$[0]')=?")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns("SELECT json_extract(open_key,'$[0]') FROM generation_runs WHERE root_action_id=?")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns("SELECT open_key -> '$[0]' FROM generation_runs WHERE status='running'")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns("SELECT run_id FROM generation_runs WHERE binding_json ->> '$.projectId'=?")).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns('SELECT open_key FROM generation_runs WHERE run_id=?')).toEqual([])
    expect(crossRecordLedgerColumns("SELECT json_extract(action_json,'$.status') FROM generation_roots WHERE root_action_id=?")).toEqual([])
  })

  it('函数名不分大小写；按身份键豁免要用整个唯一键；联表时主键条件不限定被解析的那张表', () => {
    expect(crossRecordLedgerColumns("SELECT JSON_EXTRACT(open_key,'$[0]') FROM generation_runs")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns('SELECT usage_receipt_json FROM generation_attempts WHERE invocation_nonce=?')).toEqual(['usage_receipt_json'])
    expect(crossRecordLedgerColumns('SELECT usage_receipt_json FROM generation_attempts WHERE run_id=? AND invocation_nonce=?')).toEqual([])
    expect(crossRecordLedgerColumns("SELECT json_extract(peer.open_key,'$[0]') FROM generation_runs r JOIN generation_runs peer ON peer.root_action_id=r.root_action_id WHERE r.run_id=?")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns("SELECT json_extract(r.open_key,'$[0]') FROM generation_roots g JOIN generation_runs r ON r.root_action_id=g.root_action_id WHERE g.root_action_id=?")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns("SELECT json_extract(r.open_key,'$[0]') FROM generation_roots g, generation_runs r WHERE g.root_action_id=?")).toEqual(['open_key'])
  })

  it('某一列退出清单时，跨记录解析它的现有语句会被报出', () => {
    expect(violations(admitted.filter(column => column !== 'usage_receipt_json')).length).toBeGreaterThan(0)
  })

  it('绑定不在清单里：只放过按主键、按 rowid、按根解析绑定的语句', () => {
    expect(admitted).not.toContain('binding_json')
    expect(crossRecordLedgerColumns("SELECT json_extract(binding_json,'$.a') FROM generation_runs WHERE root_action_id=?")).toEqual([])
    expect(crossRecordLedgerColumns('SELECT a.usage_receipt_json, r.binding_json FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id WHERE a.root_action_id=?')).toEqual(['usage_receipt_json'])
    expect(crossRecordLedgerColumns("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.a',?) WHERE rowid=?")).toEqual([])
    expect(crossRecordLedgerColumns("SELECT json_extract(binding_json,'$.a') FROM generation_runs WHERE root_action_id=? OR status='running'")).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns("SELECT r.binding_json FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id WHERE json_extract(a.usage_receipt_json,'$.d')=?")).toEqual(['binding_json', 'usage_receipt_json'])
    expect(crossRecordLedgerColumns("SELECT json_extract(r.binding_json,'$.a') FROM generation_roots g JOIN generation_runs r ON r.root_action_id=g.root_action_id WHERE g.root_action_id=?")).toEqual([])
  })

  it('按根豁免要求根条件经联表约束到读绑定的那张表上', () => {
    expect(crossRecordLedgerColumns('SELECT r.binding_json FROM generation_roots g CROSS JOIN generation_runs r WHERE g.root_action_id=?')).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns('SELECT r.binding_json FROM generation_roots g, generation_runs r WHERE g.root_action_id=?')).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns('SELECT r.binding_json FROM generation_roots g JOIN generation_runs r ON g.status=? WHERE g.root_action_id=?')).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns('SELECT r.binding_json FROM generation_roots g JOIN generation_runs r ON r.status=g.blocked_code WHERE g.root_action_id=?')).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns('SELECT r.binding_json FROM generation_roots g JOIN generation_runs r ON r.status=g.blocked_code WHERE r.root_action_id=?')).toEqual([])
    expect(crossRecordLedgerColumns("SELECT r.binding_json FROM generation_roots g JOIN generation_runs r ON r.root_action_id=g.root_action_id OR r.status='running' WHERE g.root_action_id=?")).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns("SELECT json_extract(binding_json,'$.a') FROM generation_runs WHERE run_id=(run_id)")).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns("SELECT json_extract(binding_json,'$.a') FROM generation_runs WHERE root_action_id=(root_action_id)")).toEqual(['binding_json'])
  })

  it('子查询里的主键条件不限定外层语句', () => {
    expect(crossRecordLedgerColumns("SELECT json_extract(open_key,'$[0]') FROM generation_runs WHERE root_action_id=(SELECT root_action_id FROM generation_runs WHERE run_id=?)")).toEqual(['open_key'])
    expect(crossRecordLedgerColumns("SELECT run_id FROM generation_runs WHERE run_id=(SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.a')=?)")).toEqual(['binding_json'])
    expect(crossRecordLedgerColumns("SELECT json_extract(binding_json,'$.a') FROM generation_runs WHERE root_action_id=(SELECT root_action_id FROM generation_runs WHERE run_id=?)")).toEqual([])
  })

  it('binding_json 这个词只出现在仓库、进门、M01、M03、导出投影和打开时的证明整理里', () => {
    const files = [...sourceFiles(path.join(ROOT, 'electron')), ...sourceFiles(path.join(ROOT, 'src')), path.join(ROOT, 'electron/services/portable-project-field-policy.json')]
    const users = files.filter(file => fs.readFileSync(file, 'utf8').includes('binding_json'))
      .map(file => path.relative(ROOT, file).replace(/\\/gu, '/'))
    expect(users.filter(file => !BINDING_FILES.includes(file))).toEqual([])
  })
})
