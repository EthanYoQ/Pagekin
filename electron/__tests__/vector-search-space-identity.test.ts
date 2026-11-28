import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import { addChunks, closeConnection, search } from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

const modelA = { modelFingerprint: 'openai|https://a.example|emb-a', distanceMetric: 'l2' }
const storedVector = Array.from({ length: 8 }, (_, i) => i / 8)
const queryVector = Array.from({ length: 8 }, (_, i) => (8 - i) / 8)
// 查询词与正文没有全文交集：命中只可能来自向量检索。
const NO_TEXT_MATCH = 'zzzz'

describe('向量检索必须带空间身份', () => {
  const projects: string[] = []
  afterEach(async () => {
    for (const project of projects.splice(0)) {
      closeConnection(project)
      await removeDirectoryWithWindowsRetry(project)
    }
  })

  function newProject(): string {
    fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true })
    const project = fs.mkdtempSync(path.resolve('.runtime/.cache', 'vector-identity-'))
    projects.push(project)
    prepareCanonicalStorageFixture(project)
    return project
  }

  it('不带身份的查询向量不参与排序，降级全文', async () => {
    const project = newProject()
    expect(await addChunks(project, 'doc-a', 'a.txt', ['红帆船靠岸'], [storedVector], undefined, undefined, modelA))
      .toEqual({ success: true, chunkCount: 1 })

    await expect(search(project, NO_TEXT_MATCH, queryVector, 5)).resolves.toEqual([])
  })

  it('写入和查询都不带身份时，查询向量同样不参与排序', async () => {
    const project = newProject()
    expect(await addChunks(project, 'doc-a', 'a.txt', ['红帆船靠岸'], [storedVector]))
      .toEqual({ success: true, chunkCount: 1 })

    await expect(search(project, NO_TEXT_MATCH, queryVector, 5)).resolves.toEqual([])
  })

  it('身份与当前空间一致时按向量命中', async () => {
    const project = newProject()
    expect(await addChunks(project, 'doc-a', 'a.txt', ['红帆船靠岸'], [storedVector], undefined, undefined, modelA))
      .toEqual({ success: true, chunkCount: 1 })

    await expect(search(project, NO_TEXT_MATCH, queryVector, 5, modelA))
      .resolves.toEqual([expect.objectContaining({ fileName: 'a.txt', text: '红帆船靠岸' })])
  })
})
