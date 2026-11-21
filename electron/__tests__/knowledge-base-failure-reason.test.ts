import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { shown } from '../../src/i18n/__tests__/shown-locale'
import { displayedErrorMessage } from '../../src/i18n/app-errors'
import { planFinalizationRetry } from '../../src/shared/finalization-step-error'
import { workflowMainProcessError } from '../../src/services/workflows/workflow-project-session'
import { closeProjectDatabase } from '../database'
import { backfillVectors, importText } from '../knowledge-base'
import { getProjectDataRoot } from '../services/project-data-locator'
import { closeConnection } from '../vector-store'

let projectPath = ''

const model = (baseUrl = 'https://embed.example.test/v1') => ({ provider: 'custom', baseUrl, apiKey: 'test-key', modelName: 'embed' })

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno: -1, syscall: 'open' })
}

function failKnowledgeCopyWrite(error: NodeJS.ErrnoException) {
  const write = fs.writeFileSync
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
    if (String(file).includes(`${path.sep}knowledge-copies${path.sep}`)) throw error
    return write(file, ...rest as [never])
  })
}

const rebuildShown = (result: { error?: string; errorCode?: string }) =>
  workflowMainProcessError(shown('zh-CN'), result.errorCode ?? result.error, '重建检索失败', 'Could not rebuild search.').message

beforeAll(() => { fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true }) })

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), 'ai-novel-kb-failure-reason-'))
  openCanonicalProjectFixture(projectPath)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  closeProjectDatabase()
  closeConnection(projectPath)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('importing material when the book folder cannot be written', () => {
  it('tells a Chinese author the disk is full instead of showing ENOSPC and the file path', async () => {
    failKnowledgeCopyWrite(errnoError('ENOSPC', `ENOSPC: no space left on device, open '${projectPath}\\knowledge-copies\\x.tmp'`))

    const result = await importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', model(), { mode: 'fts-only' })

    expect(result.success).toBe(false)
    expect(displayedErrorMessage(shown('zh-CN'), result.error)).toBe('知识库没有改动。磁盘空间不足，写不进去；清理磁盘后再试一次。')
  })

  it('tells the author the folder is read-only or locked instead of showing EPERM', async () => {
    failKnowledgeCopyWrite(errnoError('EPERM', `EPERM: operation not permitted, open '${projectPath}\\knowledge-copies\\x.tmp'`))

    const result = await importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', model(), { mode: 'fts-only' })

    expect(displayedErrorMessage(shown('zh-CN'), result.error)).toBe('知识库没有改动。作品文件夹写不进去，可能是只读，或被同步盘、杀毒软件占用；关掉这些程序后再试一次。')
    expect(displayedErrorMessage(shown('en-US'), result.error)).toBe('The knowledge base was not changed. The book folder could not be written; it may be read-only or locked by sync or antivirus software. Close those programs, then try again.')
  })

  it('still offers Retry for a finalized chapter whose knowledge-base import hit a full disk', async () => {
    failKnowledgeCopyWrite(errnoError('ENOSPC', 'ENOSPC: no space left on device, write'))

    const result = await importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', model(), { mode: 'fts-only' })

    expect(planFinalizationRetry({ kb_import: { ok: false, error: result.error } }).card).toEqual(['kb_import'])
  })
})

describe('rebuilding search over a damaged index', () => {
  it('logs the LanceDB error and gives the author a readable reason instead of the English original', async () => {
    await importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', model(), { mode: 'fts-only' })
    closeConnection(projectPath)
    const lance = path.join(getProjectDataRoot(projectPath), 'lancedb')
    for (const table of fs.readdirSync(lance)) {
      const data = path.join(lance, table, 'data')
      if (fs.existsSync(data)) for (const file of fs.readdirSync(data)) fs.rmSync(path.join(data, file))
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), { status: 200 })))

    const result = await backfillVectors(projectPath, 'openai', model())

    expect(result.success).toBe(false)
    const shown = rebuildShown(result)
    expect(shown).toBe('重建检索失败：知识库没有改动。这次操作出了意外问题；请再试一次，还不行请把这条提示反馈给我们。')
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringMatching(/lance/iu) }))
  })

  it('keeps naming the retrieval model when its API rejects the request', async () => {
    await importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', model(), { mode: 'fts-only' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))

    const result = await backfillVectors(projectPath, 'openai', model())

    expect(rebuildShown(result)).toBe('重建检索失败：检索模型请求失败。请检查检索模型的 Base URL、网关与 API Key。')
  })

  it('keeps pointing at the Ollama OpenAI-compatible address', async () => {
    await importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', model(), { mode: 'fts-only' })

    const result = await backfillVectors(projectPath, 'openai', model('http://127.0.0.1:11434/api'))

    expect(result.error).toBe('EMBEDDING_OLLAMA_NATIVE_URL')
  })
})
