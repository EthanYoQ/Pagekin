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
import type { EmbeddingOptions } from '../../src/shared/embedding-options'

const model = { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }
const roots: string[] = []

async function searchFiles(files: readonly (readonly [fileName: string, text: string])[], query: string, topK: number, embeddingOptions?: EmbeddingOptions) {
  fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true })
  const projectPath = fs.mkdtempSync(path.resolve('.runtime/.cache', 'kb-zh-terms-'))
  roots.push(projectPath)
  openCanonicalProjectFixture(projectPath)
  for (const [fileName, text] of files) {
    expect((await importText(text, fileName, projectPath, 'openai', { ...model, embeddingOptions })).success).toBe(true)
  }
  const search = await searchKnowledgeFTS(query, projectPath, topK)
  const generation = (await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query, topK })).items
  closeProjectDatabase()
  return { search, generation }
}

async function searchProject(texts: readonly string[], query: string, topK = 10) {
  const { search, generation } = await searchFiles(texts.map((text, index) => [`第${index + 1}章 正文.md`, text] as const), query, topK)
  return { search: search.map(hit => hit.text), generation: generation.map(item => item.text) }
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

  it('finds a capitalized word when the query repeats it in lower case', async () => {
    const lantern = 'The Lantern of 2049 burns.'
    expect(await searchProject([lantern], 'Lantern lantern')).toEqual({ search: [lantern], generation: [lantern] })
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

  it('picks the same source for identical passages however the files were imported', async () => {
    const files = [['第1章 北岸.md', '灯塔在雾里亮着。'], ['第2章 南岸.md', '灯塔在雾里亮着。']] as const
    const forward = await searchFiles(files, '灯塔', 1)
    const backward = await searchFiles([...files].reverse(), '灯塔', 1)

    for (const result of [forward, backward]) {
      expect(result.search.map(hit => hit.fileName)).toEqual(['第1章 北岸.md'])
      expect(result.generation.map(item => item.fileName)).toEqual(['第1章 北岸.md'])
    }
  })

  it('does not spend two result slots on a passage repeated within one file', async () => {
    const refrain = '灯塔亮着'.repeat(25)
    const files = [['第1章 北岸.md', refrain + refrain], ['第2章 南岸.md', '灯塔。']] as const
    const { search, generation } = await searchFiles(files, '灯塔', 2, { chunkSize: 100, chunkOverlap: 0, batchSize: 50 })

    expect(search.map(hit => [hit.fileName, hit.text])).toEqual([['第1章 北岸.md', refrain], ['第2章 南岸.md', '灯塔。']])
    expect(generation.map(item => [item.fileName, item.text])).toEqual([['第1章 北岸.md', refrain], ['第2章 南岸.md', '灯塔。']])
  })
})
