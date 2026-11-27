import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { renderPlotOutlineSynopsis } from '../../src/shared/plot-outline-contract.ts'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { importMaterials } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'
import { HARBOR, holdChannel, releaseChannel, seedHarbor, untilHeld } from './x1-scenarios.mjs'

const EMBEDDING_MODEL = Object.freeze({ ...FAKE_MODEL, id: 'x2-embedding', name: '驱动检索模型', modelName: 'text-embedding-3-small', purposes: ['embedding'] })

async function waitRunDone(page) {
  if (await runSheet.sheet(page).isVisible()) return runSheet.waitForRunDone(page)
  await stage.root(page).locator('.stage-capsule:not([data-tone="ok"])').waitFor({ state: 'detached', timeout: 90_000 })
}

const partialOutline = () => renderPlotOutlineSynopsis(
  Array.from({ length: 6 }, (_, index) => `## 第${index + 1}章：${stageChapterTitle(index + 1)}\n林岚在第${index + 1}夜核对雾钟与潮位。`).join('\n\n'),
  6, { totalChapters: STAGE_SAMPLE.totalChapters, writingLanguage: 'zh-CN' })

const updateSynopsis = synopsis => async ({ page, invoke, path: projectPath, session }) => {
  const updated = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, synopsis, totalChapters: STAGE_SAMPLE.totalChapters,
    wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, projectPath, session)
  assert.equal(updated.success, true, updated.error)
}

async function seedOutlineBook(context, name, { blueprints = false, finalized = false, emptyDraft = false }) {
  const { app, page, roots, invoke } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, synopsis: partialOutline(),
    totalChapters: STAGE_SAMPLE.totalChapters, wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, created.projectPath, session)).success, true)
  if (finalized) {
    const content = STAGE_SAMPLE.finalized[1]
    const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
      chapters: [{ chapterNumber: 1, title: stageChapterTitle(1), content, wordCount: countUnits(content) }] }, created.projectPath, session)
    assert.equal(imported.success, true, imported.failure?.code)
  }
  if (emptyDraft) {
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write', content: '', wordCount: 0 }, created.projectPath, session)
    assert.equal(draft.success, true, draft.failure?.code)
  }
  if (!blueprints) return
  for (const number of [1, 2, 3]) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: number, title: stageChapterTitle(number), role: '发展',
      purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: [] }, created.projectPath, session)).success, true)
  }
}

async function settledLanding(page) {
  const deadline = Date.now() + 20_000
  let last = null
  for (;;) {
    const { crumbs } = await stage.landing(page)
    const key = crumbs.join('/')
    if (key && key === last) return crumbs
    assert.ok(Date.now() < deadline, `20 秒内落点没有稳定（最后是 ${key || '空'}）`)
    last = key
    await page.waitForTimeout(500)
  }
}

async function openFolder(app, page, folder) {
  await app.evaluate(({ dialog }, selected) => {
    globalThis.__x2Dialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, folder)
  try {
    await stage.root(page).getByRole('button', { name: '打开作品', exact: true }).click()
    await stage.spine(page).waitFor({ state: 'visible' })
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__x2Dialog })
  }
}

async function recordArgs(app, channel) {
  await app.evaluate(({ ipcMain }, channel) => {
    const calls = (globalThis.__x2Args ??= {})[channel] = []
    const original = ipcMain._invokeHandlers.get(channel)
    ipcMain._invokeHandlers.set(channel, (event, ...args) => {
      calls.push(args)
      return original(event, ...args)
    })
  }, channel)
}
const recordedArgs = (app, channel) => app.evaluate((_, channel) => globalThis.__x2Args[channel], channel)

const localTime = (page, value, options) => page.evaluate(([value, options]) =>
  new Date(`${value.replace(' ', 'T')}Z`).toLocaleString('zh-CN', options), [value, options])

export const X2_SCENARIOS = {
  'x2-landing': { model: false, shell: 'stage', setup: async context => {
    await seedOutlineBook(context, '荒岛', { blueprints: false })
    await seedOutlineBook(context, '北堤', { blueprints: true })
    await seedOutlineBook(context, '南湾', { finalized: true })
    await seedOutlineBook(context, '空港', { emptyDraft: true })
    await seedStageSample(context, { open: false, beforeReload: updateSynopsis(partialOutline()) })
  }, run: async ({ app, page, samplePath, shoot }) => {
    const landed = {}
    for (const name of ['荒岛', '北堤', '南湾', '空港', STAGE_SAMPLE.name]) {
      await stage.openFromLibrary(page, name)
      landed[name] = (await settledLanding(page)).join(' / ')
      await shoot(`x2-landing-${name}`)
      await stage.backToLibrary(page, name)
    }
    await openFolder(app, page, samplePath)
    landed['灯塔（打开作品）'] = (await settledLanding(page)).join(' / ')
    const architectureState = (await stage.stageStates(page)).architecture
    const manuscript = await (async () => {
      await stage.chapterButton(page, 1).click({ timeout: 5000 })
      await stage.waitForProse(page, STAGE_SAMPLE.finalized[1].split('\n')[0].slice(0, 16))
      await stage.stageButton(page, '正文').click()
      return (await settledLanding(page)).join(' / ')
    })().catch(error => `没走通：${error.message.split('\n')[0]}`)
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    const continueWriting = await stage.overview(page, STAGE_SAMPLE.name).getByRole('button', { name: /^继续写作/ }).innerText()
    await shoot('x2-landing-continue')
    const measured = { landed, architectureState, manuscript, continueWriting }
    assert.deepEqual({ landed, manuscript, continueWriting }, {
      landed: { 荒岛: '架构', 北堤: '正文 / 第 1 章', 南湾: '正文 / 第 1 章', 空港: '架构',
        [STAGE_SAMPLE.name]: '正文 / 第 4 章', '灯塔（打开作品）': '正文 / 第 4 章' },
      manuscript: '正文 / 第 4 章',
      continueWriting: '继续写作 · 第 4 章 · 待审稿',
    }, JSON.stringify(measured))
    return measured
  } },

  'x2-outline': { model: false, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: updateSynopsis(`${partialOutline()}\n`) }),
    run: async ({ page, shoot }) => {
      await architecture.open(page)
      const shown = {
        badge: await architecture.badge(page, 'synopsis').innerText(),
        progress: (await architecture.page(page).locator('.arch-progress').innerText()).trim(),
        next: await architecture.next(page).isEnabled(),
      }
      if (shown.next) {
        await stage.root(page).getByRole('button', { name: '架构的更多操作' }).click()
        await page.getByRole('menuitem', { name: 'AI 生成架构…' }).click()
      } else await architecture.primary(page).click()
      await architecture.dialog(page).waitFor({ state: 'visible' })
      if (!await architecture.dialog(page).locator('[data-step="synopsis"] input[type="checkbox"]').isChecked()) await architecture.stepCheck(page, 'synopsis').click()
      await architecture.setRange(page, 1, 12)
      const range = {
        mark: await architecture.mark(page, 'synopsis').innerText(),
        submit: await architecture.dialog(page).getByRole('button', { name: /开始生成 \d 项/ }).isEnabled(),
      }
      await shoot('x2-outline-range')
      await architecture.dialog(page).getByRole('button', { name: '取消', exact: true }).click()
      const measured = { shown, range }
      assert.deepEqual(measured, { shown: { badge: '不完整', progress: '· 3 / 4 已确认', next: false }, range: { mark: '范围无效', submit: false } }, JSON.stringify(measured))
      return measured
    } },

  'x2-library-overview': { model: false, shell: 'stage', setup: async context => {
    await seedHarbor(context)
    await seedStageSample(context)
  }, run: async ({ page, shoot }) => {
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    const current = stage.overview(page, STAGE_SAMPLE.name)
    const excerpt = current.locator('.stage-ov-excerpt')
    await excerpt.waitFor({ state: 'visible', timeout: 15_000 })
    await stage.previewBook(page, HARBOR)
    await stage.overview(page, HARBOR).getByRole('button', { name: `打开《${HARBOR}》` }).waitFor({ state: 'visible' })
    await stage.overview(page, HARBOR).getByRole('button', { name: `回到《${STAGE_SAMPLE.name}》` }).click()
    await page.waitForTimeout(2000)
    const back = { busy: await current.getAttribute('aria-busy'), excerpt: await excerpt.isVisible() }
    await shoot('x2-library-back')

    await stage.previewBook(page, HARBOR)
    await stage.overview(page, HARBOR).getByRole('button', { name: `打开《${HARBOR}》` }).waitFor({ state: 'visible' })
    await stage.bookMenu(page, HARBOR, '从最近项目移除…')
    await page.getByRole('dialog').getByRole('button', { name: '移除记录' }).click()
    await stage.cover(page, HARBOR).waitFor({ state: 'detached' })
    await page.waitForTimeout(1500)
    const removed = { busy: await current.getAttribute('aria-busy'), excerpt: await excerpt.isVisible() }
    const measured = { back, removed }
    assert.deepEqual(measured, { back: { busy: 'false', excerpt: true }, removed: { busy: 'false', excerpt: true } }, JSON.stringify(measured))
    return measured
  } },

  'x2-history': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, invoke, shoot }) => {
    await watchSession(app)
    await refs.open(page, 'history')
    const chapter3 = refs.historyChapters(page).getByRole('button', { name: /雾钟/ })
    await chapter3.click()
    await refs.timeline(page).waitFor({ state: 'visible' })
    const historyTime = (await refs.timeline(page).locator('.stage-hist-meta').last().innerText()).split(' · ').at(-1)
    await chapter3.click()
    await page.waitForTimeout(1500)
    const reclicked = { timeline: await refs.timeline(page).isVisible() }

    await holdChannel(app, 'db:draft-list')
    await refs.historyChapters(page).getByRole('button', { name: /守塔人/ }).click()
    await untilHeld(app, 'db:draft-list')
    const whileLoading = await page.getByRole('region', { name: '这一章的各稿' }).locator('.stage-hist-help').innerText()
    await shoot('x2-history-loading')
    await releaseChannel(app, 'db:draft-list')
    await page.waitForTimeout(1000)

    await stage.tab(page, /^第 3 章/).click()
    await chapterView.versionButton(page).click()
    const switcherTime = (await page.getByRole('menu', { name: '本章版本' }).getByRole('menuitemradio').first().locator('small').innerText()).split(' · ').at(-1)
    await page.keyboard.press('Escape')

    const session = await app.evaluate(() => globalThis.__x2Session)
    const [draft] = await invoke(page, 'db:draft-list', 3, session.projectPath, session)
    const expected = {
      history: await localTime(page, draft.createdAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      switcher: await localTime(page, draft.updatedAt ?? draft.createdAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    }
    const shown = { reclicked, whileLoading, times: { history: historyTime, switcher: switcherTime } }
    const measured = { ...shown, expected, stored: { createdAt: draft.createdAt, updatedAt: draft.updatedAt } }
    assert.deepEqual(shown, { reclicked: { timeline: true }, whileLoading: '正在读取…', times: expected }, JSON.stringify(measured))
    return measured
  } },

  'kb-local-keyless': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    const model = { ...EMBEDDING_MODEL, id: 'kb-local-embedding', name: '本机检索模型', provider: 'custom',
      baseUrl: `http://127.0.0.1:${context.fake.port}/v1`, apiKey: '' }
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', model.id)).success, true)
  } }), run: async context => {
    const { page, fake, shoot } = context
    fake.acceptKeylessEmbeddings()
    await importMaterials(context)
    const importEmbeddings = fake.embeddingAuthorizations.length
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '检索模型')
    const index = stage.root(page).getByRole('region', { name: '当前作品的检索索引' })
    const rebuild = index.getByRole('button', { name: '检查并重建向量索引' })
    const offered = await rebuild.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
    const before = { offered, text: await index.innerText() }
    if (offered) {
      await shoot('kb-local-keyless-before-rebuild')
      await rebuild.click()
      await index.getByRole('button', { name: '检查与重建中…' }).waitFor({ state: 'detached', timeout: 30_000 })
      await index.getByRole('heading', { name: '检查当前模型的向量索引' }).waitFor({ state: 'visible', timeout: 30_000 })
    }
    const after = { text: await index.innerText(), alerts: await index.getByRole('alert').allInnerTexts() }
    const authorizations = [...new Set(fake.embeddingAuthorizations)]
    const measured = { before, after, importEmbeddings, rebuildEmbeddings: fake.embeddingAuthorizations.length - importEmbeddings, authorizations }
    assert.deepEqual({ offered, alerts: after.alerts, importEmbeddings, rebuilt: measured.rebuildEmbeddings > 0, keyless: authorizations.every(value => !(value ?? '').replace(/^Bearer\s*/u, '')) },
      { offered: true, alerts: [], importEmbeddings: 0, rebuilt: true, keyless: true }, JSON.stringify(measured))
    return measured
  } },

  'kb-embedding-unreachable': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    const model = { ...EMBEDDING_MODEL, id: 'kb-unreachable-embedding', name: '本机检索模型', provider: 'custom', baseUrl: `http://127.0.0.1:${context.fake.port}/v1`, apiKey: '' }
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', model.id)).success, true)
  } }), run: async context => {
    const { page, invoke, reload, shoot, fake } = context
    await importMaterials(context)
    await fake.close()
    const ZH = { spine: '创作流程', settings: '设置', sections: '设置分组', page: '检索模型', region: '当前作品的检索索引' }
    const EN = { spine: 'Writing flow', settings: 'Settings', sections: 'Settings sections', page: 'Retrieval model', region: 'Search index of the current book' }
    const openIndex = async labels => {
      await page.getByRole('navigation', { name: labels.spine }).getByRole('button', { name: labels.settings, exact: true }).click()
      await stage.root(page).getByRole('navigation', { name: labels.sections }).getByRole('button', { name: labels.page, exact: true }).click()
      return stage.root(page).getByRole('region', { name: labels.region })
    }
    const rebuildFailure = async (index, shot) => {
      await index.getByRole('button').first().click()
      const toast = page.locator(stage.LIVE_TOAST).last()
      await toast.waitFor({ state: 'visible', timeout: 30_000 })
      const shown = (await toast.innerText()).trim()
      await shoot(`kb-embedding-unreachable-${shot}`)
      await toast.getByRole('button').click()
      await page.locator(stage.LIVE_TOAST).waitFor({ state: 'detached' })
      return shown
    }
    const switchLocale = async (locale, library, open, flow) => {
      assert.equal((await invoke(page, 'config:set', { locale })).success, true)
      await reload()
      await page.getByRole('list', { name: library }).waitFor({ state: 'visible' })
      await open(page, STAGE_SAMPLE.name)
      await page.getByRole('navigation', { name: flow }).waitFor({ state: 'visible' })
    }
    const measured = { refused: { 'zh-CN': await rebuildFailure(await openIndex(ZH), 'zh') } }
    await switchLocale('en-US', 'Recent books', stage.openFromLibraryEn, EN.spine)
    const indexEn = await openIndex(EN)
    measured.refused['en-US'] = await rebuildFailure(indexEn, 'en')
    await context.app.evaluate(({ ipcMain }) => {
      ipcMain._invokeHandlers.set('kb:backfill-vectors', async () => ({ success: false, processed: 0, failed: 0, error: 'EMBEDDING_CONNECTION_FAILED' }))
    })
    measured.unclassified = { 'en-US': await rebuildFailure(indexEn, 'unclassified-en') }
    await switchLocale('zh-CN', '最近的作品', stage.openFromLibrary, ZH.spine)
    measured.unclassified['zh-CN'] = await rebuildFailure(await openIndex(ZH), 'unclassified-zh')
    assert.deepEqual(measured, {
      refused: {
        'zh-CN': '重建检索失败：base_url 上没有服务在响应。请确认模型服务已启动，端口填写正确。',
        'en-US': 'Could not rebuild search. Nothing is answering at the base_url. Make sure the model service is running and the port is correct.',
      },
      unclassified: {
        'en-US': 'Could not rebuild search. The retrieval model could not be reached, so the search index was not changed. Check its Base URL, network, or proxy on the Retrieval model page in Settings, then try again.',
        'zh-CN': '重建检索失败：连不上检索模型，检索索引没有改动。请在设置的「检索模型」页检查 Base URL、网络或代理后重试。',
      },
    }, JSON.stringify(measured))
    return measured
  } },

  'kb-damaged-index-rebuild': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    const model = { ...EMBEDDING_MODEL, id: 'kb-damaged-embedding', name: '本机检索模型', provider: 'custom', baseUrl: `http://127.0.0.1:${context.fake.port}/v1`, apiKey: '' }
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', model.id)).success, true)
  } }), run: async context => {
    const { app, page, invoke, reload, shoot } = context
    await importMaterials(context)
    const ZH = { spine: '创作流程', settings: '设置', sections: '设置分组', page: '检索模型', region: '当前作品的检索索引', library: '最近的作品', open: stage.openFromLibrary }
    const EN = { spine: 'Writing flow', settings: 'Settings', sections: 'Settings sections', page: 'Retrieval model', region: 'Search index of the current book', library: 'Recent books', open: stage.openFromLibraryEn }
    const openIndex = async labels => {
      await page.getByRole('navigation', { name: labels.spine }).getByRole('button', { name: labels.settings, exact: true }).click()
      await stage.root(page).getByRole('navigation', { name: labels.sections }).getByRole('button', { name: labels.page, exact: true }).click()
      return stage.root(page).getByRole('region', { name: labels.region })
    }
    const switchLocale = async (locale, labels) => {
      assert.equal((await invoke(page, 'config:set', { locale })).success, true)
      await reload()
      await page.getByRole('list', { name: labels.library }).waitFor({ state: 'visible' })
      await labels.open(page, STAGE_SAMPLE.name)
      await page.getByRole('navigation', { name: labels.spine }).waitFor({ state: 'visible' })
      return openIndex(labels)
    }
    const rebuildFailure = async (index, code, shot) => {
      await app.evaluate(({ ipcMain }, error) => {
        ipcMain._invokeHandlers.set('kb:backfill-vectors', async () => ({ success: false, processed: 0, failed: 0, error }))
      }, code)
      await index.getByRole('button').first().click()
      const toast = page.locator(stage.LIVE_TOAST).last()
      await toast.waitFor({ state: 'visible', timeout: 30_000 })
      const shown = (await toast.innerText()).trim()
      await shoot(`kb-damaged-index-rebuild-${shot}`)
      await toast.getByRole('button').click()
      await page.locator(stage.LIVE_TOAST).waitFor({ state: 'detached' })
      return shown
    }
    const statusShown = async (index, shot) => {
      const line = index.getByText(/知识库这次操作出了意外问题|Something unexpected went wrong in the knowledge base/u)
      await line.waitFor({ state: 'visible', timeout: 30_000 })
      await shoot(`kb-damaged-index-rebuild-${shot}`)
      return (await line.innerText()).trim()
    }
    const indexZh = await openIndex(ZH)
    const measured = {
      diskFull: { 'zh-CN': await rebuildFailure(indexZh, 'KNOWLEDGE_BASE_DISK_FULL', 'disk-full-zh') },
      unwritable: { 'zh-CN': await rebuildFailure(indexZh, 'KNOWLEDGE_BASE_UNWRITABLE', 'unwritable-zh') },
    }
    const indexEn = await switchLocale('en-US', EN)
    measured.diskFull['en-US'] = await rebuildFailure(indexEn, 'KNOWLEDGE_BASE_DISK_FULL', 'disk-full-en')
    measured.unwritable['en-US'] = await rebuildFailure(indexEn, 'KNOWLEDGE_BASE_UNWRITABLE', 'unwritable-en')
    const removed = await app.evaluate((_electron, lance) => {
      const fs = process.getBuiltinModule('node:fs')
      const path = process.getBuiltinModule('node:path')
      const files = fs.readdirSync(lance).flatMap(table => {
        const data = path.join(lance, table, 'data')
        return fs.existsSync(data) ? fs.readdirSync(data).map(file => path.join(data, file)) : []
      })
      for (const file of files) fs.rmSync(file)
      return files.length
    }, `${context.samplePath}/.ai-novel/lancedb`)
    assert.ok(removed > 0, '删掉了检索索引的数据文件')
    measured.damaged = { 'zh-CN': await statusShown(await switchLocale('zh-CN', ZH), 'damaged-zh') }
    measured.damaged['en-US'] = await statusShown(await switchLocale('en-US', EN), 'damaged-en')
    assert.deepEqual(measured, {
      diskFull: {
        'zh-CN': '重建检索失败：磁盘空间不足，知识库写不进去。清理磁盘后再试一次。',
        'en-US': 'Could not rebuild search. The disk is full, so the knowledge base could not be written. Free up space, then try again.',
      },
      unwritable: {
        'zh-CN': '重建检索失败：作品文件夹写不进去，可能是只读，或被同步盘、杀毒软件占用。关掉这些程序后再试一次。',
        'en-US': 'Could not rebuild search. The book folder could not be written; it may be read-only or locked by sync or antivirus software. Close those programs, then try again.',
      },
      damaged: {
        'zh-CN': '知识库这次操作出了意外问题。请再试一次，还不行请把这条提示反馈给我们。',
        'en-US': 'Something unexpected went wrong in the knowledge base. Try again; if it keeps happening, send us this message.',
      },
    }, JSON.stringify(measured))
    return measured
  } },

  'x2-index-model': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    assert.equal((await invoke(page, 'llm:save-model', EMBEDDING_MODEL)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', EMBEDDING_MODEL.id)).success, true)
  } }), run: async context => {
    const { page, invoke, shoot } = context
    await importMaterials(context)
    assert.equal((await invoke(page, 'llm:delete-model', FAKE_MODEL.id)).success, true)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '检索模型')
    const index = stage.root(page).getByRole('region', { name: '当前作品的检索索引' })
    await index.getByRole('button').first().waitFor({ state: 'visible', timeout: 15_000 })
    const before = { buttons: await index.getByRole('button').allInnerTexts() }
    await stage.root(page).getByRole('button', { name: `「${EMBEDDING_MODEL.name}」更多操作` }).click()
    await page.getByRole('menuitem', { name: '删除模型…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除模型', exact: true }).click()
    await stage.root(page).getByRole('heading', { name: '还没有检索模型' }).waitFor({ state: 'visible' })
    await page.waitForTimeout(2000)
    await shoot('x2-index-model-deleted')
    const after = { buttons: await index.getByRole('button').allInnerTexts(), text: await index.innerText() }
    const measured = { before, after }
    assert.deepEqual({ before: before.buttons.length > 0, after: after.buttons, unconfigured: after.text.includes('配置并启用检索模型后') },
      { before: true, after: [], unconfigured: true }, JSON.stringify(measured))
    return measured
  } },

  'x2-kb-limit': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page } = context
    await importMaterials(context)
    await recordArgs(app, 'kb:search')
    await refs.search(page, '守塔人')
    await refs.searchInput(page).fill('还没提交的字')
    await stage.root(page).locator('.stage-kb-topk').selectOption('5')
    await page.waitForTimeout(2000)
    const searches = (await recordedArgs(app, 'kb:search')).map(args => args.slice(0, 2))
    assert.deepEqual(searches, [['守塔人', 10], ['守塔人', 5]], JSON.stringify(searches))
    return { searches }
  } },

  'x2-cast': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await architecture.open(page)
    await architecture.openCast(page)
    const avatar = stage.root(page).getByRole('button', { name: /^(选择|更换)头像$/ })
    const views = {}
    for (const view of ['基础设定', '当前状态', '关系图谱']) {
      await stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name: view, exact: true }).click()
      await page.waitForTimeout(300)
      views[view] = await avatar.count()
    }
    await stage.root(page).getByRole('button', { name: '粘贴 / 导入角色卡' }).click()
    const source = page.getByRole('dialog').getByRole('textbox', { name: '角色卡全文' })
    await source.waitFor({ state: 'visible' })
    const box = await source.evaluate(element => ({ rows: element.rows, height: Math.round(element.getBoundingClientRect().height),
      lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)) }))
    await shoot('x2-cast-paste')
    await page.getByRole('dialog').getByRole('button', { name: '暂不导入' }).click()
    const measured = { views, box }
    assert.deepEqual({ views, atLeastNineLines: box.lines >= 9 }, { views: { 基础设定: 1, 当前状态: 0, 关系图谱: 0 }, atLeastNineLines: true }, JSON.stringify(measured))
    return measured
  } },

  'x2-recheck': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    fake.replyReview(JSON.stringify({ summary: '本章目标还没落地。', items: [
      { category: '连续性', severity: 'warning', description: '核对钟声提前一刻与潮位的关系。', quote: '他给林岚倒了一杯很淡的茶' },
    ], goalReviews: [{ id: 'ch4:keyEvents:1', status: 'unmet', description: '林岚还没有在灯塔里找到新的线索。',
      evidence: [{ quote: '守塔人的屋子在灯塔背风的一侧' }] }] }))
    await chapterView.open(page, 4)
    await chapterView.review(page)
    await waitRunDone(page)
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page)
    await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const deadline = Date.now() + 60_000
    while (fake.chats.length < 3) {
      assert.ok(Date.now() < deadline, `60 秒内没有发出合并后的复验（对话请求 ${fake.chats.map(chat => chat.kind).join('、')}）`)
      await page.waitForTimeout(250)
    }
    await stage.root(page).locator('.stage-capsule:not([data-tone="ok"])').waitFor({ state: 'detached', timeout: 90_000 })
    await page.waitForTimeout(3000)
    const hint = await chapterView.hint(page).innerText()
    await chapterView.more(page, '审稿报告')
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await shoot('x2-recheck-sheet')
    const statuses = await chapterView.reviewSheet(page).getByText(/^复验：/).allInnerTexts()
    const measured = { hint, statuses }
    assert.match(hint, /^复验完成：\d+ \/ \d+ 项意见已解决$/, JSON.stringify(measured))
    assert.ok(statuses.length > 0, JSON.stringify(measured))
    return measured
  } },

  'x2-blueprint-save': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, 5).click()
    await blueprint.titleInput(page).fill('潮汐表的背面')
    await blueprint.card(page).getByRole('button', { name: '保存此章' }).click()
    await blueprint.card(page).getByRole('button', { name: '保存此章' }).waitFor({ state: 'visible' })
    await page.waitForTimeout(2000)
    await stage.tab(page, /^第 3 章/).click()
    const row = await stage.chapterButton(page, 5).innerText()
    assert.match(row, /潮汐表的背面/, row)
    return { row }
  } },

  'x2-open-chapter': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await holdChannel(app, 'db:draft-get-full')
    await stage.chapterButton(page, 4).click()
    await untilHeld(app, 'db:draft-get-full')
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    await releaseChannel(app, 'db:draft-get-full')
    await page.waitForTimeout(2000)
    const after = { setup: await stage.setupOutline(page).isVisible(), crumbs: (await stage.landing(page)).crumbs.join(' / ') }
    assert.deepEqual(after, { setup: true, crumbs: '设定' }, JSON.stringify(after))
    return after
  } },
}

async function watchSession(app) {
  await app.evaluate(({ ipcMain }) => {
    for (const [channel, handler] of ipcMain._invokeHandlers) {
      ipcMain._invokeHandlers.set(channel, (event, ...args) => {
        const session = args.at(-1)
        if (session && typeof session === 'object' && 'leaseId' in session) globalThis.__x2Session = session
        return handler(event, ...args)
      })
    }
  })
}
