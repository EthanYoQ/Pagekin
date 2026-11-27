import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

// 英文界面导出时写文件失败，主进程只给 IPC_HANDLER_FAILED（handle() 换掉原文后的样子）：作者看到这处的兜底说明。
// 失败由替换主进程 fs:grant-write-file 处理函数造出来（夹具），作品内容是 seedStageSample 的样书。

export const I897_SCENARIOS = {
  'i897-export-write-fallback-en': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, shoot }) => {
    const target = path.join(roots.projects, 'i897-export')
    fs.mkdirSync(target, { recursive: true })
    await app.evaluate(({ dialog, ipcMain }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
      ipcMain._invokeHandlers.set('fs:grant-write-file', async () => ({ success: false, error: 'IPC_HANDLER_FAILED' }))
    }, target)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.waitForFunction(() => document.documentElement.lang === 'en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
    await stage.root(page).getByRole('banner').getByRole('button', { name: `“${STAGE_SAMPLE.name}” menu` }).click()
    await page.getByRole('menuitem', { name: 'Export…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Export project' })
    await dialog.getByRole('button', { name: 'Choose folder and export', exact: true }).click()
    const failure = dialog.getByText('Failed to write the exported file.', { exact: true })
    await failure.waitFor({ state: 'visible', timeout: 30_000 })
    const dialogText = await dialog.innerText()
    assert.doesNotMatch(dialogText, /IPC_HANDLER_FAILED|something unexpected went wrong|\p{Script=Han}/iu, dialogText)
    assert.deepEqual(fs.readdirSync(target), [], '写入失败时目标目录没有导出文件')
    await page.waitForTimeout(300)
    await shoot('i897-export-write-fallback-en')
    return { shown: await failure.innerText() }
  } },
}
