// #702 实机场景：作品里有读不出的生成记录，打开时提示一次（报封存的生成条数），再打开不提示。
import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { readDb, writeDb } from './f537-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const settle = page => page.waitForTimeout(400)

const LOCALES = {
  zh: { config: 'zh-CN', title: '有 AI 生成记录读不出', count: '2 条', confirm: '知道了', spine: '创作流程',
    open: page => stage.openFromLibrary(page, STAGE_SAMPLE.name) },
  en: { config: 'en-US', title: "Some AI generation records couldn't be read", count: '2 AI generation records', confirm: 'Got it', spine: 'Writing flow',
    open: page => stage.openFromLibraryEn(page, STAGE_SAMPLE.name) },
  ja: { config: 'ja-JP', title: '読み取れない AI 生成記録があります', count: '2 件', confirm: '了解', spine: 'Writing flow',
    open: page => stage.openFromLibraryEn(page, STAGE_SAMPLE.name) },
}

/** 两个根各坏两格（共四格），期望报 2：数的是生成（根），不是格子。 */
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

/** 驱动的冷启动按中文书房判断就绪：先以中文重启，再写回目标语言并 reload。 */
async function restartIn(context, locale, beforeLaunch) {
  assert.equal((await context.invoke(context.page, 'config:set', { locale: 'zh-CN' })).success, true)
  await context.restart({ beforeLaunch })
  if (locale.config === 'zh-CN') return
  assert.equal((await context.invoke(context.page, 'config:set', { locale: locale.config })).success, true)
  await context.reload()
  await context.page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
}

function scenario(key) {
  const locale = LOCALES[key]
  return { model: true, shell: 'stage', run: async context => {
    await seedStageSample(context)
    await restartIn(context, locale, () => damageTwoRoots(context))
    let page = context.page

    await locale.open(page)
    const first = notice(page, locale)
    await first.waitFor({ state: 'visible', timeout: 30_000 })
    const measured = { firstNotice: await first.innerText(), sealedRoots: sealedCount(context) }
    assert.ok(measured.firstNotice.includes(locale.count), measured.firstNotice)
    assert.doesNotMatch(measured.firstNotice, /重新生成|generate again|regenerate/iu)
    assert.equal(measured.sealedRoots, 2)
    await settle(page)
    await context.shoot(`sealed702-${key}-first-open`)
    await first.getByRole('button', { name: locale.confirm, exact: true }).click()
    await first.waitFor({ state: 'hidden' })

    await restartIn(context, locale)
    page = context.page
    await locale.open(page)
    await page.getByRole('navigation', { name: locale.spine }).waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(1_500)
    measured.secondOpenNotices = await notice(page, locale).count()
    assert.equal(measured.secondOpenNotices, 0, '再次打开不再提示')
    measured.sealedRootsAfterReopen = sealedCount(context)
    assert.equal(measured.sealedRootsAfterReopen, 2)
    await settle(page)
    return measured
  } }
}

export const SEALED702_SCENARIOS = {
  'sealed702-open-notice-zh': scenario('zh'),
  'sealed702-open-notice-en': scenario('en'),
  'sealed702-open-notice-ja': scenario('ja'),
}
