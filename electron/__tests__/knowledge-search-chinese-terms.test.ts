import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import { closeProjectDatabase } from '../database'
import { importText, searchKnowledgeFTS } from '../knowledge-base'
import { captureGenerationKnowledge } from '../services/generation-knowledge-source'
import { getProjectDataRoot } from '../services/project-data-locator'
import { closeConnection } from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

const model = { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }
const roots: string[] = []

async function searchProject(texts: readonly string[], query: string, topK = 10) {
  fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true })
  const projectPath = fs.mkdtempSync(path.resolve('.runtime/.cache', 'kb-zh-terms-'))
  roots.push(projectPath)
  openCanonicalProjectFixture(projectPath)
  for (const [index, text] of texts.entries()) {
    expect((await importText(text, `第${index + 1}章 正文.md`, projectPath, 'openai', model)).success).toBe(true)
  }
  const search = (await searchKnowledgeFTS(query, projectPath, topK)).map(hit => hit.text)
  const generation = (await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query, topK })).items.map(item => item.text)
  closeProjectDatabase()
  return { search, generation }
}

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) {
    closeConnection(root)
    await removeDirectoryWithWindowsRetry(root)
  }
})

describe('full-text knowledge search without a retrieval model', () => {
  it('finds passages that share only a word with a Chinese query', async () => {
    const ferry = '渡口边停着一条旧船。', ledger = '账本上少了三页。', rain = '山里下着雨。'
    const { search, generation } = await searchProject([ferry, ledger, rain], '渡口的账本')
    expect(new Set(search)).toEqual(new Set([ferry, ledger]))
    expect(new Set(generation)).toEqual(new Set([ferry, ledger]))
  })

  it('matches English and numbers as whole words', async () => {
    const lantern = 'The Lantern of 2049 burns.', lancet = 'The Lancet of 2048 cuts.'
    expect(await searchProject([lantern, lancet], 'Lantern')).toEqual({ search: [lantern], generation: [lantern] })
    expect(await searchProject([lantern, lancet], '2049')).toEqual({ search: [lantern], generation: [lantern] })
  })

  it('ranks the same way in knowledge search and generation material', async () => {
    const { search, generation } = await searchProject([
      '盐引藏在渡口的木箱里，渡口的船夫不知情。',
      '账本记着盐引的去向。',
      '渡口很冷。',
      '账本、盐引、渡口，三样东西都指向知县。',
      '山里下着雨，没人说话。',
    ], '渡口 账本 盐引')
    expect(search).toHaveLength(4)
    expect(generation).toEqual(search)
  })

  it('keeps tied results in the same order however the documents were imported', async () => {
    const tied = ['灯塔甲号在北。', '灯塔乙号在南。', '灯塔丙号在东。', '灯塔丁号在西。', '灯塔戊号在中。', '灯塔己号在外。']
    const forward = await searchProject(tied, '灯塔')
    const backward = await searchProject([...tied].reverse(), '灯塔')

    expect(forward.search).toHaveLength(tied.length)
    expect(backward).toEqual(forward)
    expect(forward.generation).toEqual(forward.search)
  })
})
