import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  locale: 'zh-CN',
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) }) },
}))

vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: { proxy: { enabled: false } },
  readJsonFile: vi.fn((filePath: string, fallback: unknown) => filePath === 'models.json' ? [] : fallback),
  tryReadJsonFile: vi.fn(() => ({ status: 'missing' })),
  writeJsonFile: vi.fn(),
}))

import { registerLLMController } from '../llm-controller'
import { rendered } from './rendered-failure'

const chatModel: ModelProfile = {
  id: 'local-chat',
  name: 'Local chat',
  provider: 'custom',
  protocol: 'openai',
  modelName: 'local-chat',
  apiKey: 'test-key',
  baseUrl: 'http://127.0.0.1:59999/v1',
  temperature: 0.7,
  maxTokens: 8192,
  purposes: ['generation'],
}

/** undici 的 fetch 把底层失败包成 TypeError('fetch failed')，真正的原因在 cause 上（形状取自 Electron 44 实测）。 */
function fetchFailed(cause: object): TypeError {
  return new TypeError('fetch failed', { cause })
}

const systemError = (code: string, message = '') => Object.assign(new Error(message), { code })

function testConnection(model: ModelProfile): Promise<{ success: boolean; error?: string }> {
  const handler = mocks.handlers.get('llm:test-connection')
  if (!handler) throw new Error('Missing llm:test-connection handler')
  return Promise.resolve(handler({}, model)).then(result => rendered(result as { success: boolean; error?: string }, mocks.locale))
}

function failWith(error: unknown) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(error)))
}

const RAW_ENGLISH = /fetch failed|TypeError|E[A-Z]{3,}|UND_ERR|CERT|SELF_SIGNED|UNABLE_TO|getaddrinfo|socket/u

beforeAll(() => {
  registerLLMController()
})

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.locale = 'zh-CN'
})

describe('connection test explains why the model service could not be reached', () => {
  it.each([
    ['refused on 127.0.0.1', systemError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:59999'), '没有服务在响应'],
    ['refused on localhost (both addresses)', Object.assign(new AggregateError([systemError('ECONNREFUSED'), systemError('ECONNREFUSED')], ''), { code: 'ECONNREFUSED' }), '没有服务在响应'],
    ['host not found', systemError('ENOTFOUND', 'getaddrinfo ENOTFOUND nosuchhost'), '找不到'],
    ['DNS temporarily unavailable', systemError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.example.com'), '找不到'],
    ['connect timeout', Object.assign(systemError('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'), { name: 'ConnectTimeoutError' }), '超时'],
    ['socket timeout', systemError('ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.1:443'), '超时'],
    ['self-signed certificate', systemError('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'), '证书'],
    ['self-signed root in chain', systemError('SELF_SIGNED_CERT_IN_CHAIN', 'self signed certificate in certificate chain'), '证书'],
    ['unverifiable leaf', systemError('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'), '证书'],
    ['expired certificate', systemError('CERT_HAS_EXPIRED', 'certificate has expired'), '证书'],
    ['certificate for another host', systemError('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"), '证书'],
    ['connection reset', systemError('ECONNRESET', 'read ECONNRESET'), '中途断开'],
    ['socket closed', Object.assign(systemError('UND_ERR_SOCKET', 'other side closed'), { name: 'SocketError' }), '中途断开'],
  ])('%s', async (_label, cause, expected) => {
    failWith(fetchFailed(cause))

    const result = await testConnection(chatModel)

    expect(result.success).toBe(false)
    expect(result.error).toContain(expected)
    expect(result.error).not.toMatch(RAW_ENGLISH)
  })

  it.each([
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_CRL', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
    'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'CERT_SIGNATURE_FAILURE', 'CRL_SIGNATURE_FAILURE', 'CERT_NOT_YET_VALID',
    'CERT_HAS_EXPIRED', 'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED', 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD',
    'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_CHAIN_TOO_LONG', 'CERT_REVOKED', 'INVALID_CA',
    'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'HOSTNAME_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('treats the TLS verification code %s as a certificate problem', async code => {
    failWith(fetchFailed(systemError(code)))

    const result = await testConnection(chatModel)

    expect(result.error).toContain('证书')
  })

  it.each(['ECONNRESET', 'UND_ERR_SOCKET'])('points to the base_url when the connection is cut off (%s)', async code => {
    failWith(fetchFailed(systemError(code)))

    const result = await testConnection(chatModel)

    expect(result.error).toContain('中途断开')
    expect(result.error).toContain('base_url')
  })

  it('gives a general explanation when the cause is not recognised', async () => {
    failWith(fetchFailed(new Error('bad port')))

    const result = await testConnection(chatModel)

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('base_url') })
    expect(result.error).not.toMatch(/fetch failed|bad port/u)
  })

  it.each(['anthropic', 'gemini'] as const)('explains a refused %s connection the same way', async protocol => {
    failWith(fetchFailed(systemError('ECONNREFUSED')))

    const result = await testConnection({ ...chatModel, protocol })

    expect(result.error).toContain('没有服务在响应')
  })

  it('explains a refused retrieval model connection', async () => {
    failWith(fetchFailed(systemError('ECONNREFUSED')))

    const result = await testConnection({ ...chatModel, purposes: ['embedding'] })

    expect(result.error).toContain('没有服务在响应')
  })

  it.each([
    ['en-US', 'Nothing is answering at the base_url', /\p{Script=Han}/u],
    ['ja-JP', 'base_url の宛先でサービスが応答していません', /fetch failed/u],
  ])('writes the explanation in %s', async (locale, expected, forbidden) => {
    mocks.locale = locale
    failWith(fetchFailed(systemError('ECONNREFUSED')))

    const result = await testConnection(chatModel)

    expect(result.error).toContain(expected)
    expect(result.error).not.toMatch(forbidden)
  })
})
