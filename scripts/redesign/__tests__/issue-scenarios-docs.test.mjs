import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
const { isScenarioTable } = await import('../drive.mjs')

const redesign = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const references = path.resolve(redesign, '../../.claude/skills/verify/references')
const docs = path.join(references, 'issue-scenarios')
const PAGE_DOCS = ['rd-stage-scenarios.md', 'rd-review-scenarios.md', 'baseline-scenarios.md']
const PLATFORM_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

function tableRows(lines) {
  return lines.filter(line => line.startsWith('| `')).map(line => ({ line, names: [...line.split(' | ')[0].matchAll(/`([^`]+)`/g)].map(([, name]) => name) }))
}

async function readDocs() {
  const result = []
  for (const doc of fs.readdirSync(docs).filter(name => name.endsWith('.md'))) {
    const short = doc.slice(0, -'.md'.length)
    const module = await import(pathToFileURL(path.join(redesign, `${short}-scenarios.mjs`)).href)
    const defined = Object.fromEntries(Object.entries(module).filter(([name]) => isScenarioTable(name)).flatMap(([, table]) => Object.entries(table)))
    const matching = name => Object.keys(defined).filter(key => name.endsWith('*') ? key.startsWith(name.slice(0, -1)) : key === name)
    const lines = fs.readFileSync(path.join(docs, doc), 'utf8').split('\n')
    const header = lines.slice(0, lines.findIndex(line => line.startsWith('| '))).join('\n')
    const rows = tableRows(lines).map(({ line, names }) => ({ line, names, scenarios: names.flatMap(matching).map(key => defined[key]) }))
    result.push({ doc, header, rows, matching, defined })
  }
  return result
}

function prerequisiteTexts(scenario) {
  const { env = {}, platform, theme } = scenario.requires ?? {}
  return [...Object.keys(env), ...(platform ? [`只在 ${PLATFORM_NAMES[platform]}`] : []), ...(theme ? [`--theme ${theme}`] : [])]
}

it('issue-scenarios/<短名>.md 表里的每个场景都定义在 <短名>-scenarios.mjs', async () => {
  const misplaced = (await readDocs()).flatMap(({ doc, rows, matching }) =>
    rows.flatMap(({ names }) => names.filter(name => matching(name).length === 0).map(name => `${doc}: ${name}`)))
  assert.deepEqual(misplaced, [])
})

it('有 issue-scenarios/<短名>.md 的模块，定义的每个场景都在该文件或页面场景表里有说明行', async () => {
  const pageNames = PAGE_DOCS.flatMap(doc => tableRows(fs.readFileSync(path.join(references, doc), 'utf8').split('\n'))).flatMap(({ names }) => names)
  const undocumented = (await readDocs()).flatMap(({ doc, rows, matching, defined }) => {
    const documented = new Set([...rows, { names: pageNames }].flatMap(({ names }) => names.flatMap(matching)))
    return Object.keys(defined).filter(key => !documented.has(key)).map(key => `${doc}: ${key}`)
  })
  assert.deepEqual(undocumented, [])
})

it('场景 requires 声明的平台、环境变量、主题都写进说明：写在那一行，全文件场景共有时可写在文件头', async () => {
  const missing = []
  for (const { doc, header, rows } of await readDocs()) {
    const perScenario = rows.flatMap(({ scenarios }) => scenarios).map(prerequisiteTexts)
    const shared = perScenario.length ? perScenario.reduce((common, texts) => common.filter(text => texts.includes(text))) : []
    for (const { line, names, scenarios } of rows) {
      for (const text of new Set(scenarios.flatMap(prerequisiteTexts))) {
        if (!line.includes(text) && !(shared.includes(text) && header.includes(text))) missing.push(`${doc} ${names.join('、')}: 缺「${text}」`)
      }
    }
  }
  assert.deepEqual(missing, [])
})
