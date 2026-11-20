// #764：推理强度调到「高」后生成情节大纲。用真实模型跑架构页的情节大纲生成，记下每次尝试的原文、作者看到的结果。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as arch from './pages/architecture.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { REAL_REASONING_ENV } from './real-model.mjs'
import { runsStarted, seedBook, untilRunEnds } from './real-scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const TOTAL_CHAPTERS = 120

async function authorView(page) {
  await runSheet.openFromPalette(page)
  const sheet = (await runSheet.sheet(page).innerText()).slice(0, 4000)
  await page.keyboard.press('Escape')
  await arch.waitReady(page)
  return { sheet, badge: await arch.badge(page, 'synopsis').innerText(), summary: await arch.summary(page, 'synopsis').innerText() }
}

function ledger(projectPath) {
  const database = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    const attempts = database.prepare(`SELECT a.attempt_json, a.usage_receipt_json, f.artifact_json FROM generation_attempts a
      LEFT JOIN generation_artifacts f ON f.attempt_id = a.attempt_id ORDER BY a.rowid`).all()
    const reasoning = database.prepare('SELECT binding_json FROM generation_runs').all()
      .map(row => JSON.stringify(JSON.parse(row.binding_json), (key, value) => key === 'apiKey' ? undefined : value).match(/"[^"]*[Rr]easoning[^"]*":(?:\{[^}]*\}|"[^"]*"|null)/gu))
    return {
      synopsis: database.prepare('SELECT synopsis FROM project_core LIMIT 1').get()?.synopsis ?? null,
      reasoning,
      attempts: attempts.map(row => ({ attempt: JSON.parse(row.attempt_json), receipt: row.usage_receipt_json ? JSON.parse(row.usage_receipt_json) : null,
        artifact: row.artifact_json ? JSON.parse(row.artifact_json) : null })),
    }
  } finally { database.close() }
}

export const I764_SCENARIOS = {
  'real-764-outline': { real: true, setup: context => seedBook(context, { core: { synopsis: '', totalChapters: TOTAL_CHAPTERS, wordsPerChapter: 3000 } }), run: async context => {
    const { page } = context
    await arch.open(page)
    await arch.primary(page).click()
    await arch.selectOnly(page, ['synopsis'])
    const before = await runsStarted(page)
    const started = Date.now()
    await arch.startGenerate(page)
    await untilRunEnds(page, before, '生成情节大纲')
    const result = { reasoningOverride: process.env[REAL_REASONING_ENV]?.trim() || 'auto', ms: Date.now() - started,
      author: await authorView(page), ...ledger(context.samplePath) }
    const out = process.env.I764_OUT
    assert.ok(out, '设 I764_OUT 指向原始输出目录')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `${result.reasoningOverride}-${new Date().toISOString().replace(/[:.]/gu, '')}.json`), JSON.stringify(result, null, 2))
  } },
}
