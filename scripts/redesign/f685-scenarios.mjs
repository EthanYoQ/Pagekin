import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { finalizeChapter, openChapter } from './f491-scenarios.mjs'

/** 替身：只记录 Notification.show 的标题与正文，不真的弹出。 */
async function recordNotifications(app) {
  await app.evaluate(({ Notification }) => {
    globalThis.__f685 = []
    Notification.prototype.show = function show() { globalThis.__f685.push({ title: this.title, body: this.body }) }
  })
}

const recorded = app => app.evaluate(() => globalThis.__f685)
async function notices(app, page) {
  await runSheet.lastRun(page).waitFor({ state: 'visible', timeout: 120_000 })
  for (const deadline = Date.now() + 10_000; (await recorded(app)).length === 0 && Date.now() < deadline;) await page.waitForTimeout(100)
  await page.waitForTimeout(2_000)
  return recorded(app)
}
const windowState = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ focused: win.isFocused(), minimized: win.isMinimized() })))
const withoutChapters3And4 = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  for (const chapterNumber of [3, 4]) {
    for (const draft of await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
    }
  }
} })
const notifySwitch = page => page.getByRole('switch', { name: '在后台时通知我' })

async function showAppearance(page) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '外观')
  await notifySwitch(page).scrollIntoViewIfNeeded()
}

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
    assert.deepEqual(notices, [{ title: '第 4 章已定稿，有一步没完成', body: '回到书童查看并重试。' }], '正文已定稿、后处理有一步失败时如实写没完成')
    return { notices, steps }
  } },

  'f685-batch-notice': { model: true, shell: 'stage', setup: withoutChapters3And4, run: async ({ app, page, shoot }) => {
    await recordNotifications(app)
    await blueprint.open(page)
    await blueprint.startBatch(page, 1)
    await runSheet.waitUntilOpen(page)
    const finished = await notices(app, page)
    await shoot('f685-batch-notice')
    assert.deepEqual(finished, [{ title: '第 3 章批量创作完成', body: '回到书童查看结果。' }], '整批写完发一条')
    return { finished, lastRun: await runSheet.lastRun(page).innerText() }
  } },

  'f685-batch-stopped': { model: true, shell: 'stage', setup: withoutChapters3And4, run: async ({ app, page, shoot }) => {
    await recordNotifications(app)
    await blueprint.open(page)
    await blueprint.startBatch(page, 2)
    await runSheet.waitUntilOpen(page)
    const stopped = await notices(app, page)
    const lastRun = await runSheet.lastRun(page).innerText()
    await shoot('f685-batch-stopped')
    assert.match(lastRun, /第 3 章 · 生成草稿待审[\s\S]*第 4 章 · 生成草稿待审\s*失败/u, '夹具模型两章回同一段正文，第 4 章被判与上一章重演而失败')
    assert.deepEqual(stopped, [{ title: '批量创作停在第 4 章', body: '已完成 1 章，回到书童查看原因。' }], '第 3 章写完不单独发，整批停下时只发一条')
    return { stopped, lastRun }
  } },
}
