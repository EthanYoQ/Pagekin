import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMITTED_LEDGER_CELLS } from '../generation-ledger-admission'

/**
 * 跨记录（没有主键或外键条件）的账本语句要解析的 JSON 列，必须都在进门清单里：
 * 进门只保证清单里的列读得出，清单外的列坏一格就会让无关的扫描整条失败（ADR-0030）。
 */
const LEDGER_TABLES = ['generation_roots', 'generation_runs', 'generation_attempts', 'generation_artifacts']
const LEDGER_JSON_COLUMNS = ['action_json', 'budget_json', 'binding_json', 'attempt_json', 'usage_receipt_json', 'artifact_json', 'open_key', 'idempotency_key']
const IDENTITY_KEYS = ['open_key', 'idempotency_key']
const KEYS = ['run_id', 'root_action_id', 'attempt_id', 'artifact_id', 'open_key', 'invocation_nonce', 'reservation_id']
const ROOT = path.resolve(process.cwd())

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
  new RegExp(`json_[a-z_]+\\([^)]*\\b${column}\\b`, 'u').test(sql) || new RegExp(`\\b${column}\\s*->`, 'u').test(sql))
const UNIQUE_KEYS: Record<string, string[]> = {
  generation_roots: ['root_action_id', 'idempotency_key'], generation_runs: ['run_id', 'open_key'],
  generation_attempts: ['attempt_id', 'reservation_id', 'invocation_nonce'], generation_artifacts: ['artifact_id'],
}

function crossRecordLedgerColumns(literal: string): string[] {
  const sql = literal.replace(/\s+/gu, ' ').trim()
  const touchesLedger = LEDGER_TABLES.some(table => new RegExp(`\\b${table}\\b`, 'u').test(sql))
  if (!touchesLedger && !parsedColumns(sql).length) return []
  if (!/\b(SELECT|INSERT|UPDATE|DELETE|WHERE|json_)\b/u.test(sql)) return []
  const verb = (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE)/iu.exec(sql)?.[1] ?? 'FRAGMENT').toUpperCase()
  if (verb === 'INSERT' || verb === 'CREATE') return []
  const where = / WHERE (.*)$/iu.exec(sql)?.[1]
  // 主键等值只在没有 OR 时才把语句限定到一条记录上。
  const table = /(?:^UPDATE | FROM )(generation_[a-z]+)/iu.exec(sql)?.[1]
  const keys = table === undefined ? KEYS : UNIQUE_KEYS[table] ?? []
  if (where !== undefined && !/\bOR\b/iu.test(where) && keys.some(key => new RegExp(`\\b(?:[a-z]+\\.)?${key}\\s*=\\s*(\\?|\\()`, 'u').test(where))) return []
  const head = /^(.*?) FROM /iu.exec(sql)?.[1] ?? ''
  // open_key、idempotency_key 是身份字符串，原样取出不算解析。
  const selected = verb !== 'SELECT' ? [] : LEDGER_JSON_COLUMNS.filter(column => !IDENTITY_KEYS.includes(column)).filter(column =>
    new RegExp(`\\b${column}\\b`, 'u').test(head.replace(/json_[a-z_]+\([^)]*\)/gu, '')) || /SELECT (?:[a-z]+\.)?\*/iu.test(head))
  return LEDGER_JSON_COLUMNS.filter(column => parsedColumns(sql).includes(column) || selected.includes(column))
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

  it('某一列退出清单时，跨记录解析它的现有语句会被报出', () => {
    expect(violations(admitted.filter(column => column !== 'binding_json')).length).toBeGreaterThan(0)
  })
})
