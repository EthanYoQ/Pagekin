import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { FAKE_MODEL } from './fake-model.mjs'
import * as refs from './pages/refs.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const settle = page => page.waitForTimeout(400)
const SECOND_MODEL = { ...FAKE_MODEL, id: 'f949-second', name: '备用夹具模型' }

const settingsButton = /^(设置|Settings)$/u
const settingsNav = page => stage.root(page).getByRole('navigation', { name: /^(设置分组|Settings sections)$/u })

async function openSettings(page) {
  const spine = page.getByRole('navigation', { name: /^(创作流程|写作流程|Writing flow)$/u })
  if (await spine.isVisible()) await spine.getByRole('button', { name: settingsButton }).click()
  else await stage.root(page).getByRole('banner').getByRole('button', { name: settingsButton }).click()
  await settingsNav(page).waitFor({ state: 'visible' })
}

async function setInterfaceLocale(page, locale) {
  await openSettings(page)
  await settingsNav(page).getByRole('button', { name: /^(外观|Appearance)$/u }).click()
  await page.getByLabel(/^(界面语言|Interface language)$/u).selectOption(locale)
  await page.keyboard.press('Escape')
  await settingsNav(page).waitFor({ state: 'detached' })
}

const withSecondModel = context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
  assert.equal((await invoke(page, 'llm:save-model', SECOND_MODEL)).success, true)
} })

async function defaultModelFails({ app, page, shoot }, locale, expected) {
  await setInterfaceLocale(page, locale)
  assert.ok(await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    if (!handlers.get('llm:set-default-model')) return false
    handlers.set('llm:set-default-model', async () => ({ success: false }))
    return true
  }), '能让主进程保存默认模型失败且不给原因')
  await openSettings(page)
  await settingsNav(page).getByRole('button', { name: /^(AI 模型|AI models)$/u }).click()
  await stage.root(page).getByRole('button', { name: new RegExp(`^(「${SECOND_MODEL.name}」更多操作|More for “${SECOND_MODEL.name}”)$`, 'u') }).click()
  await page.getByRole('menuitem', { name: /^(设为默认|Make default)$/u }).click()
  const alert = page.getByRole('alertdialog')
  await alert.waitFor({ state: 'visible', timeout: 15_000 })
  const observed = { alert: (await alert.innerText()).trim(), lang: await page.evaluate(() => document.documentElement.lang) }
  await settle(page)
  await shoot(`f949-default-model-failed-${locale}`)
  assert.equal(observed.lang, locale)
  assert.ok(observed.alert.includes(expected), `提示写出动作名：${observed.alert}`)
  assert.doesNotMatch(observed.alert, /\p{Script=Han}/u.test(expected) ? /save the default model/u : /保存默认模型/u, '动作名不混用别的语言')
  return observed
}

export const F949_SCENARIOS = {
  'f949-material-read-zh': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, shoot }) => {
    const file = path.join(roots.temp, '旧港笔记.txt')
    fs.writeFileSync(file, '旧港的潮水刚退。')
    assert.ok(await app.evaluate(({ dialog, ipcMain }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      const handlers = ipcMain._invokeHandlers
      if (!handlers.get('fs:grant-read-file')) return false
      handlers.set('fs:grant-read-file', async () => ({ success: false, content: '' }))
      return true
    }, file), '能让主进程读资料失败且不给原因')
    await refs.open(page, 'knowledge')
    await refs.materials(page).getByRole('button', { name: '导入创作资料' }).click()
    const toast = stage.toastStack(page).locator(stage.LIVE_TOAST).filter({ hasText: '旧港笔记.txt' }).last()
    await toast.waitFor({ state: 'visible', timeout: 15_000 })
    const shown = (await toast.innerText()).trim()
    await settle(page)
    await shoot('f949-material-read-zh')
    assert.ok(shown.includes('读不了「旧港笔记.txt」，请重新选择。'), `提示说出是哪个文件：${shown}`)
    assert.doesNotMatch(shown, /Could not read|出了意外问题/u, '不露英文原文，也不落成通用说明')
    return { toast: shown }
  } },
  'f949-default-model-failed-en-US': { model: false, shell: 'stage', setup: withSecondModel,
    run: context => defaultModelFails(context, 'en-US', 'Could not save the default model. Try again.') },
  'f949-default-model-failed-ja-JP': { model: false, shell: 'stage', setup: withSecondModel,
    run: context => defaultModelFails(context, 'ja-JP', '既定モデルの保存に失敗しました。もう一度お試しください。') },
}
