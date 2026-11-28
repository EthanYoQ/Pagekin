import fs from 'node:fs'
import path from 'node:path'
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../test/helpers/canonical-project-fixture'
import { addChunks, closeConnection, getConnection, getEmbeddingSpaces, search } from '../vector-store'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'

const modelA = { modelFingerprint: 'openai|https://a.example|emb-a', distanceMetric: 'l2' }
const storedVector = Array.from({ length: 8 }, (_, i) => i / 8)
const queryVector = Array.from({ length: 8 }, (_, i) => (8 - i) / 8)
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

    // @ts-expect-error 缺空间身份的查询向量，类型上应写不出来。
    await expect(search(project, NO_TEXT_MATCH, { queryVector }, 5)).resolves.toEqual([])
  })

  it('写入和查询都不带身份时，查询向量同样不参与排序', async () => {
    const project = newProject()
    expect(await addChunks(project, 'doc-a', 'a.txt', ['红帆船靠岸'], [storedVector]))
      .toEqual({ success: true, chunkCount: 1 })

    // @ts-expect-error 缺空间身份的查询向量，类型上应写不出来。
    await expect(search(project, NO_TEXT_MATCH, { queryVector }, 5)).resolves.toEqual([])
  })

  it('身份与当前空间一致时按向量命中', async () => {
    const project = newProject()
    expect(await addChunks(project, 'doc-a', 'a.txt', ['红帆船靠岸'], [storedVector], undefined, undefined, modelA))
      .toEqual({ success: true, chunkCount: 1 })

    await expect(search(project, NO_TEXT_MATCH, { queryVector, embeddingSpace: modelA }, 5))
      .resolves.toEqual([expect.objectContaining({ fileName: 'a.txt', text: '红帆船靠岸' })])
  })

  it('空白指纹、别的模型的身份都不参与排序', async () => {
    const project = newProject()
    expect(await addChunks(project, 'doc-a', 'a.txt', ['红帆船靠岸'], [storedVector], undefined, undefined, modelA))
      .toEqual({ success: true, chunkCount: 1 })

    const modelB = { modelFingerprint: 'openai|https://b.example|emb-b', distanceMetric: 'l2' }
    await expect(search(project, NO_TEXT_MATCH, { queryVector, embeddingSpace: { modelFingerprint: '  ' } }, 5)).resolves.toEqual([])
    await expect(search(project, NO_TEXT_MATCH, { queryVector, embeddingSpace: modelB }, 5)).resolves.toEqual([])
  })

  it('照抄无身份写入的占位指纹当身份，查询向量也不参与排序', async () => {
    const project = newProject()
    expect(await addChunks(project, 'doc-a', 'a.txt', ['红帆船靠岸'], [storedVector]))
      .toEqual({ success: true, chunkCount: 1 })

    await expect(search(project, NO_TEXT_MATCH, { queryVector, embeddingSpace: { modelFingerprint: 'legacy:dimension:8' } }, 5))
      .resolves.toEqual([])
  })

  it('照抄未登记旧库的占位指纹当身份，查询向量也不参与排序', async () => {
    const project = newProject()
    const db = await getConnection(project)
    await db.createTable('chunks', [{
      id: 'legacy-chunk', docId: 'legacy-doc', fileName: 'legacy.txt', chapterNumber: null, chapterTitle: null,
      text: '红帆船靠岸', vector: storedVector, chunkIndex: 0, totalChunks: 1, importedAt: '2026-01-01T00:00:00.000Z',
    }], { schema: new Schema([
      new Field('id', new Utf8()),
      new Field('docId', new Utf8()),
      new Field('fileName', new Utf8()),
      new Field('chapterNumber', new Int32(), true),
      new Field('chapterTitle', new Utf8(), true),
      new Field('text', new Utf8()),
      new Field('vector', new FixedSizeList(8, new Field('item', new Float32())), true),
      new Field('chunkIndex', new Int32()),
      new Field('totalChunks', new Int32()),
      new Field('importedAt', new Utf8()),
    ]) })
    await expect(getEmbeddingSpaces(project)).resolves.toMatchObject({
      spaces: [expect.objectContaining({ modelFingerprint: 'legacy:unknown', vectorDimension: 8, status: 'active' })],
    })

    await expect(search(project, NO_TEXT_MATCH, { queryVector, embeddingSpace: { modelFingerprint: 'legacy:unknown' } }, 5))
      .resolves.toEqual([])
  })

  it('缺身份时按全文找到正文', async () => {
    const project = newProject()
    expect(await addChunks(project, 'doc-a', 'a.txt', ['红帆船靠岸'], [storedVector], undefined, undefined, modelA))
      .toEqual({ success: true, chunkCount: 1 })

    // @ts-expect-error 缺空间身份的查询向量，类型上应写不出来。
    await expect(search(project, '红帆船', { queryVector }, 5))
      .resolves.toEqual([{ fileName: 'a.txt', text: '红帆船靠岸', score: 0.5 }])
  })
})
