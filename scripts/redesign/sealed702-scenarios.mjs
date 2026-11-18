// #702 实机场景：作品里有读不出的生成记录，打开时提示一次（报封存的生成条数），再打开不提示。
import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { readDb, writeDb } from './f537-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const settle = page => page.waitForTimeout(400)

const LOCALES = {
  zh: { config: 'zh-CN', title: '有 AI 生成记录读不出', unit: ' 条', confirm: '知道了', spine: '创作流程',
    open: page => stage.openFromLibrary(page, STAGE_SAMPLE.name) },
  en: { config: 'en-US', title: "Some AI generation records couldn't be read", unit: ' AI generation records', confirm: 'Got it', spine: 'Writing flow',
    open: page => stage.openFromLibraryEn(page, STAGE_SAMPLE.name) },
  ja: { config: 'ja-JP', title: '読み取れない AI 生成記録があります', unit: ' 件', confirm: '了解', spine: 'Writing flow',
    open: page => stage.openFromLibraryEn(page, STAGE_SAMPLE.name) },
}

const reportsCount = (text, locale, count) => new RegExp(`(?<!\\d)${count}${locale.unit}`, 'u').test(text)

function damageTwoRoots(context) {
  writeDb(context, db => {
    const insert = db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    insert.run('sealed702-a', 'sealed702-a-key', '{坏', '{坏')
    insert.run('sealed702-b', 'sealed702-b-key', 'null', '{坏')
  })
}

const sealedCount = context => readDb(context, db =>
  db.prepare("SELECT count(*) FROM generation_roots WHERE blocked_code='GENERATION_LEDGER_UNREADABLE'").pluck().get())

const notice = (page, locale) => page.getByRole('dialog').filter({ hasText: locale.title })

/** 驱动去掉了烟测打开的环境变量，渲染端也不恢复上次的作品，冷启动应当总停在书房。 */
async function landing(page) {
  await stage.spine(page).or(page.locator('.stage-library')).first().waitFor({ state: 'visible', timeout: 30_000 })
  return await stage.spine(page).isVisible() ? 'work' : 'library'
}

/** 驱动的冷启动按中文书房判断就绪：先以中文重启，再写回目标语言并 reload。 */
async function restartIn(context, locale, beforeLaunch) {
  assert.equal((await context.invoke(context.page, 'config:set', { locale: 'zh-CN' })).success, true)
  await context.restart({ beforeLaunch })
  const landed = await landing(context.page)
  assert.equal(landed, 'library', '冷启动停在书房')
  if (locale.config === 'zh-CN') return landed
  assert.equal((await context.invoke(context.page, 'config:set', { locale: locale.config })).success, true)
  await context.reload()
  await context.page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
  return landed
}

/** 下一次 fs:list-dir 失败一次，打开作品时就会弹「部分数据加载失败」。 */
async function failNextFileTree(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('fs:list-dir')
    handlers.set('fs:list-dir', async () => {
      handlers.set('fs:list-dir', original)
      throw new Error('sealed702 合成：文件树读不出')
    })
  })
}

const promptLayers = page => page.evaluate(() => document.querySelectorAll('.pi-prompt-layer').length)

/**
 * 再打开时让读文件树失败一次，用它的报错框判断渲染端的 openProject 已走到弹提示那一步。
 * 报错框的挂载点移走和下一个提示挂上发生在同一个任务里，所以挂载点清空时还没有提示层，这次就不会再弹。
 */
async function reopenFencedByLoadError(context, locale) {
  const { page } = context
  await failNextFileTree(context.app)
  await locale.open(page)
  const loadError = page.getByRole('alertdialog')
  await loadError.waitFor({ state: 'visible', timeout: 30_000 })
  await loadError.getByRole('button').click()
  await page.waitForFunction(() => document.querySelectorAll('.pi-prompt-layer').length === 0)
  await page.getByRole('navigation', { name: locale.spine }).waitFor({ state: 'visible' })
  return notice(page, locale).count()
}

function scenario(key) {
  const locale = LOCALES[key]
  return { model: true, shell: 'stage', run: async context => {
    await seedStageSample(context)
    const landings = [await restartIn(context, locale, () => damageTwoRoots(context))]
    let page = context.page

    await locale.open(page)
    const first = notice(page, locale)
    await first.waitFor({ state: 'visible', timeout: 30_000 })
    const measured = { landings, firstNotice: await first.innerText(), sealedRoots: sealedCount(context) }
    assert.equal(measured.sealedRoots, 2)
    assert.ok(reportsCount(measured.firstNotice, locale, measured.sealedRoots), measured.firstNotice)
    assert.doesNotMatch(measured.firstNotice, /重新生成|generate again|regenerate/iu)
    await settle(page)
    await context.shoot(`sealed702-${key}-first-open`)
    await first.getByRole('button', { name: locale.confirm, exact: true }).click()
    await first.waitFor({ state: 'hidden' })

    landings.push(await restartIn(context, locale))
    page = context.page
    measured.secondOpenNotices = await reopenFencedByLoadError(context, locale)
    assert.equal(measured.secondOpenNotices, 0, '再次打开不再提示')
    measured.sealedRootsAfterReopen = sealedCount(context)
    assert.equal(measured.sealedRootsAfterReopen, 2)
    await settle(page)
    return measured
  } }
}

const afterLoadError = { model: true, shell: 'stage', run: async context => {
  await seedStageSample(context)
  const landed = await restartIn(context, LOCALES.zh, () => damageTwoRoots(context))
  const { page } = context
  await failNextFileTree(context.app)

  await LOCALES.zh.open(page)
  const loadError = page.getByRole('alertdialog').filter({ hasText: '项目已打开，部分数据加载失败' })
  await loadError.waitFor({ state: 'visible', timeout: 30_000 })
  const measured = { landed, loadError: await loadError.innerText(), promptLayersWhileErrorOpen: await promptLayers(page) }
  assert.match(measured.loadError, /文件树读不出/u)
  assert.equal(measured.promptLayersWhileErrorOpen, 1, '报错框开着时只有它一层，封存提示没挂上')
  await settle(page)
  await context.shoot('sealed702-order-1-load-error')

  await loadError.getByRole('button', { name: '确定', exact: true }).click()
  const sealed = notice(page, LOCALES.zh)
  await sealed.waitFor({ state: 'visible', timeout: 10_000 })
  measured.noticeAfterError = await sealed.innerText()
  measured.sealedRoots = sealedCount(context)
  assert.equal(measured.sealedRoots, 2)
  assert.ok(reportsCount(measured.noticeAfterError, LOCALES.zh, measured.sealedRoots), measured.noticeAfterError)
  measured.loadErrorsWhileNoticeOpen = await loadError.count()
  assert.equal(measured.loadErrorsWhileNoticeOpen, 0)
  await settle(page)
  await context.shoot('sealed702-order-2-notice')
  await sealed.getByRole('button', { name: '知道了', exact: true }).click()
  await sealed.waitFor({ state: 'hidden' })
  return measured
} }

export const SEALED702_SCENARIOS = {
  'sealed702-after-load-error-zh': afterLoadError,
  'sealed702-open-notice-zh': scenario('zh'),
  'sealed702-open-notice-en': scenario('en'),
  'sealed702-open-notice-ja': scenario('ja'),
}
