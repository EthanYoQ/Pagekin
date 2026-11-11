import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import { closeProjectDatabase } from '../database'
import { importText, searchKnowledgeFTS } from '../knowledge-base'
import { captureGenerationKnowledge } from '../services/generation-knowledge-source'
import { getProjectDataRoot } from '../services/project-data-locator'
import { addChunks, closeConnection } from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

const model = { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }
const FERRIES = '渡口连着渡口，渡口外还是渡口。'
const LEDGER = '账本压在一摞旧书底下，没人翻过，纸页已经发黄。'
const COLD = '渡口很冷。'
const BOAT = '渡口有船。'
const QUERY = '渡口 账本'
const roots: string[] = []

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) {
    closeConnection(root)
    await removeDirectoryWithWindowsRetry(root)
  }
})

async function rankings(projectPath: string) {
  const search = await searchKnowledgeFTS(QUERY, projectPath, 10, ['reference'])
  const generation = await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query: QUERY, topK: 10 })
  return { search: search.map(hit => hit.text), generation: generation.items.map(item => item.text) }
}

it('ranks usable material the same after a long reference novel is imported', async () => {
  fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true })
  const projectPath = fs.mkdtempSync(path.resolve('.runtime/.cache', 'kb-corpus-size-'))
  roots.push(projectPath)
  openCanonicalProjectFixture(projectPath)
  for (const [index, text] of [FERRIES, LEDGER, COLD, BOAT].entries()) {
    expect((await importText(text, `第${index + 1}章 正文.md`, projectPath, 'openai', model)).success).toBe(true)
  }
  const expected = [LEDGER, FERRIES, COLD, BOAT]
  expect(await rankings(projectPath)).toEqual({ search: expected, generation: expected })

  const novel = Array.from({ length: 40 }, (_, index) => `第${index + 1}回，山里下着雨，没人说话。`)
  expect((await addChunks(projectPath, 'reference-novel', '参考小说.txt', novel, undefined, undefined, { corpusKind: 'reference' })).success).toBe(true)

  expect(await rankings(projectPath)).toEqual({ search: expected, generation: expected })
})
