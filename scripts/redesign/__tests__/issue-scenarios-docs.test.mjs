import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))

const redesign = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docs = path.resolve(redesign, '../../.claude/skills/verify/references/issue-scenarios')

it('issue-scenarios/<短名>.md 表里的每个场景都定义在 <短名>-scenarios.mjs', async () => {
  const misplaced = []
  for (const doc of fs.readdirSync(docs).filter(name => name.endsWith('.md'))) {
    const short = doc.slice(0, -'.md'.length)
    const module = await import(pathToFileURL(path.join(redesign, `${short}-scenarios.mjs`)).href)
    const defined = Object.entries(module).filter(([name]) => name.endsWith('_SCENARIOS')).flatMap(([, table]) => Object.keys(table))
    const isDefined = name => name.endsWith('*') ? defined.some(key => key.startsWith(name.slice(0, -1))) : defined.includes(name)
    const nameCells = fs.readFileSync(path.join(docs, doc), 'utf8').split('\n').filter(line => line.startsWith('| `')).map(line => line.split(' | ')[0])
    for (const cell of nameCells) {
      for (const [, name] of cell.matchAll(/`([^`]+)`/g)) if (!isDefined(name)) misplaced.push(`${doc}: ${name}`)
    }
  }
  assert.deepEqual(misplaced, [])
})
