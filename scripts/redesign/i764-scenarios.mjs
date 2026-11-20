import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { seedArch } from './arch-scenarios.mjs'
import * as arch from './pages/architecture.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { REAL_REASONING_ENV } from './real-model.mjs'
import { runsStarted, seedBook, untilRunEnds } from './real-scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const TOTAL_CHAPTERS = 120
const PREMISE = '一座本该停用的灯塔仍在夜里报时，钟声每晚提前一刻。测绘师林岚带着父亲留下的残缺地图来到旧港，发现钟声的偏差与三十年前北堤外的一次沉船严丝合缝，而所有档案都在那一年断了线。'
  + '她必须在一百二十个潮期之内查清沉船名录上被涂掉的名字，否则港务局会在新港区开工前把旧堤连同那段历史一起填平。守塔人知道真相却选择沉默，档案员在暗中销毁证据，而林岚自己的父亲正是沉船那一夜的测绘员。'
const WORLD = '旧港是一座靠潮汐与灯塔维持秩序的小城，航标、潮位表与雾钟构成它的时间。港务局的档案按潮期装订，任何不在潮期里的事都会被当作没有发生过。'
  + '北堤外的暗礁只在大潮退尽时露出，礁石上刻着历年最高潮位；灯塔有两盏灯，第二盏在沉船那年被拆除。城里的老人相信钟声提前一刻是海在讨债，新港区的开发商则急着用填海抹掉旧堤。'
const CHARACTERS = [
  { name: '周守仁', role: 'supporting', gender: '男', age: '67', personality: '寡言、固执、护短', background: '灯塔唯一的看守，沉船那夜当值。',
    motivation: '守住一个三十年前的承诺，不让另一个人被追究。' },
  { name: '许棠', role: 'antagonist', gender: '女', age: '41', personality: '体面、精明、怕事', background: '港务局档案员，负责按潮期装订档案。',
    motivation: '奉命销毁沉船那一年的记录，保住新港区工程和自己的位置。' },
  { name: '陆鸣', role: 'supporting', gender: '男', age: '30', personality: '热心、莽撞', background: '渡船船长，沉船遇难者的儿子。',
    motivation: '想知道父亲为什么在那一夜出海。' },
]

async function authorView(page) {
  await runSheet.openFromPalette(page)
  const sheet = (await runSheet.sheet(page).innerText()).slice(0, 4000)
  await page.keyboard.press('Escape')
  await arch.waitReady(page)
  return { sheet, badge: await arch.badge(page, 'synopsis').innerText(), section: await arch.section(page, 'synopsis').innerText() }
}

function ledger(projectPath) {
  const database = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    const attempts = database.prepare(`SELECT a.attempt_json, a.usage_receipt_json, f.artifact_json FROM generation_attempts a
      LEFT JOIN generation_artifacts f ON f.attempt_id = a.attempt_id ORDER BY a.rowid`).all()
    return {
      synopsis: database.prepare('SELECT synopsis FROM project_core LIMIT 1').get()?.synopsis ?? null,
      attempts: attempts.map(row => ({ attempt: JSON.parse(row.attempt_json), receipt: row.usage_receipt_json ? JSON.parse(row.usage_receipt_json) : null,
        artifact: row.artifact_json ? JSON.parse(row.artifact_json) : null })),
    }
  } finally { database.close() }
}

async function generateOutline(page, trigger) {
  const before = await runsStarted(page)
  await trigger()
  await untilRunEnds(page, before, '生成情节大纲')
  return authorView(page)
}

const WHOLE_BOOK = '# 全书情节大纲\n\n## 第一阶段：建置（第1–24章）\n林岚抵达旧港。\n\n## 第二阶段：对抗（第25–90章）\n档案断线。'

export const I764_SCENARIOS = {
  'i764-outline-stopped': { model: true, shell: 'stage', setup: seedArch({ clear: ['synopsis'], totalChapters: 24 }), run: async context => {
    const { page, fake } = context
    fake.replyReview(prompt => prompt.includes('本次只写第 3 章') ? WHOLE_BOOK : null)
    await arch.open(page)
    await arch.primary(page).click()
    await arch.selectOnly(page, ['synopsis'])
    await arch.startGenerate(page)
    await runSheet.openFromPalette(page)
    await runSheet.lastRun(page).getByText('第 3 章两次都没写成完整的单章大纲', { exact: false }).waitFor({ timeout: 90_000 })
    const shown = await runSheet.sheet(page).innerText()
    assert.match(shown, /恢复稿里有已写好的章节和第 3 章最后一次的回复，正式大纲没动。第 3 章两次都没写成完整的单章大纲，自动生成停在这里。到「架构」页点「编辑恢复稿」补写这一章，或重新生成。/u)
    assert.match(shown, /缺第 3–5 章/u)
    assert.doesNotMatch(shown, /缺第 1–5 章/u)
    assert.doesNotMatch(shown, /attempts-exhausted/u)
    await context.shoot('i764-outline-stopped-sheet')
    await page.keyboard.press('Escape')
    await arch.waitReady(page)
    const edit = arch.section(page, 'synopsis').getByRole('button', { name: '编辑恢复稿' })
    await edit.waitFor({ timeout: 20_000 })
    await edit.click()
    const recovery = page.getByLabel('大纲恢复')
    await recovery.getByText(/待完成第 3 至 5 章/u).waitFor({ timeout: 20_000 })
    const draft = await page.locator('main').innerText()
    for (const heading of [/第1章/u, /第2章/u, /林岚抵达旧港/u]) assert.match(draft, heading)
    await context.shoot('i764-outline-stopped-draft')
  } },

  'real-764-outline': { real: true, setup: context => seedBook(context, { characters: CHARACTERS, core: { synopsis: '', premise: PREMISE, worldbuilding: WORLD,
    totalChapters: TOTAL_CHAPTERS, wordsPerChapter: 3000, plotStructure: process.env.I764_STRUCTURE?.trim() || 'three_act' } }), run: async context => {
    const { page } = context
    await arch.open(page)
    const started = Date.now()
    const batches = [await generateOutline(page, async () => {
      await arch.primary(page).click()
      await arch.selectOnly(page, ['synopsis'])
      await arch.startGenerate(page)
    })]
    if (process.env.I764_CONTINUE === '1' && batches[0].section.includes('续写第 6 章起')) {
      batches.push(await generateOutline(page, async () => {
        await arch.section(page, 'synopsis').getByRole('button', { name: '续写第 6 章起' }).click()
        await arch.setRange(page, 6, 10)
        await arch.startGenerate(page)
      }))
    }
    const result = { reasoningOverride: process.env[REAL_REASONING_ENV]?.trim() || 'auto', structure: process.env.I764_STRUCTURE?.trim() || 'three_act',
      continued: batches.length > 1, ms: Date.now() - started, author: batches.at(-1), batches, ...ledger(context.samplePath) }
    const out = process.env.I764_OUT || path.resolve('.runtime', 'real-764')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `${result.structure}-${result.reasoningOverride}${result.continued ? '-cont' : ''}-${new Date().toISOString().replace(/[:.]/gu, '')}.json`), JSON.stringify(result, null, 2))
  } },
}
