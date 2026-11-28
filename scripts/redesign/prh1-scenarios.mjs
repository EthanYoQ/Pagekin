import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const toasts = page => page.locator('#ai-novel-ink-toasts')
const flow = page => page.getByRole('navigation', { name: 'Writing flow' })
const REVISED = [
  '守塔人的屋子在灯塔背风的一侧，窗玻璃上积着三十年的盐。他给林岚倒了一杯很淡的茶，自己却只是捧着杯子，盯着炉火出神。',
  '「你父亲也问过钟的事，」他顿了顿，「问得比你还急。」说完这句话，他就再也没有开口。',
  '炉火噼啪一声，林岚注意到墙上挂着一张褪色的航海图，图上的北堤被人用红笔圈了三次。',
].join('\n\n')
const RAW_PARSER = /Unexpected end of JSON|SyntaxError|JSON\.parse/u

async function switchToEnglish(context) {
  assert.equal((await context.invoke(context.page, 'config:set', { locale: 'en-US' })).success, true)
  await context.reload()
  await stage.openFromLibraryEn(context.page, STAGE_SAMPLE.name)
  await flow(context.page).waitFor({ state: 'visible' })
}

export const PRH1_SCENARIOS = {
  'prh1-merge-failure-en': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page, fake, shoot } = context
    fake.replyReview(prompt => prompt.includes('【已确认纳入本次修稿的审稿项】') ? REVISED : null)
    await chapterView.open(page, 4)
    const running = stage.root(page).locator('.stage-capsule:not([data-tone="ok"])')
    await chapterView.review(page)
    await running.waitFor({ state: 'detached', timeout: 90_000 })
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 90_000 })
    await running.waitFor({ state: 'detached', timeout: 90_000 })
    await chapterView.merge(page).getByRole('button', { name: '稍后再合并' }).click()

    await switchToEnglish(context)
    const shown = context.page
    await flow(shown).getByRole('button', { name: /^4\D/u }).first().click()
    const merge = shown.getByRole('region', { name: 'Revision merge' })
    const reopen = shown.getByRole('button', { name: 'Open revision merge' })
    await merge.or(reopen).first().waitFor({ state: 'visible', timeout: 30_000 })
    if (await reopen.isVisible()) await reopen.click()
    await merge.waitFor({ state: 'visible', timeout: 30_000 })
    assert.ok(await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      if (!handlers.get('db:revision-merge')) return false
      handlers.set('db:revision-merge', async () => ({ success: false, failure: { code: 'REVISION_NOT_PENDING' } }))
      return true
    }), '能替换主进程的合并修订')
    await merge.getByRole('button', { name: 'Finish merge' }).click()
    const toast = toasts(shown).getByText(/Could not merge the revision/u)
    await toast.waitFor({ state: 'visible', timeout: 30_000 })
    await shown.waitForTimeout(400)
    const observed = { toast: await toasts(shown).innerText(), lang: await shown.evaluate(() => document.documentElement.lang) }
    await shoot('prh1-merge-failure-en')
    assert.equal(observed.lang, 'en-US')
    assert.match(observed.toast, /Could not merge the revision\.\s+This revision was already handled/u, '英文界面的合并失败带上原因')
    assert.doesNotMatch(observed.toast, /\p{Script=Han}|REVISION_NOT_PENDING/u, '不夹中文、不露码')
    return observed
  } },

  // 夹具用缺字段而非坏 JSON：坏 JSON 在主进程先失败，到不了渲染端诊断。
  'prh1-prompt-unreadable-en': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const dir = join(context.samplePath, '.ai-novel', 'prompts')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'consistency_check.json'), JSON.stringify({ key: 'consistency_check' }))
    await switchToEnglish(context)
    const shown = context.page
    await flow(shown).getByRole('button', { name: /^4\D/u }).first().click()
    await shown.getByRole('button', { name: 'AI review', exact: true }).click()
    const reason = shown.getByText(/The prompt file "consistency_check\.json" cannot be read or is malformed/u).first()
    await reason.waitFor({ state: 'visible', timeout: 90_000 })
    await shown.waitForTimeout(400)
    const notice = await reason.innerText()
    const page = await shown.locator('body').innerText()
    await context.shoot('prh1-prompt-unreadable-en')
    assert.match(notice, /consistency_check\.json/u, '说明里指出是哪个文件')
    assert.doesNotMatch(page, RAW_PARSER, '界面任何地方都不露解析器原文')
    return { notice }
  } },

  // 坏 JSON 在主进程生成准入时先失败；抛出过 IPC 只带码，所以说明指到「提示词模板」，不带文件名（#935）。
  'prh1-prompt-bad-json-en': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const dir = join(context.samplePath, '.ai-novel', 'prompts')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'consistency_check.json'), '{"key": "consistency_check",')
    await switchToEnglish(context)
    const shown = context.page
    await flow(shown).getByRole('button', { name: /^4\D/u }).first().click()
    await shown.getByRole('button', { name: 'AI review', exact: true }).click()
    const reason = shown.getByText(/cannot be read or is malformed/u).first()
    await reason.waitFor({ state: 'visible', timeout: 90_000 })
    await shown.waitForTimeout(400)
    const notice = await reason.innerText()
    const page = await shown.locator('body').innerText()
    await context.shoot('prh1-prompt-bad-json-en')
    assert.match(notice, /Prompt templates/u, '说明指到「提示词模板」')
    assert.doesNotMatch(page, RAW_PARSER, '界面任何地方都不露解析器原文')
    assert.doesNotMatch(page, /GENERATION_PROMPT_INVALID|PROMPT_FILE_UNREADABLE/u, '不露码')
    return { notice }
  } },
}
