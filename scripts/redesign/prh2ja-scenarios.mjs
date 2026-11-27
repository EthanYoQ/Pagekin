import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as blueprint from './pages/blueprint.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

// #845 PR-H2：日文界面下三处失败提示用补译后的日文目录说明，不露码、不夹中文原文。
// 更新检查与清空的失败由替换主进程处理函数造出来，蓝图保存的失败由样书库里的触发器造出来（都是夹具）；作品内容是 seedStageSample 的样书。

const Database = createRequire(import.meta.url)('better-sqlite3')

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    return action(database)
  } finally {
    database.close()
  }
}
const NO_CODE_NO_HAN = /[A-Z][A-Z0-9]*_[A-Z0-9_]+|请|没有|失败/u

async function toJapanese(page) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '外观')
  await page.getByLabel('界面语言').selectOption('ja-JP')
  await page.waitForFunction(() => document.documentElement.lang === 'ja-JP')
}

async function replaceHandler(app, channel, result) {
  const replaced = await app.evaluate(({ ipcMain }, { channel, result }) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || !handlers.has(channel)) return false
    handlers.set(channel, async () => result)
    return true
  }, { channel, result })
  assert.ok(replaced, `能在主进程里替换 ${channel}`)
}

export const PRH2JA_SCENARIOS = {
  'prh2ja-update-check-failed': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
    const state = { status: 'error', currentVersion: '1.2.2', availableVersion: '1.2.3', updateAction: 'download', releaseName: '1.2.3', isReminderDeferred: false }
    await replaceHandler(app, 'update:get-state', { ...state, status: 'available' })
    await replaceHandler(app, 'update:check', { success: false, checked: true, updateAvailable: false, state, failure: { code: 'CHECK_FAILED', note: { key: 'error.updateNetwork' } }, retryable: true })
    await toJapanese(page)
    await stage.root(page).getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'About & updates', exact: true }).click()
    await stage.root(page).getByRole('button', { name: 'Check for updates', exact: true }).click()
    const alert = stage.root(page).getByRole('alert', { name: 'App updates' })
    await alert.waitFor({ state: 'visible' })
    const shown = await alert.innerText()
    assert.match(shown, /更新サービスに接続できませんでした。ネットワーク接続を確認してから、もう一度お試しください。/u, '日文界面按补译的日文说明网络失败')
    assert.doesNotMatch(shown, NO_CODE_NO_HAN, '不露码也不夹中文')
    await shoot('prh2ja-update-check-failed')
    return { shown }
  } },
  'prh2ja-blueprint-save-failed': { model: false, shell: 'stage', setup: async context => {
    await seedStageSample(context)
    withBook(context.samplePath, database => database.exec(`
      CREATE TRIGGER prh2ja_fail_update BEFORE UPDATE ON blueprints BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;
      CREATE TRIGGER prh2ja_fail_insert BEFORE INSERT ON blueprints BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
  }, run: async ({ page, shoot }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, 3).click()
    await blueprint.card(page).waitFor({ state: 'visible' })
    await toJapanese(page)
    await page.keyboard.press('Escape')
    await page.getByRole('textbox', { name: 'Chapter title' }).fill('霧鐘・改')
    await page.getByRole('button', { name: 'Save chapter' }).click()
    // 舞台蓝图保存走 specificWriteFailure：通用的 BLUEPRINT_WRITE_FAILED 换成本处的两句 text(zh, en)，日文界面显示英文，不用目录里的日文句子。
    const toast = page.locator('.pi-toast-body').filter({ hasText: 'Could not save the blueprint.' }).first()
    await toast.waitFor({ state: 'visible', timeout: 20_000 })
    const shown = (await toast.locator('p').allInnerTexts()).map(line => line.trim())
    assert.deepEqual(shown, ['Could not save the blueprint.', 'Could not save the chapter blueprint.'])
    assert.doesNotMatch(shown.join(' '), /malformed|SqliteError|SQLITE_/u, '不露库的原文')
    assert.doesNotMatch(shown.join(' '), NO_CODE_NO_HAN, '不露码也不夹中文')
    await shoot('prh2ja-blueprint-save-failed')
    return { shown }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER prh2ja_fail_update; DROP TRIGGER prh2ja_fail_insert;')) },
  'prh2ja-clear-failed': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
    await replaceHandler(app, 'db:project-clear-generated-data', { success: false, failure: { code: 'PROJECT_CLEAR_FAILED', note: { key: 'error.projectClearFailed' } } })
    await toJapanese(page)
    await page.keyboard.press('Escape')
    await stage.root(page).getByRole('banner').getByRole('button', { name: `“${STAGE_SAMPLE.name}” menu` }).click()
    await page.getByRole('menuitem', { name: 'Clear generated content…' }).click()
    const kinds = page.locator('.pi-check-row > .pi-check')
    await kinds.nth(0).click()
    await page.getByRole('button', { name: 'Clear selected' }).click()
    const prompt = page.locator('[role="alertdialog"]').filter({ hasText: 'Clear failed' })
    await prompt.waitFor({ state: 'visible' })
    const shown = await prompt.innerText()
    assert.match(shown, /プロジェクトの内容は何も消去されていません。消去が完了しませんでした。もう一度お試しください。/u, '日文界面按补译的日文说明没清除')
    assert.doesNotMatch(shown, NO_CODE_NO_HAN, '不露码也不夹中文')
    await shoot('prh2ja-clear-failed')
    return { shown }
  } },
}
