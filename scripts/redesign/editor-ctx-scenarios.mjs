import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import { BOOK, chapterText, seedLargeBook } from './perf702-scenarios.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const SELECTED = firstLine(STAGE_SAMPLE.drafts[4].text)
const NEXT = '你父亲也问过钟的事'
const NARROW = Object.freeze({ ...FAKE_MODEL, id: 'edctx-narrow-12k', name: '窄窗口模型',
  capabilities: { contextWindowTokens: 12_288, maxOutputTokens: FAKE_MODEL.maxTokens, reasoning: false, structuredOutput: true, usage: true },
  capabilitySources: { contextWindowTokens: 'manual', maxOutputTokens: 'manual', reasoning: 'preset', structuredOutput: 'preset', usage: 'preset' } })
const LONG_PERSONALITY = '寡言，记事只记潮位与钟声，从不写自己的心情；遇到想不通的事就去码头数船。'.repeat(400)

const setup = ({ narrow }) => context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
  assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 4, title: STAGE_SAMPLE.titles[3], role: '发展', purpose: '守塔人第一次提到父亲',
    keyEvents: '林岚在守塔人屋里听到父亲也问过钟', characters: ['林岚'] }, path, session)).success, true)
  if (!narrow) return
  const roster = await invoke(page, 'db:character-roster-read', path, session)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: roster.entries.map(entry => ({ ...entry, personality: LONG_PERSONALITY })) }, path, session)).success, true)
  assert.equal((await invoke(page, 'llm:save-model', NARROW)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', NARROW.id)).success, true)
} })

async function continueFirstLine(page) {
  await chapterView.open(page, 4)
  await chapterView.prose(page).getByText(SELECTED).first().click({ clickCount: 3 })
  const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
  await toolbar.getByRole('button', { name: '续写' }).click()
  await toolbar.getByText(firstLine(FIXTURE_PROSE)).waitFor({ state: 'visible', timeout: 30_000 })
  return toolbar
}
const editorPrompt = fake => fake.chats.at(-1).messages.map(message => message.content).join('\n')

export const EDITOR_CTX_SCENARIOS = {
  'edctx-continue-insert': { model: true, shell: 'stage', setup: setup({ narrow: false }), run: async ({ page, fake, shoot }) => {
    const toolbar = await continueFirstLine(page)
    const prompt = editorPrompt(fake)
    assert.ok(prompt.includes('【本章蓝图】') && prompt.includes('林岚在守塔人屋里听到父亲也问过钟'), '请求带上本章蓝图')
    assert.ok(prompt.includes('【出场人物（截至本章）】'), '请求带上出场人物')
    assert.equal(await toolbar.getByText(/没带上/u).count(), 0, '材料都放得下时不出提示')
    await shoot('edctx-continue-preview')
    await toolbar.getByRole('button', { name: '插入' }).click()
    const prose = chapterView.prose(page)
    await prose.getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible' })
    const text = await prose.innerText()
    assert.ok(text.indexOf(SELECTED) >= 0 && text.indexOf(SELECTED) < text.indexOf(firstLine(FIXTURE_PROSE)), '原文还在，续写在它后面')
    assert.ok(text.indexOf(firstLine(FIXTURE_PROSE)) < text.indexOf(NEXT), '下一段仍在续写之后')
    const lines = (await prose.locator('.cm-line').allTextContents()).map(line => line.trim())
    assert.ok(lines.includes(STAGE_SAMPLE.drafts[4].text.split('\n')[0].trim()) && lines.some(line => line.startsWith(firstLine(FIXTURE_PROSE).trim().slice(0, 12))), `续写另起一段，选中的段落完整保留：${JSON.stringify(lines)}`)
    await shoot('edctx-continue-inserted')
  } },

  'edctx-trimmed-hint': { model: true, shell: 'stage', setup: setup({ narrow: true }), run: async ({ page, fake, shoot }) => {
    const toolbar = await continueFirstLine(page)
    await toolbar.getByText('人物没带上：模型窗口不够').waitFor({ state: 'visible' })
    const prompt = editorPrompt(fake)
    assert.ok(!prompt.includes('【出场人物（截至本章）】') && prompt.includes('【本章蓝图】'), '裁掉人物，蓝图照带')
    await shoot('edctx-trimmed-hint')
  } },

  'edctx-perf-112': { model: true, shell: 'stage', setup: async context => {
    const { projectPath, session } = await seedLargeBook(context, 112)
    const content = chapterText(113)
    assert.equal((await context.invoke(context.page, 'db:draft-create', { chapterNumber: 113, version: 1, source: 'write', content,
      wordCount: content.length }, projectPath, session)).success, true)
    await stage.openFromLibrary(context.page, BOOK)
    await stage.openChapter(context.page, 113)
  }, run: async ({ app, page, fake }) => {
    await app.evaluate(({ ipcMain }) => {
      globalThis.__edctxLog = []
      for (const [channel, handler] of ipcMain._invokeHandlers) {
        ipcMain._invokeHandlers.set(channel, async (...args) => {
          const entry = { channel, start: Date.now() }
          globalThis.__edctxLog.push(entry)
          try { return await handler(...args) } finally { entry.end = Date.now() }
        })
      }
    })
    const paragraph = chapterText(113).split('\n\n')[1].slice(0, 24)
    const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
    const samples = []
    for (let run = 0; run <= Number(process.env.EDCTX_RUNS ?? 7); run++) {
      await chapterView.prose(page).getByText(paragraph).first().click({ clickCount: 3 })
      await app.evaluate(() => { globalThis.__edctxLog.length = 0 })
      const before = fake.chats.length
      const clicked = Date.now()
      await toolbar.getByRole('button', { name: '续写' }).click()
      while (fake.chats.length === before) await new Promise(resolve => setImmediate(resolve))
      const requested = Date.now()
      await toolbar.getByText(firstLine(FIXTURE_PROSE)).waitFor({ state: 'visible', timeout: 30_000 })
      const log = await app.evaluate(() => globalThis.__edctxLog)
      const begin = log.find(entry => entry.channel === 'editor-inline:begin')
      assert.ok(begin?.end, '主进程收到 begin')
      const reads = log.filter(entry => entry.start < begin.start).map(entry => entry.channel)
      if (run > 0) samples.push({ prepareMs: begin.start - clicked, bindMs: begin.end - begin.start, clickToRequestMs: requested - clicked, reads })
      await toolbar.getByRole('button', { name: '取消' }).click()
      await toolbar.waitFor({ state: 'hidden' })
    }
    const median = key => samples.map(sample => sample[key]).sort((a, b) => a - b)[samples.length >> 1]
    return { median: { prepareMs: median('prepareMs'), bindMs: median('bindMs'), clickToRequestMs: median('clickToRequestMs') }, samples }
  } },
}
