// #702 定稿加速的实机场景：定稿计时、后处理还在跑时点写作的提示、开关思考的质量门禁。
// 环境变量：
//   FSPEED_CHAPTERS  只定稿这些章，写成 3-10 或 3,5,7；默认假模型 3-6、真实模型 3-23。
//   FSPEED_LOG       每章定稿完追加一行 JSON，场景中途失败也不丢已量到的数。
//   FSPEED_TEXT      换用另一份正文计时：模块路径，导出 CHAPTERS 或 PROBE_CHAPTERS（章号到正文）。夹具每章只有两三百字，
//                    比真实章节短得多；换了正文就不按预埋项初筛。
// 修前对照用 --app-root 指向修前构建，场景文件仍用这里的。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { QUALITY_CAST, QUALITY_CHAPTERS } from './finalize-quality-fixture.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { openChapter, runsStarted, trackOpenedSession, uiSession, untilRunEnds } from './real-scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

const BOOK = '潮汐与钟'
const TOTAL_CHAPTERS = 23
const textModule = process.env.FSPEED_TEXT ? await import(pathToFileURL(path.resolve(process.env.FSPEED_TEXT)).href) : null
const TEXT_OVERRIDE = textModule ? textModule.CHAPTERS ?? textModule.PROBE_CHAPTERS : null
const chapterText = number => TEXT_OVERRIDE ? TEXT_OVERRIDE[number] : QUALITY_CHAPTERS[number].text

function chapterList(fallback) {
  const spec = process.env.FSPEED_CHAPTERS?.trim()
  if (!spec) return fallback
  return spec.split(',').flatMap(part => {
    const [from, to] = part.split('-').map(Number)
    return Array.from({ length: (to ?? from) - from + 1 }, (_, index) => from + index)
  })
}

async function instrument(app) {
  await app.evaluate(({ ipcMain }) => {
    globalThis.__fspeedIpc = []
    for (const [channel, original] of ipcMain._invokeHandlers) {
      if (original.__fspeed) continue
      const wrapped = async (event, ...args) => {
        const t0 = Date.now()
        let ok = true
        try { return await original(event, ...args) } catch (error) { ok = false; throw error } finally {
          globalThis.__fspeedIpc.push({ channel, t0, t1: Date.now(), ok })
        }
      }
      wrapped.__fspeed = true
      ipcMain._invokeHandlers.set(channel, wrapped)
    }
    if (globalThis.fetch.__fspeed) return
    const inner = globalThis.fetch
    globalThis.__fspeedChats = []
    const traced = async (input, options) => {
      const url = String(input instanceof Request ? input.url : input)
      const t0 = Date.now()
      const response = await inner(input, options)
      if (!url.includes('/chat/completions')) return response
      let body = {}
      try { body = JSON.parse(String(options?.body ?? '{}')) } catch { body = {} }
      const messages = Array.isArray(body.messages) ? body.messages : []
      const entry = { t0, maxTokens: body.max_tokens, enableThinking: body.enable_thinking ?? null, reasoningEffort: body.reasoning_effort ?? null,
        system: String(messages[0]?.content ?? '').slice(0, 120) }
      globalThis.__fspeedChats.push(entry)
      response.clone().text().then(text => {
        let content = ''
        let reasoning = 0
        let usage = null
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue
          try {
            const chunk = JSON.parse(line.slice(5))
            const delta = chunk.choices?.[0]?.delta ?? {}
            reasoning += (delta.reasoning_content ?? '').length
            content += delta.content ?? ''
            if (chunk.usage) usage = chunk.usage
          } catch { /* 非 JSON 的 SSE 行不计 */ }
        }
        if (!text.startsWith('data:') && content === '') {
          try { content = JSON.parse(text).choices?.[0]?.message?.content ?? '' } catch { content = text.slice(0, 4000) }
        }
        Object.assign(entry, { totalMs: Date.now() - t0, content, reasoningChars: reasoning, usage })
      }).catch(error => { entry.readError = String(error) })
      return response
    }
    traced.__fspeed = true
    globalThis.fetch = traced
  })
}

async function seed(context, fakeMode, chapters) {
  const { app, page, roots, invoke, reload } = context
  await trackOpenedSession(app)
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: BOOK, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const projectPath = created.projectPath
  context.samplePath = projectPath
  const session = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
  if (fakeMode) {
    assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  } else await context.installRealModels()
  const entries = QUALITY_CAST.map(({ name, role, background }) => ({ characterId: `draft:${randomUUID()}`, name, role, gender: '', age: '',
    appearance: '', personality: '', background, abilities: '', motivation: '', relationships: [], arc: '', notes: '' }))
  const roster = await invoke(page, 'db:character-roster-read', projectPath, session)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries }, projectPath, session)).success, true)
  const core = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, totalChapters: TOTAL_CHAPTERS, wordsPerChapter: 1000 }, projectPath, session)
  assert.equal(core.success, true, core.error)
  const title = number => QUALITY_CHAPTERS[number]?.title ?? stageChapterTitle(number)
  // 蓝图不写本章事件，免得要点照抄蓝图，测不出模型读正文的能力。
  for (let chapterNumber = 1; chapterNumber <= TOTAL_CHAPTERS; chapterNumber++) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber, title: title(chapterNumber), role: '发展',
      purpose: '推进灯塔与沉船的线索', keyEvents: `林岚继续追查（${title(chapterNumber)}）`, characters: QUALITY_CAST.map(member => member.name) },
    projectPath, session)).success, true)
  }
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
    chapters: [1, 2].map(number => ({ chapterNumber: number, title: title(number), content: STAGE_SAMPLE.finalized[number],
      wordCount: countUnits(STAGE_SAMPLE.finalized[number]) })) }, projectPath, session)
  assert.equal(imported.success, true, imported.error)
  for (const number of chapters) {
    const content = chapterText(number)
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: number, version: 1, source: 'write', content, wordCount: countUnits(content) }, projectPath, session)
    assert.equal(draft.success, true, draft.error)
  }
  await reload()
  await stage.openFromLibrary(page, BOOK)
}

/** 每章定稿都留一张完成提示，叠多了驱动收尾时收不干净。 */
async function clearCompletionToasts(page) {
  const ignore = page.getByRole('button', { name: '打开查看', exact: true }).locator('xpath=following-sibling::button[1]')
  for (let round = 0; round < 10 && await ignore.count() > 0; round++) {
    await ignore.first().click().catch(() => {})
    await page.waitForTimeout(200)
  }
}

const hits = (text, groups) => groups.some(group => group.every(word => text.includes(word)))

async function finalizeOne(context, chapterNumber) {
  const { app, page } = context
  await openChapter(page, chapterNumber)
  await chapterView.prose(page).filter({ hasText: /\S/ }).first().waitFor({ state: 'visible', timeout: 30_000 })
  await instrument(app)
  await app.evaluate(() => { globalThis.__fspeedIpc = []; globalThis.__fspeedChats = [] })
  const before = await runsStarted(page)
  const t0 = Date.now()
  await chapterView.finalize(page, chapterNumber)
  const readOnlyMs = Date.now() - t0
  await untilRunEnds(page, before, `第 ${chapterNumber} 章定稿`)
  const runEndMs = Date.now() - t0
  await clearCompletionToasts(page)
  const ipc = (await app.evaluate(() => globalThis.__fspeedIpc)).map(e => ({ ch: e.channel, start: e.t0 - t0, ms: e.t1 - e.t0, ok: e.ok }))
  const marks = ipc.filter(e => e.ch === 'db:post-process-mark-step-ok' || e.ch === 'db:post-process-mark-step-failed')
  const fsCalls = ipc.filter(e => e.ch.startsWith('fs:'))
  const session = await uiSession(app)
  const run = await context.invoke(page, 'db:post-process-get-latest-run', 'chapter_finalize', String(chapterNumber), session.projectPath, session)
  const steps = run ? (await context.invoke(page, 'db:post-process-get-steps', run.id, session.projectPath, session))
    .map(s => ({ key: s.stepKey, ok: Boolean(s.ok), attempts: s.attemptCount, error: s.errorMsg || undefined })) : []
  // 对话回复体是异步读的，要等读完才有全文。
  let chats = []
  for (let waited = 0; waited < 30_000; waited += 500) {
    chats = await app.evaluate(() => globalThis.__fspeedChats ?? [])
    if (chats.every(chat => 'content' in chat || chat.readError)) break
    await page.waitForTimeout(500)
  }
  chats = chats.map(chat => ({ ...chat, t0: chat.t0 - t0 }))
  // 运行不等文件树刷新，它的 IPC 记账比运行结束晚，所以要轮询。
  let fileTree = null
  for (let waited = 0; waited < 8_000 && !fileTree; waited += 500) {
    fileTree = (await app.evaluate(() => globalThis.__fspeedIpc)).filter(e => e.channel === 'fs:list-dir').map(e => `@${e.t0 - t0}+${e.t1 - e.t0}`).at(-1) ?? null
    if (!fileTree) await page.waitForTimeout(500)
  }
  const isCharacter = chat => /角色|character/iu.test(chat.system) && /状态|state/iu.test(chat.system)
  const notesText = chats.filter(chat => !isCharacter(chat)).map(chat => chat.content ?? '').join('\n')
  const characterText = chats.filter(isCharacter).map(chat => chat.content ?? '').join('\n')
  const fixture = TEXT_OVERRIDE ? { events: [], states: [] } : QUALITY_CHAPTERS[chapterNumber]
  const record = {
    chapterNumber, units: countUnits(chapterText(chapterNumber)), readOnlyMs, runEndMs,
    // 可写下一章：知识库与要点两个关键步骤都记了结果（第二个标记）。
    writableMs: marks[1] ? marks[1].start + marks[1].ms : null,
    settledMs: marks.at(-1) ? marks.at(-1).start + marks.at(-1).ms : null,
    fsBeforeReadOnly: fsCalls.filter(e => e.start < readOnlyMs).map(e => `${e.ch}@${e.start}+${e.ms}`),
    fsBeforeRunEnd: fsCalls.filter(e => e.start < runEndMs).map(e => `${e.ch}@${e.start}+${e.ms}`),
    fileTree, steps,
    chats: chats.map(({ content, ...rest }) => ({ ...rest, contentChars: content?.length ?? 0 })),
    events: fixture.events.map(item => ({ id: item.id, hit: hits(notesText, item.any) })),
    states: fixture.states.map(item => ({ who: item.who, kind: item.kind, hit: hits(characterText, item.any), inNotes: hits(notesText, item.any) })),
    notesText, characterText,
  }
  if (process.env.FSPEED_LOG) fs.appendFileSync(process.env.FSPEED_LOG, `${JSON.stringify(record)}\n`)
  return record
}

async function finalizeAll(context, chapters) {
  const runs = []
  for (const number of chapters) runs.push(await finalizeOne(context, number))
  const median = values => { const sorted = values.filter(v => v !== null).sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)] ?? null }
  return {
    summary: { chapters, readOnlyMedianMs: median(runs.map(r => r.readOnlyMs)), writableMedianMs: median(runs.map(r => r.writableMs)),
      settledMedianMs: median(runs.map(r => r.settledMs)), eventsMissed: runs.flatMap(r => r.events.filter(e => !e.hit).map(e => e.id)),
      statesMissed: runs.flatMap(r => r.states.filter(s => !s.hit).map(s => `${r.chapterNumber}:${s.who}:${s.kind}`)),
      stepFailures: runs.flatMap(r => r.steps.filter(s => !s.ok).map(s => `${r.chapterNumber}:${s.key}`)),
      retries: runs.flatMap(r => r.steps.filter(s => s.attempts > 1).map(s => `${r.chapterNumber}:${s.key}x${s.attempts}`)) },
    runs,
  }
}

async function stillProcessing(context) {
  const { page, fake } = context
  await openChapter(page, 3)
  await chapterView.prose(page).filter({ hasText: /\S/ }).first().waitFor({ state: 'visible', timeout: 30_000 })
  fake.gate.hold()
  const before = await runsStarted(page)
  await chapterView.finalize(page, 3)
  await openChapter(page, 4)
  const runsBeforeWrite = await runsStarted(page)
  await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
  const notice = page.getByText('第 3 章已定稿，后台还在整理这一章，很快就好，请稍后再试。')
  await notice.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(400)
  await context.shoot('fspeed-still-processing-notice')
  const newRun = await page.evaluate(b => window.__realRunsStarted.count > b, runsBeforeWrite)
  assert.equal(newRun, false, '上一章后处理在跑时不起写作运行')
  fake.gate.release()
  await untilRunEnds(page, before, '第 3 章定稿')
  return { notice: await notice.innerText().catch(() => '（提示已关）'), newRun }
}

export const FSPEED_SCENARIOS = {
  'fspeed-finalize': { model: true, setup: context => seed(context, true, chapterList([3, 4, 5, 6])), run: context => finalizeAll(context, chapterList([3, 4, 5, 6])) },
  'fspeed-still-processing': { model: true, setup: context => seed(context, true, [3]), run: stillProcessing },
  'real-fspeed-finalize': { real: true, setup: context => seed(context, false, chapterList(Object.keys(QUALITY_CHAPTERS).map(Number))),
    run: context => finalizeAll(context, chapterList(Object.keys(QUALITY_CHAPTERS).map(Number))) },
}
