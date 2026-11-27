import assert from 'node:assert/strict'

import { characterStateReply, finalizeChapter } from './f491-scenarios.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

const RAW = "Error: SqliteError: database is locked, open 'C:\\Users\\a\\novel.db'"
const toasts = page => page.locator('#ai-novel-ink-toasts')

export const ERRG_SCENARIOS = {
  'errg-trash-restore-raw-en': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page, invoke } = context
    context.fake.replyCharacterState(characterStateReply)
    await finalizeChapter(page, 3)
    await chapterView.more(page, '删除正文…')
    const confirm = page.getByRole('dialog', { name: '删除正文' })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: /^回收站（1）$/u }).waitFor({ state: 'visible', timeout: 30_000 })

    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await context.reload()
    await stage.openFromLibraryEn(context.page, STAGE_SAMPLE.name)
    assert.ok(await app.evaluate(({ ipcMain }, raw) => {
      const handlers = ipcMain._invokeHandlers
      if (!handlers.get('chapter:trash-restore')) return false
      handlers.set('chapter:trash-restore', async () => ({ success: false, error: raw }))
      return true
    }, RAW), '能替换主进程的回收站恢复')

    const shown = context.page
    await shown.getByRole('button', { name: /^Trash \(1\)$/u }).click()
    const trash = shown.getByRole('dialog', { name: /^Trash \(1\)$/u })
    await trash.getByRole('button', { name: 'Restore' }).click()
    const toast = toasts(shown).getByText(/Something unexpected went wrong/u)
    await toast.waitFor({ state: 'visible', timeout: 30_000 })
    const observed = { toast: await toasts(shown).innerText(), lang: await shown.evaluate(() => document.documentElement.lang) }
    await shown.waitForTimeout(400)
    await context.shoot('errg-trash-restore-raw-en')
    assert.equal(observed.lang, 'en-US')
    assert.doesNotMatch(observed.toast, /database is locked|SqliteError|C:\\Users/u, '英文界面的回收站提示不露异常原文')
    assert.match(observed.toast, /was not restored\s+Something unexpected went wrong\.\s+Try again\./u)
    return observed
  } },
}
