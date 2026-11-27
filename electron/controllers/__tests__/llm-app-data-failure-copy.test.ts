import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InterfaceLocale } from '../../../src/i18n/types'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown> | unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  locale: 'zh-CN',
  generate: vi.fn(),
  embed: vi.fn(),
  rerank: vi.fn(),
  pick: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../i18n', async importOriginal => {
  const { selectCopy } = await import('../../../src/i18n/core')
  return {
    ...await importOriginal<object>(),
    mainText: (_system: unknown, zh: string, en: string, ja?: string) => selectCopy(mocks.locale as InterfaceLocale, zh, en, ja),
    mainErrorDisplayLocale: () => mocks.locale,
  }
})
vi.mock('../../utils/config-utils', async importOriginal => {
  const real = await importOriginal<typeof import('../../utils/config-utils')>()
  return { ...real, writeJsonFile: vi.fn(real.writeJsonFile) }
})
vi.mock('../../llm/llm-factory', () => ({ LLMFactory: { getProvider: () => ({ generate: mocks.generate }) } }))
vi.mock('../../embedding', () => ({ generateEmbeddings: mocks.embed }))
vi.mock('../../rerank', async importOriginal => ({ ...await importOriginal<object>(), requestOrder: mocks.rerank }))
vi.mock('../../utils/remembered-dialog', () => ({ showOpenDialogInLastDirectory: mocks.pick }))

import { RerankError } from '../../rerank'
import { displayedErrorMessage, englishWithReason, failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { selectCopy, translate } from '../../../src/i18n/core'
import { note, type Failure } from '../../../src/shared/failure'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

let fixtureRoot = ''
let velaHome = ''
let modelsPath = ''
let writeJsonFile: ReturnType<typeof vi.fn>

beforeAll(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-llm-app-data-copy-'))
  await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
  const config = await import('../../utils/config-utils')
  velaHome = config.VELA_HOME
  modelsPath = config.MODELS_CONFIG_PATH
  writeJsonFile = config.writeJsonFile as unknown as ReturnType<typeof vi.fn>
  ;(await import('../llm-controller')).registerLLMController()
  ;(await import('../app-data-controller')).registerAppDataController()
})

afterAll(() => {
  delete process.env.AI_NOVEL_VELA_HOME
  delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

beforeEach(() => {
  mocks.locale = 'zh-CN'
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const fn of [mocks.generate, mocks.embed, mocks.rerank, mocks.pick]) fn.mockReset()
  fs.rmSync(path.join(velaHome, 'skills'), { recursive: true, force: true })
  fs.rmSync(path.join(velaHome, 'prompts'), { recursive: true, force: true })
  fs.rmSync(modelsPath, { force: true })
})

const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender: { id: 7, isDestroyed: () => false } }, ...args)
const locale = () => shown(mocks.locale as InterfaceLocale)

type Received = { success: boolean; failure?: Failure; error?: string }

/** 迁移后读 failure，通用码让给调用点的兜底句（SkillSettings、llm-store 同此）；master 上读 error。 */
async function reasonShown(raw: unknown, fallback: readonly [string, string]): Promise<string> {
  const result = receivedIpcResult(await raw) as Received
  expect(result.success).toBe(false)
  if ('failure' in result) {
    const failure = resultFailure(result)
    return failureText(locale(), failure?.code === 'IPC_HANDLER_FAILED' ? undefined : failure, { fallback: note(...fallback as [never, never]) })
  }
  return displayedErrorMessage(locale(), new Error(result.error || selectCopy(locale(), ...fallback)))
}

/** ModelForm 的连接测试提示：「连接失败：原因」，英文界面用 englishWithReason 接原因。 */
async function connectionNotice(raw: unknown): Promise<string> {
  const result = receivedIpcResult(await raw) as Received
  expect(result.success).toBe(false)
  const reason = 'failure' in result ? failureText(locale(), resultFailure(result)) : displayedErrorMessage(locale(), result.error)
  return selectCopy(locale() as InterfaceLocale, `连接失败：${reason}`, englishWithReason(locale(), 'Connection failed', reason, ': '))
}

const chatModel: ModelProfile = {
  id: 'chat', name: 'Chat', provider: 'custom', protocol: 'openai', modelName: 'chat', apiKey: 'test-key',
  baseUrl: 'https://model.example/v1', temperature: 0.7, maxTokens: 8192, purposes: ['generation'],
}
const embeddingModel: ModelProfile = { ...chatModel, id: 'embed', purposes: ['embedding'] }
const rerankModel: ModelProfile = { ...chatModel, id: 'rerank', purposes: ['rerank'] }
const testConnection = (model: ModelProfile) => invoke('llm:test-connection', model)
const providerFails = (response: object) => mocks.generate.mockResolvedValue({ success: false, content: '', finishReason: 'error', ...response })

const skillMarkdown = (name = 'safe-prose', body = 'Revise with concrete action.') => `---\nname: ${name}\ndescription: Improve prose.\nversion: 1.0.0\nlanguage: en-US\nstage: refinement\n---\n${body}`
const SKILL_URL = 'https://github.com/acme/skill/blob/main/SKILL.md'
const inspectGithub = (url = SKILL_URL) => invoke('skills:inspect-github', url)
const INSPECT_FALLBACK = ['Skill 检查失败', 'Skill inspection failed'] as const
const INSTALL_FALLBACK = ['Skill 安装失败', 'Skill installation failed'] as const

function pickLocal(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(fixtureRoot, 'pick-'))
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  mocks.pick.mockResolvedValue({ canceled: false, filePaths: [root] })
  return invoke('skills:pick-local', 'folder')
}

function installSkillDirectory(name: string) {
  fs.mkdirSync(path.join(velaHome, 'skills', name), { recursive: true })
  fs.writeFileSync(path.join(velaHome, 'skills', name, 'SKILL.md'), skillMarkdown(name))
}

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const RAW = /EPERM|operation not permitted|Unexpected|JSON|SyntaxError|[A-Z]:\\|fetch failed/u

describe('模型与应用数据控制器失败时作者看不到主进程原文', () => {
  it.each([
    ['重排服务超时', () => { mocks.rerank.mockRejectedValue(new RerankError('timeout')); return testConnection(rerankModel) }],
    ['模型服务回 HTTP 401', () => { providerFails({ error: 'LLM_REQUEST_FAILED', httpFailure: { status: 401, body: '' } }); return testConnection(chatModel) }],
    ['Anthropic 没有向量接口', () => testConnection({ ...embeddingModel, protocol: 'anthropic' })],
  ])('日文界面测连接：%s 说日文', async (_name, fail) => {
    mocks.locale = 'ja-JP'
    expect(await connectionNotice(fail())).toMatch(JAPANESE)
  })

  it.each([
    ['连不上 GitHub', () => { vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') })); return inspectGithub() }],
    ['地址不是网址', () => inspectGithub('github.com/acme/skill')],
    ['文件夹里没有 SKILL.md', () => pickLocal({ 'README.md': 'hello' })],
  ])('日文界面写作 Skill：%s 说日文', async (_name, fail) => {
    mocks.locale = 'ja-JP'
    expect(await reasonShown(fail(), INSPECT_FALLBACK)).toMatch(JAPANESE)
  })

  it('卸载写作 Skill 时文件被占用，不露系统报错与本机路径', async () => {
    installSkillDirectory('safe-prose')
    const rmSync = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target).includes('safe-prose')) throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${String(target)}'`), { code: 'EPERM' })
      return rmSync(target, options)
    })
    const text = await reasonShown(invoke('skills:uninstall-user', 'safe-prose'), ['Skill 卸载失败', 'Skill uninstall failed'])
    expect(text).not.toMatch(RAW)
    expect(text).not.toContain(velaHome)
  })

  it('全局提示词文件不是 JSON 时，诊断不露解析器原文', async () => {
    fs.mkdirSync(path.join(velaHome, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(velaHome, 'prompts', 'broken.json'), '{oops')
    const { PromptLoadDiagnosticsError } = await import('../../../src/services/prompt-catalog')
    const receipt = await invoke('prompt:load-global') as { diagnostics: ConstructorParameters<typeof PromptLoadDiagnosticsError>[0] }
    expect(receipt.diagnostics).toHaveLength(1)
    expect(new PromptLoadDiagnosticsError(receipt.diagnostics).message).not.toMatch(RAW)
  })
})

describe('模型设置失败的说明与 master 逐字相同', () => {
  const connectionCases: ReadonlyArray<readonly [string, () => unknown, string, string]> = [
    ...([
      ['timeout', '重排服务响应超时，请稍后再试。', 'The reranking service timed out. Try again later.'],
      ['request-failed', '连不上重排服务，请检查 base_url 和网络。', 'Could not reach the reranking service. Check the base_url and your network.'],
      ['http-error', '重排服务拒绝了请求，请检查 API Key 和模型名称。', 'The reranking service refused the request. Check the API key and model name.'],
      ['invalid-response', '服务的返回不是重排结果，请确认这个模型支持重排。', 'The service did not return reranking results. Check that this model supports reranking.'],
    ] as const).map(([reason, zh, en]) => [`重排 ${reason}`, () => { mocks.rerank.mockRejectedValue(new RerankError(reason)); return testConnection(rerankModel) }, zh, en] as const),
    ['模型 HTTP 失败带服务返回', () => { providerFails({ error: 'LLM_REQUEST_FAILED', httpFailure: { status: 401, body: ' {"error":"invalid key"} ' } }); return testConnection(chatModel) },
      '模型请求失败（HTTP 401）。请检查 Base URL、API Key 与模型名。服务返回：{"error":"invalid key"}',
      'Model request failed (HTTP 401). Check the Base URL, API key, and model name. The service returned: {"error":"invalid key"}'],
    ['模型 HTTP 失败没有服务返回', () => { providerFails({ error: 'LLM_REQUEST_FAILED', httpFailure: { status: 500, body: '  ' } }); return testConnection(chatModel) },
      '模型请求失败（HTTP 500）。请检查 Base URL、API Key 与模型名。', 'Model request failed (HTTP 500). Check the Base URL, API key, and model name.'],
    ['模型没有正常完成回复', () => { providerFails({ error: 'LLM_RESPONSE_INCOMPLETE', finishReason: 'length' }); return testConnection(chatModel) },
      '模型没有正常完成回复（结束原因：length）。', 'The model did not finish its reply (finish reason: length).'],
    ['Anthropic 没有向量接口', () => testConnection({ ...embeddingModel, protocol: 'anthropic' }),
      'Anthropic 协议没有向量接口，测不了向量连接。请改用 OpenAI 兼容或 Gemini 协议的向量模型。',
      'The Anthropic protocol has no embedding endpoint, so the embedding connection cannot be tested. Use an OpenAI-compatible or Gemini embedding model.'],
    ['向量请求 HTTP 失败', () => { mocks.embed.mockRejectedValue(Object.assign(new Error('EMBEDDING_REQUEST_FAILED'), { code: 'EMBEDDING_REQUEST_FAILED', status: 502 })); return testConnection(embeddingModel) },
      '检索模型请求失败（HTTP 502）。请检查 Base URL、网关与 API Key。', 'Retrieval model request failed (HTTP 502). Check the Base URL, gateway, and API key.'],
    ['Ollama 原生地址', () => { mocks.embed.mockRejectedValue(Object.assign(new Error('EMBEDDING_OLLAMA_NATIVE_URL'), { code: 'EMBEDDING_OLLAMA_NATIVE_URL', suggestedBaseUrl: 'http://127.0.0.1:11434/v1' })); return testConnection(embeddingModel) },
      '这是 Ollama 原生的 /api 地址。请把 Base URL 改为 http://127.0.0.1:11434/v1。', 'This is Ollama’s native /api address. Change the Base URL to http://127.0.0.1:11434/v1.'],
  ]

  it.each(connectionCases)('测连接：%s', async (_name, fail, zh, en) => {
    expect(await connectionNotice(fail())).toBe(`连接失败：${zh}`)
    mocks.locale = 'en-US'
    expect(await connectionNotice(fail())).toBe(`Connection failed: ${en}`)
  })

  it.each([
    ['登记过的码', () => { providerFails({ error: 'LLM_STAGE_MODEL_UNAVAILABLE' }); return testConnection(chatModel) }, 'error.stageModelUnavailable'],
    ['没登记的异常', () => { mocks.generate.mockRejectedValue(new Error('socket hang up at 10.0.0.1')); return testConnection(chatModel) }, 'error.connectionFailed'],
  ] as const)('测连接：%s 用目录说明', async (_name, fail, key) => {
    for (const each of ['zh-CN', 'en-US'] as const) {
      mocks.locale = each
      expect(await connectionNotice(fail())).toBe(selectCopy(each, `连接失败：${translate(each, key)}`, `Connection failed: ${translate(each, key)}`))
    }
  })

  it('删除模型时模型设置文件已损坏', async () => {
    fs.writeFileSync(modelsPath, '{broken')
    for (const each of ['zh-CN', 'en-US'] as const) {
      mocks.locale = each
      expect(await reasonShown(invoke('llm:delete-model', 'chat'), ['删除模型失败', 'Could not delete the model.'])).toBe(translate(each, 'error.modelSettingsFileDamaged'))
    }
  })

  it('删除模型时写盘失败，显示原兜底句', async () => {
    writeJsonFile.mockImplementationOnce(() => { throw Object.assign(new Error("EPERM: operation not permitted, open 'C:\\models.json'"), { code: 'EPERM' }) })
    const result = receivedIpcResult(await invoke('llm:delete-model', 'chat')) as Received
    const text = 'failure' in result
      ? failureText(locale(), resultFailure(result)?.code === 'IPC_HANDLER_FAILED' ? undefined : resultFailure(result), { fallback: note('删除模型失败', 'Could not delete the model.') })
      : failureText(locale(), resultFailure(result), { fallback: note('删除模型失败', 'Could not delete the model.') })
    expect(text).toBe('删除模型失败')
  })

  const skillCases: ReadonlyArray<readonly [string, () => unknown, string]> = [
    ['连不上 GitHub', () => { vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') })); return inspectGithub() }, '连不上 GitHub，请检查网络后重试。'],
    ['GitHub 拒绝', () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 }))); return inspectGithub() }, 'GitHub 暂时拒绝了请求，请稍后重试。'],
    ['仓库不存在', () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 }))); return inspectGithub('https://github.com/acme/skill') },
      'GitHub 上找不到这个仓库。请检查地址，并确认仓库是公开的。'],
    ['读不出默认分支', () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 }))); return inspectGithub('https://github.com/acme/skill') },
      '读不出这个仓库的默认分支，请改用带分支的地址，例如 …/tree/main。'],
    ['地址下没有 SKILL.md', () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 }))); return inspectGithub() }, '这个地址下没有 SKILL.md。请检查仓库、分支和路径。'],
    ['SKILL.md 太大', () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(65 * 1024), { status: 200 }))); return inspectGithub() }, '这个 SKILL.md 超过 64 KiB，不能安装。'],
    ['地址太长', () => inspectGithub(`https://github.com/${'a'.repeat(2100)}`), 'GitHub 地址无效'],
    ['不是网址', () => inspectGithub('github.com/acme/skill'), '这不是有效的网址。请粘贴 GitHub 上 Skill 的地址。'],
    ['不是 https', () => inspectGithub('http://github.com/acme/skill'), '只支持 https:// 开头的公开 GitHub 地址。'],
    ['不是 GitHub', () => inspectGithub('https://example.com/acme/skill/SKILL.md'), '只支持 github.com 和 raw.githubusercontent.com 的地址。'],
    ['指向 issue 页', () => inspectGithub('https://github.com/acme/skill/issues/1'), '请粘贴 GitHub 上 Skill 仓库、文件夹或 SKILL.md 文件的地址。'],
    ['不指向 SKILL.md', () => inspectGithub('https://github.com/acme/skill/blob/main/README.md'), '地址要指向 SKILL.md 文件，或包含它的文件夹。'],
    ...([['用户名', 'https://github.com/%20bad/skill'], ['仓库名', 'https://github.com/acme/%20bad'], ['分支', 'https://github.com/acme/skill/tree/%20bad'], ['路径', 'https://github.com/acme/skill/blob/main/%20bad/SKILL.md']] as const)
      .map(([part, url]) => [`${part}有不支持的字符`, () => inspectGithub(url), `GitHub 地址里的${part}有不支持的字符，请检查地址。`] as const),
    ['没检查就安装 GitHub Skill', () => invoke('skills:install-github', 'https://github.com/acme/never/blob/main/SKILL.md'), '请先检查该 GitHub Writing Skill，再确认安装'],
    ['没检查就安装本机 Skill', () => invoke('skills:install-local', 'missing-candidate'), '请先检查该本机 Writing Skill，再确认安装'],
    ['文件夹里没有 SKILL.md', () => pickLocal({ 'README.md': 'hello' }), '文件夹根目录里没有 SKILL.md'],
    ['SKILL.md 不是 UTF-8 文本', () => pickLocal({ 'SKILL.md': 'x'.repeat(65 * 1024) }), 'SKILL.md 必须是不超过 64 KiB 的 UTF-8 文本'],
    ['Skill 名称无效', () => pickLocal({ 'SKILL.md': skillMarkdown('bad name!') }), 'Skill 名称“bad name!”无效：只能使用字母、数字、点、下划线和连字符'],
  ]

  it.each(skillCases)('写作 Skill：%s', async (_name, fail, zh) => {
    expect(await reasonShown(fail(), INSPECT_FALLBACK)).toBe(zh)
  })

  it('写作 Skill：同名已安装', async () => {
    installSkillDirectory('safe-prose')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(skillMarkdown(), { status: 200 })))
    expect((await inspectGithub() as Received).success).toBe(true)
    expect(await reasonShown(invoke('skills:install-github', SKILL_URL), INSTALL_FALLBACK)).toBe('同名 Writing Skill 已安装：safe-prose')
  })

  it('写作 Skill：检查后内容变了', async () => {
    let body = skillMarkdown()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    expect((await inspectGithub() as Received).success).toBe(true)
    body = skillMarkdown('safe-prose', 'Changed after inspection.')
    expect(await reasonShown(invoke('skills:install-github', SKILL_URL), INSTALL_FALLBACK)).toBe('Writing Skill 在检查后已发生变化，请重新检查')
  })

  it('写作 Skill：不是自包含提示词', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(skillMarkdown('safe-prose', 'Run `scripts/fix.py` first.'), { status: 200 })))
    const inspected = await inspectGithub() as Received & { inspection?: { compatible: boolean; reasons: string[] } }
    expect(inspected.inspection?.compatible).toBe(false)
    expect(await reasonShown(invoke('skills:install-github', SKILL_URL), INSTALL_FALLBACK))
      .toBe(`该 Skill 不是自包含提示词：${inspected.inspection!.reasons.join(', ')}`)
  })
})
