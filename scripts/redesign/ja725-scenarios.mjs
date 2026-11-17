// #722 Phase 1（PR #725）：设置 → 外观 → 界面语言选「日本語」。未翻译的内联文案是英文，已登记错误码按日文目录说明；切回中文恢复。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as bookshelf from './pages/bookshelf.mjs'
import * as stage from './pages/stage.mjs'

const settle = page => page.waitForTimeout(400)
const BOOK = '雾岛'

export const JA725_SCENARIOS = {
  'ja725-interface-language': { model: false, shell: 'stage', run: async context => {
    const { app, roots, invoke, shoot } = context
    let { page } = context
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, roots.projects)
    await bookshelf.createProject(page, BOOK)
    await stage.spine(page).waitFor({ state: 'visible' })
    await stage.backToLibrary(page, BOOK)

    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('ja-JP')
    const select = page.getByLabel('Interface language')
    await select.waitFor({ state: 'visible' })
    await stage.root(page).getByRole('heading', { level: 1, name: 'Appearance', exact: true }).waitFor({ state: 'visible' })
    const observed = {
      lang: await page.evaluate(() => document.documentElement.lang),
      selected: await select.evaluate(element => element.selectedOptions[0]?.textContent),
      saved: (await invoke(page, 'config:get')).locale,
    }
    await settle(page)
    await shoot('settings-ja')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })

    // 最近作品的文件夹在应用外被移走，再从书房打开。驱动的重启按中文书房判断就绪，先切回中文；重启后写回日语再 reload，界面按保存的设置启动。
    assert.equal((await invoke(page, 'config:set', { locale: 'zh-CN' })).success, true)
    await context.restart()
    page = context.page
    fs.rmSync(path.join(roots.projects, BOOK), { recursive: true, force: true })
    assert.equal((await invoke(page, 'config:set', { locale: 'ja-JP' })).success, true)
    await context.reload()
    await page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
    observed.langAfterReload = await page.evaluate(() => document.documentElement.lang)
    await stage.openFromLibraryEn(page, BOOK)
    const alert = page.getByRole('alertdialog')
    await alert.waitFor({ state: 'visible' })
    observed.missing = await alert.innerText()
    await settle(page)
    await shoot('project-missing-ja')
    await alert.getByRole('button', { name: 'OK', exact: true }).click()
    await alert.waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')

    await stage.root(page).getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await stage.root(page).getByRole('heading', { level: 1, name: '外观', exact: true }).waitFor({ state: 'visible' })
    observed.back = {
      lang: await page.evaluate(() => document.documentElement.lang),
      saved: (await invoke(page, 'config:get')).locale,
    }
    await settle(page)
    await shoot('settings-zh')

    assert.deepEqual(
      { lang: observed.lang, selected: observed.selected, saved: observed.saved, langAfterReload: observed.langAfterReload },
      { lang: 'ja-JP', selected: '日本語', saved: 'ja-JP', langAfterReload: 'ja-JP' },
    )
    assert.match(observed.missing, /プロジェクトフォルダーが見つかりません/u, '已登记错误码按日文目录说明')
    assert.doesNotMatch(observed.missing, /[A-Z]{3,}_[A-Z]/u, '报错不露错误码')
    assert.deepEqual(observed.back, { lang: 'zh-CN', saved: 'zh-CN' })
    return observed
  } },
}
