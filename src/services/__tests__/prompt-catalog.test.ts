import { ipc } from '../ipc-client'
import { describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { PromptCatalog, ipcPromptPersistence, type PromptPersistence } from '../prompt-catalog'
import type { PromptTemplate } from '../prompt-templates'

const builtin: PromptTemplate = {
  key: 'first_chapter_draft',
  name: 'First chapter',
  description: 'Built in',
  content: 'builtin prompt',
  variables: {},
}

const session: ProjectSessionContext = {
  projectId: 'novel-1',
  leaseId: 'lease-1',
  projectPath: 'C:/novels/novel-1',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function persistence(overrides: Partial<PromptPersistence> = {}): PromptPersistence {
  return {
    loadGlobal: vi.fn(async () => ({ templates: [], diagnostics: [] })),
    loadProject: vi.fn(async () => ({ templates: [], diagnostics: [] })),
    saveGlobal: vi.fn(async () => {}),
    saveProject: vi.fn(async () => {}),
    deleteGlobal: vi.fn(async () => {}),
    deleteProject: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('PromptCatalog lifecycle', () => {
  it('isolates overrides by writing language and migrates legacy overrides to zh-CN only', async () => {
    const adapter = persistence({
      loadGlobal: vi.fn(async () => ({
        templates: [
          { ...builtin, content: '旧中文覆盖' },
          { ...builtin, writingLanguage: 'en-US' as const, content: 'English override' },
        ],
        diagnostics: [],
      })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => null)

    await expect(catalog.resolve(builtin.key, undefined, 'zh-CN')).resolves.toMatchObject({
      template: { content: '旧中文覆盖' },
      source: 'global',
    })
    await expect(catalog.resolve(builtin.key, undefined, 'en-US')).resolves.toMatchObject({
      template: { content: 'English override' },
      source: 'global',
    })
  })

  it('does not apply a legacy Chinese override to an English project', async () => {
    const adapter = persistence({
      loadGlobal: vi.fn(async () => ({
        templates: [{ ...builtin, content: '旧中文覆盖' }],
        diagnostics: [],
      })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => null)

    await expect(catalog.resolve(builtin.key, undefined, 'en-US')).resolves.toMatchObject({
      template: { content: 'builtin prompt' },
      source: 'builtin',
    })
  })

  it('hydrates a global override on the first resolve and shares one concurrent load', async () => {
    const globalLoad = deferred<{ templates: PromptTemplate[]; diagnostics: [] }>()
    const adapter = persistence({ loadGlobal: vi.fn(() => globalLoad.promise) })
    const catalog = new PromptCatalog([builtin], adapter, () => null)

    const first = catalog.resolve(builtin.key)
    const second = catalog.resolve(builtin.key)
    globalLoad.resolve({ templates: [{ ...builtin, content: 'global prompt' }], diagnostics: [] })

    await expect(first).resolves.toMatchObject({ template: { content: 'global prompt' }, source: 'global' })
    await expect(second).resolves.toMatchObject({ template: { content: 'global prompt' }, source: 'global' })
    expect(adapter.loadGlobal).toHaveBeenCalledTimes(1)
  })

  it('hydrates the active project override from resolve without a settings-page preload', async () => {
    const adapter = persistence({
      loadGlobal: vi.fn(async () => ({ templates: [{ ...builtin, content: 'global prompt' }], diagnostics: [] })),
      loadProject: vi.fn(async () => ({ templates: [{ ...builtin, content: 'project prompt' }], diagnostics: [] })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => session)

    await expect(catalog.resolve(builtin.key, session)).resolves.toMatchObject({
      template: { content: 'project prompt' },
      source: 'project',
    })
    expect(adapter.loadProject).toHaveBeenCalledWith(session)
  })

  it('publishes a successful save immediately to subsequent resolves', async () => {
    const adapter = persistence()
    const catalog = new PromptCatalog([builtin], adapter, () => null)
    const saved = { ...builtin, content: 'saved prompt' }

    await expect(catalog.commit({ action: 'save', scope: 'global', template: saved })).resolves.toBe(true)
    await expect(catalog.resolve(builtin.key)).resolves.toMatchObject({
      template: { content: 'saved prompt' },
      source: 'global',
    })
  })

  it('does not publish a save when durable persistence fails', async () => {
    const adapter = persistence({
      saveGlobal: vi.fn(async () => { throw new Error('disk full') }),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => null)

    await expect(catalog.commit({
      action: 'save',
      scope: 'global',
      template: { ...builtin, content: 'must not leak' },
    })).resolves.toBe(false)
    await expect(catalog.resolve(builtin.key)).resolves.toMatchObject({
      template: { content: 'builtin prompt' },
      source: 'builtin',
    })
  })

  it('fails visibly instead of treating a project load error as no override', async () => {
    const adapter = persistence({
      loadProject: vi.fn(async () => { throw new Error('permission denied') }),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => session)

    await expect(catalog.resolve(builtin.key, session)).rejects.toThrow('permission denied')
  })

  it('fails closed only for the key whose project override is damaged', async () => {
    const adapter = persistence({
      loadProject: vi.fn(async () => ({
        templates: [{ ...builtin, key: 'next_chapter_draft', content: 'valid project prompt' }],
        diagnostics: [{ key: builtin.key, path: 'first_chapter_draft.json', error: 'JSON 格式损坏' }],
      })),
    })
    const catalog = new PromptCatalog([
      builtin,
      { ...builtin, key: 'next_chapter_draft', content: 'next builtin' },
    ], adapter, () => session)

    await expect(catalog.resolve(builtin.key, session)).rejects.toThrow('first_chapter_draft.json')
    await expect(catalog.resolve('next_chapter_draft', session)).resolves.toMatchObject({
      template: { content: 'valid project prompt' },
      source: 'project',
    })
  })

  it('reports a damaged global target while unrelated built-ins remain resolvable', async () => {
    const adapter = persistence({
      loadGlobal: vi.fn(async () => ({
        templates: [],
        diagnostics: [{ key: builtin.key, path: 'first_chapter_draft.json', error: '内容结构无效' }],
      })),
    })
    const catalog = new PromptCatalog([
      builtin,
      { ...builtin, key: 'next_chapter_draft', content: 'next builtin' },
    ], adapter, () => null)

    await expect(catalog.resolve(builtin.key)).rejects.toThrow('first_chapter_draft.json')
    await expect(catalog.resolve('next_chapter_draft')).resolves.toMatchObject({
      template: { content: 'next builtin' },
      source: 'builtin',
    })
    await expect(catalog.list()).rejects.toThrow('first_chapter_draft.json')
  })

  it('isolates a damaged localized override from the same prompt in another language', async () => {
    const adapter = persistence({
      loadGlobal: vi.fn(async () => ({
        templates: [],
        diagnostics: [{
          key: builtin.key,
          writingLanguage: 'en-US' as const,
          path: 'first_chapter_draft.en-US.json',
          error: 'invalid JSON',
        }],
      })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => null)

    await expect(catalog.resolve(builtin.key, undefined, 'zh-CN')).resolves.toMatchObject({ source: 'builtin' })
    await expect(catalog.resolve(builtin.key, undefined, 'en-US')).rejects.toThrow('first_chapter_draft.en-US.json')
    await expect(catalog.list(undefined, 'zh-CN')).resolves.toHaveLength(1)
    await expect(catalog.list(undefined, 'en-US')).rejects.toThrow('first_chapter_draft.en-US.json')
  })

  it.each(['save', 'delete'] as const)('keeps an English diagnostic after a Chinese %s', async (action) => {
    const adapter = persistence({
      loadGlobal: vi.fn(async () => ({
        templates: [],
        diagnostics: [{
          key: builtin.key,
          writingLanguage: 'en-US' as const,
          path: 'first_chapter_draft.en-US.json',
          error: 'English override is damaged',
        }],
      })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => null)
    const change = action === 'save'
      ? { action, scope: 'global' as const, template: { ...builtin, writingLanguage: 'zh-CN' as const } }
      : { action, scope: 'global' as const, key: builtin.key, writingLanguage: 'zh-CN' as const }

    await expect(catalog.commit(change)).resolves.toBe(true)
    await expect(catalog.resolve(builtin.key, undefined, 'en-US')).rejects.toThrow('first_chapter_draft.en-US.json')
  })

  it('preloads project diagnostics only for the requested writing language', async () => {
    const adapter = persistence({
      loadProject: vi.fn(async () => ({
        templates: [],
        diagnostics: [{
          key: builtin.key,
          writingLanguage: 'en-US' as const,
          path: 'project/first_chapter_draft.en-US.json',
          error: 'English project override is damaged',
        }],
      })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => session)

    await expect(catalog.loadProject(session, 'zh-CN')).resolves.toBe(true)
    await expect(catalog.loadProject(session, 'en-US')).rejects.toThrow('「first_chapter_draft.en-US.json」')
  })

  it('does not leak project diagnostics into a global-only list', async () => {
    const adapter = persistence({
      loadProject: vi.fn(async () => ({
        templates: [],
        diagnostics: [{ key: builtin.key, path: 'project/first_chapter_draft.json', error: 'project damaged' }],
      })),
    })
    const catalog = new PromptCatalog([builtin], adapter, () => session)

    await expect(catalog.resolve(builtin.key, session)).rejects.toThrow('「first_chapter_draft.json」')
    await expect(catalog.list()).resolves.toEqual([{
      template: builtin,
      source: 'builtin',
    }])
  })
})


it('项目提示词读取、保存和删除始终使用规范目录', async () => {
  const calls: Array<[string, unknown]> = []
  const adapter = vi.spyOn(ipc, 'invokeWithProjectSession').mockImplementation(async (_session, channel, ...args) => {
    calls.push([channel, args[0]])
    if (channel === 'fs:check-exists') return false as never
    if (channel === 'fs:mkdir' || channel === 'fs:write-file') return { success: true } as never
    throw new Error(`Unexpected fixture call: ${channel}`)
  })
  try {
    await ipcPromptPersistence.loadProject(session)
    await ipcPromptPersistence.saveProject(session, { ...builtin, content: '中文提示词' })
    await ipcPromptPersistence.deleteProject(session, builtin.key)
    expect(calls).toContainEqual(['fs:mkdir', `${session.projectPath}/.ai-novel`])
    expect(calls).toContainEqual(['fs:write-file', `${session.projectPath}/.ai-novel/prompts/${builtin.key}.zh-CN.json`])
    expect(calls.every(([, file]) => typeof file === 'string' && file.startsWith(`${session.projectPath}/.ai-novel`))).toBe(true)
    expect(calls.filter(([channel]) => channel === 'fs:check-exists')).toHaveLength(5)
  } finally { adapter.mockRestore() }
})

it('explains a cached damaged project prompt in the interface language current at failure time (#474)', async () => {
  const { useLocaleStore } = await import('../../stores/locale-store')
  const original = useLocaleStore.getState()
  const spy = vi.spyOn(ipc, 'invokeWithProjectSession').mockImplementation((async (_session: unknown, channel: string) => {
    if (channel === 'fs:check-exists') return true
    if (channel === 'fs:list-dir') return [{ name: `${builtin.key}.json`, path: `${builtin.key}.json`, isDir: false }]
    if (channel === 'fs:read-file') return { success: true, content: JSON.stringify({ key: builtin.key }) }
    throw new Error(`unexpected ${channel}`)
  }) as never)
  try {
    const catalog = new PromptCatalog([builtin], persistence({ loadProject: ipcPromptPersistence.loadProject }), () => session)
    useLocaleStore.setState({ locale: 'zh-CN' })
    await expect(catalog.resolve(builtin.key, session)).rejects.toThrow('提示词文件「first_chapter_draft.json」读不出来或格式不对')
    useLocaleStore.setState({ locale: 'en-US' })
    await expect(catalog.resolve(builtin.key, session)).rejects.toThrow('The prompt file "first_chapter_draft.json" cannot be read or is malformed')
  } finally {
    spy.mockRestore()
    useLocaleStore.setState(original, true)
  }
})

it('主进程只回登记过的码时，读取被拒照码说明，不误报提示词文件损坏', async () => {
  const { useLocaleStore } = await import('../../stores/locale-store')
  const original = useLocaleStore.getState()
  const spy = vi.spyOn(ipc, 'invokeWithProjectSession').mockImplementation((async (_session: unknown, channel: string) => {
    if (channel === 'fs:check-exists') return true
    if (channel === 'fs:list-dir') return [{ name: `${builtin.key}.json`, path: `${builtin.key}.json`, isDir: false }]
    if (channel === 'fs:read-file') return { success: false, failure: { code: 'PROJECT_SESSION_STALE' } }
    throw new Error(`unexpected ${channel}`)
  }) as never)
  try {
    useLocaleStore.setState({ interfaceLocale: 'en-US', locale: 'en-US' })
    const catalog = new PromptCatalog([builtin], persistence({ loadProject: ipcPromptPersistence.loadProject }), () => session)
    const shown = await catalog.resolve(builtin.key, session).then(() => '', (error: Error) => error.message)
    expect(shown).toBe('The project was switched or reopened, and this action belonged to the earlier session, so it was rejected. Repeat it in the project that is open now.')
    expect(shown).not.toContain('malformed')
  } finally {
    spy.mockRestore()
    useLocaleStore.setState(original, true)
  }
})

it('原来能看到的具体说明逐字保留：项目提示词读取被拒时说明租约过期', async () => {
  const { useLocaleStore } = await import('../../stores/locale-store')
  const { catalogNote } = await import('../../i18n/app-errors')
  const original = useLocaleStore.getState()
  const spy = vi.spyOn(ipc, 'invokeWithProjectSession').mockImplementation((async (_session: unknown, channel: string) => {
    if (channel === 'fs:check-exists') return true
    if (channel === 'fs:list-dir') return [{ name: `${builtin.key}.json`, path: `${builtin.key}.json`, isDir: false }]
    if (channel === 'fs:read-file') return { success: false, failure: { code: 'PROJECT_SESSION_STALE', note: catalogNote('error.projectLeaseExpired') } }
    throw new Error(`unexpected ${channel}`)
  }) as never)
  try {
    useLocaleStore.setState({ interfaceLocale: 'en-US', locale: 'en-US' })
    const catalog = new PromptCatalog([builtin], persistence({ loadProject: ipcPromptPersistence.loadProject }), () => session)
    const shown = await catalog.resolve(builtin.key, session).then(() => '', (error: Error) => error.message)
    expect(shown).toBe('The project lease has expired; the operation was rejected.')
  } finally {
    spy.mockRestore()
    useLocaleStore.setState(original, true)
  }
})

it('项目提示词改坏后，运行失败说明写出文件名和去「提示词模板」的办法，重新保存后可以用', async () => {
  const { useLocaleStore } = await import('../../stores/locale-store')
  const { failureText, reasonOf } = await import('../../i18n/app-errors')
  const original = useLocaleStore.getState()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const file = `${builtin.key}.zh-CN.json`
  const spy = vi.spyOn(ipc, 'invokeWithProjectSession').mockImplementation((async (_session: unknown, channel: string) => {
    if (channel === 'fs:check-exists') return true
    if (channel === 'fs:list-dir') return [{ name: file, path: `${session.projectPath}/.ai-novel/prompts/${file}`, isDir: false }]
    if (channel === 'fs:read-file') return { success: true, content: '{"key": "first_chapter_draft",' }
    throw new Error(`unexpected ${channel}`)
  }) as never)
  try {
    const saveProject = vi.fn(async () => {})
    const catalog = new PromptCatalog([builtin], persistence({ loadProject: ipcPromptPersistence.loadProject, saveProject }), () => session)
    const shownFor = async (locale: 'zh-CN' | 'en-US' | 'ja-JP') => {
      useLocaleStore.setState({ interfaceLocale: locale, locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US' })
      const error = await catalog.resolve(builtin.key, session).then(() => undefined, (rejected: unknown) => rejected)
      return failureText(locale as never, reasonOf(error))
    }
    expect(await shownFor('zh-CN')).toBe(`提示词文件「${file}」读不出来或格式不对，这次没有生成。请到设置的「提示词模板」里重新保存或删掉这个提示词。`)
    expect(await shownFor('en-US')).toBe(`The prompt file "${file}" cannot be read or is malformed, so nothing was generated. Resave or delete this prompt in Settings > Prompt templates.`)
    const ja = await shownFor('ja-JP')
    expect(ja).toBe(`プロンプトファイル「${file}」を読み込めないか形式が正しくないため、生成しませんでした。設定の「Prompt templates」でこのプロンプトを保存し直すか、削除してください。`)
    for (const shown of [await shownFor('en-US'), ja]) expect(shown).not.toMatch(/novel-1|SyntaxError|Expected|PROMPT_/u)

    await expect(catalog.commit({ action: 'save', scope: 'project', projectSession: session, template: { ...builtin, writingLanguage: 'zh-CN', content: '重新保存' } })).resolves.toBe(true)
    await expect(catalog.resolve(builtin.key, session)).resolves.toMatchObject({ source: 'project', template: { content: '重新保存' } })
  } finally {
    spy.mockRestore()
    warn.mockRestore()
    useLocaleStore.setState(original, true)
  }
})
