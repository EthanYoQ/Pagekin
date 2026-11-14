// #685 实机场景：书童在后台时，开关关着审稿结束不发通知；打开后第 4 章定稿结束由主进程发一条；后处理有一步失败时同样按定稿完成通知。
import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { finalizeChapter, openChapter } from './f491-scenarios.mjs'

/** 替身：主进程里只记下 Notification.show 的标题与正文，不真的弹出，免得打扰正在用电脑的人。 */
async function recordNotifications(app) {
  await app.evaluate(({ Notification }) => {
    globalThis.__f685 = []
    Notification.prototype.show = function show() { globalThis.__f685.push({ title: this.title, body: this.body }) }
  })
}

const recorded = app => app.evaluate(() => globalThis.__f685)
const windowState = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ focused: win.isFocused(), minimized: win.isMinimized() })))
const notifySwitch = page => page.getByRole('switch', { name: '在后台时通知我' })

async function showAppearance(page) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '外观')
  await notifySwitch(page).scrollIntoViewIfNeeded()
}

/** 在外观页把开关拨到 on，等写入结束后关掉设置；返回开关是否停在 on。 */
async function setNotify(page, on) {
  await showAppearance(page)
  await notifySwitch(page).setChecked(on, { force: true })
  for (const deadline = Date.now() + 5_000; await notifySwitch(page).isDisabled() && Date.now() < deadline;) await page.waitForTimeout(100)
  const settled = await notifySwitch(page).isChecked() === on
  await stage.closeSettings(page)
  return settled
}

export const F685_SCENARIOS = {
  'f685-settings': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await showAppearance(page)
    const checked = await notifySwitch(page).isChecked()
    await shoot('f685-settings')
    assert.equal(checked, true, '后台通知默认开着')
    return { checked }
  } },

  'f685-background-notice': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
    await recordNotifications(app)
    const before = await windowState(app)
    const switchedOff = await setNotify(page, false)
    await openChapter(page, 4)
    await chapterView.review(page)
    await page.waitForTimeout(2_000)
    const afterReview = await recorded(app)

    const switchedOn = await setNotify(page, true)
    await finalizeChapter(page, 4)
    for (const deadline = Date.now() + 10_000; (await recorded(app)).length === 0 && Date.now() < deadline;) await page.waitForTimeout(100)
    const afterFinalize = await recorded(app)
    await shoot('f685-background-notice')

    assert.deepEqual(before.map(win => win.focused), [false], '屏外窗口不在前台')
    assert.deepEqual({ switchedOff, switchedOn }, { switchedOff: true, switchedOn: true }, '开关能关能开')
    assert.deepEqual(afterReview, [], '关掉时审稿结束不发')
    assert.deepEqual(afterFinalize, [{ title: '第 4 章定稿完成', body: '回到书童查看结果。' }], '打开后定稿结束时主进程发了一条通知')
    return { before, switchedOff, afterReview, switchedOn, afterFinalize }
  } },

  'f685-finalize-kb-failed': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
    await recordNotifications(app)
    await app.evaluate(() => {
      const fs = globalThis.process.getBuiltinModule('node:fs')
      const linkSync = fs.linkSync
      fs.linkSync = (existing, target) => {
        if (!String(target).includes('.link-probe-')) return linkSync(existing, target)
        throw Object.assign(new Error('EISDIR: illegal operation on a directory, link'), { code: 'EISDIR' })
      }
    })
    await openChapter(page, 4)
    await chapterView.finalize(page, 4)
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
      return rows.length > 0 && rows.every(row => ['success', 'failed', 'retired'].includes(row.dataset.state))
        && !document.querySelector('.stage-capsule:not([data-tone="ok"])')
    }, null, { timeout: 90_000 })
    for (const deadline = Date.now() + 10_000; (await recorded(app)).length === 0 && Date.now() < deadline;) await page.waitForTimeout(100)
    const notices = await recorded(app)
    const steps = await chapterView.postProcessSteps(page)
    await shoot('f685-finalize-kb-failed')
    assert.equal(steps.find(step => step.label === '导入知识库')?.state, 'failed', '导入知识库失败')
    assert.deepEqual(notices, [{ title: '第 4 章定稿完成', body: '回到书童查看结果。' }], '正文已定稿，后处理有一步失败时仍按定稿完成通知')
    return { notices, steps }
  } },
}
