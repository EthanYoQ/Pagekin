import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

const settle = page => page.waitForTimeout(400)
const RAW = 'SqliteError: database is locked（夹具原文）'

/** 参照章节入库返回带已登记码的失败，旧 error 字段装异常原文：运行卡片只显示码的目录文案（#844 PR-B）。 */
export const ERRB_SCENARIOS = {
  'errb-reference-import-failure': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, shoot }) => {
    const file = path.join(roots.temp, 'reference-novel.txt')
    fs.writeFileSync(file, `第1章 旧港\n旧港的潮水刚退，青石上还留着一层薄薄的盐霜。\n\n第2章 北堤\n北堤上的风很大。\n`)
    assert.ok(await app.evaluate(({ dialog, ipcMain }, { selected, raw }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      const handlers = ipcMain._invokeHandlers
      if (!handlers.get('kb:import-reference-text')) return false
      handlers.set('kb:import-reference-text', async () => ({
        success: false, error: raw, errorCode: 'EMBEDDING_SPACE_BUSY', failure: { code: 'EMBEDDING_SPACE_BUSY' },
      }))
      return true
    }, { selected: file, raw: RAW }), '能替换主进程的参照章节入库')

    await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
    await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
    await dialog.getByTestId('import-target-current').click()
    await dialog.getByRole('button', { name: '选择', exact: true }).click()
    await dialog.getByRole('button', { name: '导入当前项目（2 章）', disabled: false }).click()
    await dialog.waitFor({ state: 'hidden' })

    await runSheet.waitUntilOpen(page)
    const failedStep = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-row').first()
    await failedStep.waitFor({ state: 'visible', timeout: 30_000 })
    if (await failedStep.getAttribute('aria-expanded') !== 'true') await failedStep.click()
    const stepNotice = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-error').first()
    await stepNotice.waitFor({ state: 'visible' })
    const observed = {
      stepNotice: await stepNotice.innerText(),
      sheet: await runSheet.sheet(page).innerText(),
      lang: await page.evaluate(() => document.documentElement.lang),
    }
    await settle(page)
    await shoot('errb-reference-import-failure')
    assert.equal(observed.lang, 'zh-CN')
    assert.match(observed.stepNotice, /检索索引正在建立，请稍后再试。/u)
    assert.doesNotMatch(observed.sheet, /database is locked|SqliteError|EMBEDDING_SPACE_BUSY/u, '运行侧页不出现旧 error 字段的原文与裸码')
    return observed
  } },
}
