import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import * as chapter from './pages/chapter.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as project from './pages/project.mjs'
import * as runPanel from './pages/run-panel.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { contrastFailures, firstLine, seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'
import { trackOpenedSession, uiSession } from './reopen-scenarios.mjs'
import { holdChannel, untilHeld } from './x1-scenarios.mjs'
import { describeFinalizationStepError } from '../../src/shared/finalization-step-error.ts'

const isStage = async page => await stage.root(page).count() > 0

const CONTRAST = {
  page: [['.stage-ch-title', 4.5], ['.stage-ch .stage-ch-prose .cm-content', 4.5], ['.stage-ch-eyebrow', 3], ['.stage-ch-hint', 3], ['.stage-ch-version', 3]],
  sheet: [['.stage-ch-issue-text', 4.5], ['.stage-ch-sheet-summary', 4.5], ['.stage-ch-issue-tag', 3], ['.stage-ch-issue-quote', 3], ['.stage-ch-issue-meta', 3], ['.stage-ch-sheet-count', 3]],
  merge: [['.stage-ch-hunk-col', 4.5], ['.stage-ch-hunk-col:not([data-chosen="true"])', 4.5], ['.stage-ch-same', 3], ['.stage-ch-merge-legend', 3], ['.stage-ch-merge-note', 3]],
  post: [['.stage-ch-post-step b', 4.5], ['.stage-ch-post-detail', 3], ['.stage-ch-post-title small', 3]],
  focus: [['.stage-ch .stage-ch-prose .cm-content', 4.5], ['.stage-ch-title', 4.5], ['.stage-ch-focusbar > span:not([role])', 3]],
}
const assertContrast = async (page, checks, what) => assert.deepEqual(await contrastFailures(page, checks), [], `${what}文字对比度不足`)

async function sheetLayout(page) {
  return page.evaluate(() => {
    const paper = document.querySelector('.stage-ch-page')?.getBoundingClientRect()
    const sheets = [...document.querySelectorAll('.pi-sheet')].filter(node => node.getClientRects().length > 0)
    return {
      sheets: sheets.map(node => node.querySelector('.pi-sheet-title')?.textContent),
      overlap: sheets.some(node => paper && node.getBoundingClientRect().left < paper.right - 1),
    }
  })
}

const afterProjectOpenSettles = page => page.waitForTimeout(2000)

const seed = ({ deleteChapters = [], extra } = {}) => context => seedStageSample(context, {
  landOnChapter3: deleteChapters.length === 0,
  beforeReload: async args => {
    const { page, invoke, path, session } = args
    context.projectPath = path
    for (const chapterNumber of deleteChapters) {
      for (const draft of await invoke(page, 'db:draft-list', chapterNumber, path, session)) {
        assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
      }
    }
    await extra?.(args)
  },
})

async function createDraft({ page, invoke, path, session }, chapterNumber, version, text) {
  const created = await invoke(page, 'db:draft-create', { chapterNumber, version, source: version > 1 ? 'rewrite' : 'write', content: text, wordCount: countUnits(text) }, path, session)
  assert.equal(created.success, true, created.error)
}

async function reopenForReading({ page, invoke, reload, projectPath }) {
  await reload()
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  return { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
}

async function finalizedFacts(context, chapterNumber) {
  const { page, invoke, projectPath } = context
  const session = await reopenForReading(context)
  const drafts = await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)
  const finalized = drafts.find(draft => draft.status === 'finalized')
  assert.ok(finalized, `第 ${chapterNumber} 章已定稿`)
  const full = await invoke(page, 'db:draft-get-full', finalized.id, projectPath, session)
  const run = await invoke(page, 'db:post-process-get-latest-run', 'chapter_finalize', String(chapterNumber), projectPath, session)
  const steps = run ? await invoke(page, 'db:post-process-get-steps', run.id, projectPath, session) : []
  return {
    contentSha256: createHash('sha256').update(full.content).digest('hex'),
    content: full.content,
    steps: steps.map(step => ({ key: step.stepKey, ok: Boolean(step.ok) })).sort((a, b) => a.key.localeCompare(b.key)),
  }
}

async function runsStarted(page) {
  return page.evaluate(() => {
    if (!window.__rdRunsStarted) {
      window.__rdRunsStarted = { count: 0 }
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof Element && node.matches('.stage-capsule:not([data-tone="ok"])')) window.__rdRunsStarted.count++
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    }
    return window.__rdRunsStarted.count
  })
}

async function waitRunDone(page, startedBefore) {
  if (!await isStage(page)) return runPanel.waitForWorkflowDone(page)
  if (await runSheet.sheet(page).isVisible()) return runSheet.waitForRunDone(page)
  const running = '.stage-capsule:not([data-tone="ok"])'
  if (startedBefore === undefined) return stage.root(page).locator(running).waitFor({ state: 'detached', timeout: 90_000 })
  await page.waitForFunction(({ before, selector }) => window.__rdRunsStarted.count > before && !document.querySelector(selector), { before: startedBefore, selector: running }, { timeout: 90_000 })
}

async function writeChapter3(page) {
  if (await isStage(page)) {
    await chapterView.open(page, 3)
    const started = await runsStarted(page)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await runSheet.waitUntilOpen(page)
    await waitRunDone(page, started)
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 30_000 })
    return
  }
  await project.openNode(page, '章节蓝图')
  await page.getByRole('button', { name: /^写作第3章$/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
  await waitRunDone(page)
  await chapter.editor(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 30_000 })
}

async function reviewAndRevise(page) {
  const reviewing = await runsStarted(page)
  await chapterView.review(page)
  await waitRunDone(page, reviewing)
  const revising = await runsStarted(page)
  await chapterView.reviseButton(page).click()
  await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
  await waitRunDone(page, revising)
}

async function reviewReviseMergeFinalize(page) {
  if (await isStage(page)) {
    await reviewAndRevise(page)
    await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitRunDone(page)
    const finalizing = await runsStarted(page)
    await chapterView.finalize(page, 3)
    await chapterView.postProcess(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page, finalizing)
    return
  }
  await chapter.review(page)
  await chapter.reviseFromReview(page, FAKE_MODEL.id)
  await chapter.mergeDialog(page).waitFor({ state: 'visible', timeout: 60_000 })
  await chapter.completeMerge(page)
  await waitRunDone(page)
  await project.draftOfChapter(page, 3).click()
  await chapter.finalize(page, 3)
  await waitRunDone(page)
}

async function openTiming(page, target, text) {
  const handle = await target.elementHandle()
  await page.evaluate(({ element, text }) => {
    let clickedAt = null
    let domMs = null
    element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
    const ready = () => {
      const content = [...document.querySelectorAll('.cm-content')].find(node => node.textContent.includes(text) && node.getClientRects().length > 0)
      if (!content) return false
      for (let node = content; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) return true
      }
      return false
    }
    const observer = new MutationObserver(() => {
      if (clickedAt !== null && domMs === null && ready()) domMs = performance.now() - clickedAt
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    window.__driveOpen = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('20 秒内正文没有出现')), 20_000)
      const tick = () => {
        if (clickedAt !== null && ready()) {
          clearTimeout(deadline)
          observer.disconnect()
          const frameMs = performance.now() - clickedAt
          resolve({ frameMs, domMs: domMs ?? frameMs })
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { element: handle, text })
  await target.click()
  return page.evaluate(() => window.__driveOpen)
}

const COMMIT_REVIEW = 'review-revision:commit-review'

async function rereviewChapter3({ app, page, fake }, { unsaved = false } = {}) {
  await chapterView.open(page, 3)
  const reviewsBefore = fake.chats.filter(chat => chat.kind === 'review').length
  const reviewRequests = () => fake.chats.filter(chat => chat.kind === 'review').length - reviewsBefore
  if (unsaved) {
    await holdChannel(app, COMMIT_REVIEW)
    await chapterView.view(page).getByRole('button', { name: '重新审稿', exact: true }).click()
    await untilHeld(app, COMMIT_REVIEW, 60_000)
    return { reviewRequests: reviewRequests() }
  }
  const started = await runsStarted(page)
  await chapterView.view(page).getByRole('button', { name: '重新审稿', exact: true }).click()
  await waitRunDone(page, started)
  const reportShown = await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' })
    .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false)
  await runSheet.openFromPalette(page)
  return {
    reviewRequests: reviewRequests(),
    reportShown,
    rawIpcError: await runSheet.sheet(page).getByText(/Error invoking remote method|GENERATION_/).count(),
  }
}

async function reopenRunSheet({ page, reload }) {
  await reload()
  await stage.openFromLibrary(page, STAGE_SAMPLE.name)
  await runSheet.openFromPalette(page)
}

async function reopenRunSheetEn({ page, invoke, reload }) {
  assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
  await reload()
  await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
  await page.getByRole('navigation', { name: 'Writing flow' }).waitFor({ state: 'visible' })
  await page.keyboard.press('ControlOrMeta+K')
  await page.getByRole('dialog', { name: 'Search and jump' }).getByRole('combobox').fill('Run sheet')
  await page.keyboard.press('Enter')
  await runSheet.waitUntilOpen(page)
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

async function typingLatency(page, content, keys) {
  await content.evaluate(element => {
    window.__driveTyping = []
    let pending = null
    element.addEventListener('beforeinput', () => { pending = { start: performance.now() } }, { capture: true })
    new MutationObserver(() => {
      if (!pending || pending.dom !== undefined) return
      const current = pending
      current.dom = performance.now() - current.start
      requestAnimationFrame(() => {
        window.__driveTyping.push({ domMs: current.dom, frameMs: performance.now() - current.start })
      })
    }).observe(element, { childList: true, subtree: true, characterData: true })
  })
  for (const key of keys) {
    await page.keyboard.type(key)
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(300)
  const samples = await page.evaluate(() => window.__driveTyping)
  assert.ok(samples.length >= keys.length * 0.9, `只记到 ${samples.length} 次按键`)
  const round = value => Math.round(value * 10) / 10
  return {
    keys: samples.length,
    domP95Ms: round(percentile(samples.map(sample => sample.domMs), 0.95)),
    frameP95Ms: round(percentile(samples.map(sample => sample.frameMs), 0.95)),
    domMedianMs: round(percentile(samples.map(sample => sample.domMs), 0.5)),
    frameMedianMs: round(percentile(samples.map(sample => sample.frameMs), 0.5)),
  }
}

function charsPerLine(page) {
  return chapterView.prose(page).evaluate(content => {
    const line = [...content.querySelectorAll('.cm-line')].find(node => (node.textContent ?? '').length > 60)
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let top = null
    let count = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let index = 0; index < node.textContent.length; index++) {
        range.setStart(node, index)
        range.setEnd(node, index + 1)
        const rect = range.getBoundingClientRect()
        if (top === null) top = rect.top
        if (rect.top > top + 4) return count
        count++
      }
    }
    return count
  })
}

const LONG_CHAPTER = 5
const longParagraphHead = index => `第${index + 1}段。`
const LONG_TEXT = Array.from({ length: 50 }, (_, index) => {
  const head = longParagraphHead(index)
  return head + '雾是从海面上一层一层爬上来的林岚把潮汐表压在值班室的窗台上用铅笔圈出昨夜的那一格钟声比往常早了一刻潮水却没有任何变化'.repeat(4).slice(0, 200 - head.length)
}).join('\n\n')
const LONG_TEXT_HEAD = longParagraphHead(0)

async function openLongChapter(page) {
  const target = await isStage(page) ? stage.chapterButton(page, LONG_CHAPTER) : project.draftOfChapter(page, LONG_CHAPTER)
  const longProse = (await proseOf(page)).getByText(LONG_TEXT_HEAD, { exact: false })
  assert.equal(await longProse.count(), 0, '点击前第 5 章没有打开，计时从点击算起')
  await target.scrollIntoViewIfNeeded()
  await target.hover()
  await page.waitForTimeout(300)
  return openTiming(page, target, LONG_TEXT_HEAD)
}

const proseOf = async page => await isStage(page) ? chapterView.prose(page) : chapter.editor(page)

const chosenTexts = page => chapterView.merge(page).locator('[data-chosen="true"]').allInnerTexts()

async function sheetsAt(page, width) {
  await page.setViewportSize({ width, height: 900 })
  await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
  await afterProjectOpenSettles(page)
  await runSheet.openFromPalette(page)
  await page.waitForTimeout(500)
  const run = { ...await sheetLayout(page), chars: await charsPerLine(page) }
  await chapterView.more(page, '审稿报告')
  await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  const review = { ...await sheetLayout(page), chars: await charsPerLine(page) }
  const horizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  assert.deepEqual([run.sheets, run.overlap, review.sheets, review.overlap, horizontal], [['运行'], false, ['审稿报告'], false, false], '同一时间只开一个侧页，纸面不被盖住')
  assert.ok(run.chars >= 24 && review.chars >= 24, `侧页打开时正文一行 ${run.chars} / ${review.chars} 字`)
  return { width, charsWithRunSheet: run.chars, charsWithReviewSheet: review.chars }
}

export const CHAPTER_SCENARIOS = {
  'chapter-regression': { model: true, setup: seed({ deleteChapters: [3, 4] }), run: async context => {
    await writeChapter3(context.page)
    await reviewReviseMergeFinalize(context.page)
    const shell = await isStage(context.page) ? 'stage' : 'writer'
    const facts = await finalizedFacts(context, 3)
    if (shell === 'stage') {
      await stage.openFromLibrary(context.page, STAGE_SAMPLE.name)
      await chapterView.open(context.page, 3)
      await chapterView.postProcess(context.page).waitFor({ state: 'visible', timeout: 30_000 })
    }
    return { shell, ...facts }
  } },

  'chapter-draft': { model: false, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    await chapterView.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).waitFor({ state: 'visible' })
    assert.equal(await chapterView.primary(page).innerText(), 'AI 审稿')
    assert.equal(await chapterView.lifecycleCurrent(page).innerText(), '审稿')
    assert.match(await chapterView.versionButton(page).innerText(), /^草稿 v1 · \d+ 字/)
    await assertContrast(page, CONTRAST.page, '单章视图')
  } },

  'chapter-review': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    const started = await runsStarted(page)
    await chapterView.review(page)
    await waitRunDone(page, started)
    const sheet = chapterView.reviewSheet(page)
    const counts = async () => ({ button: await chapterView.reviseButton(page).innerText(), footer: await sheet.locator('.stage-ch-sheet-count').innerText() })
    const total = await sheet.getByRole('checkbox').count()
    const before = await counts()
    await sheet.getByRole('checkbox').first().uncheck({ force: true })
    const unchecked = await counts()
    await sheet.getByRole('checkbox').first().check({ force: true })
    const rechecked = await counts()
    assert.deepEqual({ before, unchecked, rechecked }, {
      before: { button: '按 1 项意见修稿', footer: `1 / ${total}` },
      unchecked: { button: '按 0 项意见修稿', footer: `0 / ${total}` },
      rechecked: { button: '按 1 项意见修稿', footer: `1 / ${total}` },
    }, '勾选数与主按钮、侧页计数同步')
    assert.equal(await chapterView.reviseButton(page).isEnabled(), true)
    assert.deepEqual(await sheetLayout(page), { sheets: ['审稿报告'], overlap: false }, '审稿完成后只开审稿侧页，不盖住纸面')
    await assertContrast(page, CONTRAST.sheet, '审稿侧页')
  } },

  'chapter-write-after-edited-chain': { model: true, shell: 'stage', setup: seed({ extra: async ({ page, invoke, path, session }) => {
    const [third] = await invoke(page, 'db:draft-list', 3, path, session)
    assert.ok(third, '示例作品有第 3 章稿')
    const original = (await invoke(page, 'db:draft-get-full', third.id, path, session))?.content
    assert.equal(typeof original, 'string', '读到第 3 章正文')
    const fourth = STAGE_SAMPLE.drafts[4].text
    const created = await invoke(page, 'db:draft-create', { chapterNumber: 4, version: 2, source: 'rewrite', content: fourth, wordCount: countUnits(fourth),
      sourceDependencies: [{ kind: 'candidate', draftId: third.id, contentHash: createHash('sha256').update(original, 'utf8').digest('hex') }] }, path, session)
    assert.equal(created.success, true, created.error)
    const edited = `${original}\n\n作者审稿时补的一句：雾钟停了。`
    assert.equal((await invoke(page, 'db:draft-update-content', third.id, edited, countUnits(edited), path, session)).success, true)
  } }), run: async context => {
    const { page, fake, invoke, projectPath } = context
    for (const chapterNumber of [3, 4]) {
      await chapterView.open(page, chapterNumber)
      await chapterView.more(page, '定稿…')
      const finalizing = await runsStarted(page)
      await chapterView.finalizeDialog(page, chapterNumber).getByRole('button', { name: '确认定稿', exact: true }).click()
      await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
      await waitRunDone(page, finalizing)
      await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    }
    await chapterView.open(page, 5)
    const proseBefore = fake.chats.filter(chat => chat.kind === 'prose').length
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 90_000 })
    await runSheet.openFromPalette(page)
    const proseRequests = fake.chats.filter(chat => chat.kind === 'prose').length - proseBefore
    const rawIpcError = await runSheet.sheet(page).getByText(/Error invoking remote method|GENERATION_/).count()
    const session = await reopenForReading(context)
    const saved = await invoke(page, 'db:draft-list', 5, projectPath, session)
    const contents = await Promise.all(saved.map(async draft => (await invoke(page, 'db:draft-get-full', draft.id, projectPath, session))?.content ?? ''))
    const after = { proseRequests, rawIpcError, savedDrafts: saved.length, savedHasFixtureProse: contents.some(content => content.includes(FIXTURE_PROSE)) }
    assert.deepEqual(after, { proseRequests: 1, rawIpcError: 0, savedDrafts: 1, savedHasFixtureProse: true }, '第 5 章写完并存进库，运行侧页没有原始错误')
    await stage.openFromLibrary(page, STAGE_SAMPLE.name)
    await chapterView.open(page, 5)
    return after
  } },

  'chapter-rereview-legacy': { model: true, shell: 'stage', setup: seed(), run: async context => {
    const saved = await rereviewChapter3(context)
    assert.deepEqual(saved, { reviewRequests: 1, reportShown: true, rawIpcError: 0 },
      '重新审稿请求了模型并写回审稿报告，运行侧页没有原始 IPC 错误')
    const unsaved = await rereviewChapter3(context, { unsaved: true })
    await reopenRunSheet(context)
    const card = runSheet.recovery(context.page).getByRole('article').filter({ hasText: '第3章审稿候选' })
    await card.waitFor({ state: 'visible' })
    const recovery = { reviewRequests: unsaved.reviewRequests, rawJson: await card.getByText('"summary"').count(), digestShown: await card.getByText(/1 条意见/).count() }
    assert.deepEqual(recovery, { reviewRequests: 1, rawJson: 0, digestShown: 1 }, '没保存的审稿候选在恢复卡里显示审稿结论而不是原始 JSON')
    return { saved, recovery }
  } },

  'chapter-rereview-legacy-en': { model: true, shell: 'stage', setup: seed(), run: async context => {
    const { page } = context
    await rereviewChapter3(context, { unsaved: true })
    await reopenRunSheetEn(context)
    const card = runSheet.recovery(page).getByRole('article').filter({ hasText: 'Chapter 3 review candidate' })
    await card.waitFor({ state: 'visible' })
    const after = { rawJson: await card.getByText('"summary"').count(), digestShown: await card.getByText(/\(1 note\)/).count() }
    assert.deepEqual(after, { rawJson: 0, digestShown: 1 }, '英文运行侧页的恢复卡显示英文审稿摘要而不是原始 JSON')
    return after
  } },

  'chapter-recheck-digest': { model: true, shell: 'stage', setup: seed(), run: async context => {
    const { app, page, fake, shoot } = context
    const summary = '复验：铺垫已压缩，仍需作者核对。'
    const firstReview = JSON.stringify({ summary: '本章目标还没落地。', items: [
      { category: '连续性', severity: 'warning', description: '核对钟声提前一刻与潮位的关系。', quote: '他给林岚倒了一杯很淡的茶' },
    ], goalReviews: [{ id: 'ch4:keyEvents:1', status: 'unmet', description: '林岚还没有在灯塔里找到新的线索。',
      evidence: [{ quote: '守塔人的屋子在灯塔背风的一侧' }] }] })
    fake.replyReview(prompt => {
      const anchors = prompt.split('【需复核的原始证据锚点】')[1]
      if (!anchors) return prompt.includes('goalReviews') && !prompt.includes('【已确认纳入本次修稿的审稿项】') ? firstReview : null
      const findings = JSON.parse(anchors.slice(anchors.indexOf('['), anchors.indexOf(']\n\n') + 1))
      return JSON.stringify({ summary, items: findings.map(({ findingId, targetId }) => ({
        findingId, targetId, resolved: true, evidenceQuote: '又核对了一遍潮位表', reason: '第二段铺垫已压缩到两句。',
      })) })
    })
    await chapterView.open(page, 4)
    await reviewAndRevise(page)
    await holdChannel(app, COMMIT_REVIEW)
    await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const deadline = Date.now() + 60_000
    while (!fake.chats.some(chat => JSON.stringify(chat.messages).includes('需复核的原始证据锚点'))) {
      assert.ok(Date.now() < deadline, `60 秒内没有发出合并后的复验（对话请求 ${fake.chats.map(chat => chat.kind).join('、')}）`)
      await page.waitForTimeout(250)
    }
    await untilHeld(app, COMMIT_REVIEW, 60_000)
    await reopenRunSheet(context)
    const card = runSheet.recovery(page).getByRole('article').filter({ hasText: '复核未能确认全部意见已解决' })
    await card.waitFor({ state: 'visible' })
    const zh = { rawJson: await card.getByText('"summary"').count(), modelSummary: await card.getByText(summary).count(), count: await card.getByText(/（1 条意见）/).count(),
      pending: await card.getByText(/待核实/).count() }
    assert.deepEqual(zh, { rawJson: 0, modelSummary: 0, count: 1, pending: 1 }, '中文恢复卡显示复验摘要，模型判为已解决的写待核实')
    await card.scrollIntoViewIfNeeded()
    await shoot('chapter-recheck-digest-zh')

    await reopenRunSheetEn(context)
    const cardEn = runSheet.recovery(page).getByRole('article').filter({ hasText: 'The recheck could not confirm that every note is resolved' })
    await cardEn.waitFor({ state: 'visible' })
    await cardEn.scrollIntoViewIfNeeded()
    const en = { rawJson: await cardEn.getByText('"summary"').count(), item: await cardEn.getByText(/\(1 item\)/).count(),
      pending: await cardEn.getByText(/Needs verification/).count() }
    assert.deepEqual(en, { rawJson: 0, item: 1, pending: 1 }, '英文恢复卡显示英文复验摘要')
    return { zh, en }
  } },

  'run-usage-en': { model: true, shell: 'stage', setup: seed(), run: async context => {
    const { page } = context
    await rereviewChapter3(context, { unsaved: true })
    await reopenRunSheetEn(context)
    const card = runSheet.recovery(page).getByRole('article').filter({ hasText: 'Chapter 3 review candidate' })
    await card.waitFor({ state: 'visible' })
    await card.scrollIntoViewIfNeeded()
    const after = { single: await card.getByText('1 request used', { exact: true }).count(), plural: await card.getByText(/1 requests/).count() }
    assert.deepEqual(after, { single: 1, plural: 0 }, '英文运行侧页的请求次数按单数写')
    return after
  } },

  'chapter-manual': { model: true, shell: 'stage', setup: seed(), run: async ({ page, fake }) => {
    await chapterView.open(page, 4)
    const reviewing = await runsStarted(page)
    await chapterView.review(page)
    await waitRunDone(page, reviewing)
    const note = '守塔人的咳嗽要提前到第一段出现。'
    await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' }).click()
    await chapterView.reviewSheet(page).getByRole('textbox', { name: '审稿问题' }).fill(note)
    assert.equal(await chapterView.reviseButton(page).innerText(), '按 2 项意见修稿')
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    const revision = fake.chats.find(chat => chat.kind === 'revision')
    assert.ok(revision, '假模型收到了修稿请求')
    assert.ok(JSON.stringify(revision.messages).includes(note), '人工意见进入了修稿输入')
  } },

  'chapter-merge': { model: true, shell: 'stage', setup: seed(), run: async context => {
    const { page } = context
    await chapterView.open(page, 4)
    await reviewAndRevise(page)
    const groups = chapterView.merge(page).getByRole('group', { name: /用哪一版$/ })
    const hunks = await groups.count()
    assert.ok(hunks >= 1, '修稿至少有一处改动')
    await groups.first().getByRole('button', { name: '用修稿' }).click()
    const manual = '（作者手改的一段。）'
    if (hunks > 1) {
      await groups.nth(1).getByRole('button', { name: '手动编辑' }).click()
      await chapterView.merge(page).getByRole('textbox').first().fill(manual)
    }
    context.chosen = await chosenTexts(page)
    context.manual = hunks > 1 ? manual : null
    await assertContrast(page, CONTRAST.merge, '合并视图')
    return { hunks, chosen: context.chosen }
  }, after: async ({ page, chosen, manual }) => {
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const merged = (await chapterView.prose(page).innerText()).replace(/\s+/g, '')
    for (const text of chosen) assert.ok(merged.includes(text.replace(/\s+/g, '')), `合并结果含选中的「${text.slice(0, 12)}」`)
    if (manual) assert.ok(merged.includes(manual), '合并结果含手动编辑的文字')
  } },

  'chapter-finalize': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 3)
    await chapterView.more(page, '定稿…')
    await chapterView.finalizeDialog(page, 3).waitFor({ state: 'visible' })
    const finalizing = await runsStarted(page)
    await chapterView.finalizeDialog(page, 3).getByRole('button', { name: '确认定稿', exact: true }).click()
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page, finalizing)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(await chapterView.prose(page).getAttribute('contenteditable'), 'false', '定稿后正文只读')
    await assertContrast(page, CONTRAST.post, '定稿后处理')
    return { steps: await chapterView.postProcessSteps(page) }
  } },

  'chapter-retry': { model: true, shell: 'stage', setup: seed(), run: async ({ page, fake }) => {
    fake.breakCharacterState()
    await chapterView.open(page, 3)
    const finalizing = await runsStarted(page)
    await chapterView.finalize(page, 3)
    await waitRunDone(page, finalizing)
    const failed = chapterView.postProcess(page).locator('li[data-state="failed"]')
    await failed.first().waitFor({ state: 'visible', timeout: 60_000 })
    const before = await chapterView.postProcessSteps(page)
    fake.breakCharacterState(false)
    const from = fake.requests.length
    const retrying = await runsStarted(page)
    await chapterView.postProcess(page).getByRole('button', { name: '重试失败步骤' }).click()
    await waitRunDone(page, retrying)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    const retried = fake.requests.slice(from)
    assert.deepEqual([...new Set(retried)], ['character-state'], '只重试了失败的角色状态更新')
    return { before, after: await chapterView.postProcessSteps(page), retried }
  } },

  'chapter-retry-stream': { model: true, shell: 'stage', setup: async context => { await trackOpenedSession(context.app); await seed()(context) }, run: async context => {
    const { fake } = context
    const characterRequests = () => fake.requests.filter(kind => kind === 'character-state').length
    const detail = () => chapterView.postProcess(context.page).locator('li[data-state="failed"] .stage-ch-post-detail').first()
    const characterStep = async () => {
      const session = await uiSession(context.app)
      const run = await context.invoke(context.page, 'db:post-process-get-latest-run', 'chapter_finalize', '3', session.projectPath, session)
      return (await context.invoke(context.page, 'db:post-process-get-steps', run.id, session.projectPath, session)).find(step => step.stepKey === 'character_cards')
    }
    fake.dropCharacterState(2)
    await chapterView.open(context.page, 3)
    const finalizing = await runsStarted(context.page)
    await chapterView.finalize(context.page, 3)
    await waitRunDone(context.page, finalizing)
    await detail().waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(characterRequests(), 1, '自动后处理只发了一次角色状态请求')
    const firstError = await detail().innerText()
    assert.equal((await characterStep()).attemptCount, 1, '自动后处理只记了一次尝试')
    await context.restart()
    await trackOpenedSession(context.app)
    await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
    await afterProjectOpenSettles(context.page)
    await chapterView.open(context.page, 3)
    await detail().waitFor({ state: 'visible', timeout: 60_000 })
    await chapterView.postProcess(context.page).getByRole('button', { name: '重试失败步骤' }).click()
    await runSheet.lastRun(context.page).filter({ hasText: '修复后处理' }).filter({ hasText: '失败' }).waitFor({ state: 'visible', timeout: 90_000 })
    assert.equal(characterRequests(), 2, '重开后点重试恰好发出一次新请求')
    const retried = await characterStep()
    assert.equal(retried.attemptCount, 2, '步骤记录已是重试这一次')
    await chapterView.open(context.page, 4)
    await chapterView.open(context.page, 3)
    const expectedError = describeFinalizationStepError(retried.errorMsg, zh => zh)
    await detail().filter({ hasText: expectedError }).waitFor({ state: 'visible', timeout: 60_000 })
    const secondError = await detail().innerText()
    assert.match(secondError, /连接中断/, '仍断流时说明讲明原因')
    for (const error of [firstError, secondError]) assert.doesNotMatch(error, /[A-Z]+_[A-Z_]+/, '失败说明不应是原始错误码')
    await context.shoot('chapter-retry-stream-failed')
    const fixing = await runsStarted(context.page)
    await chapterView.postProcess(context.page).locator('li[data-state="failed"]').getByRole('button', { name: '重试' }).click()
    await waitRunDone(context.page, fixing)
    await chapterView.postProcess(context.page).getByText('3 / 3 完成').waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(characterRequests(), 3, '第二次重试发出第三次请求并成功')
    return { firstError, secondError, characterRequests: characterRequests(), steps: await chapterView.postProcessSteps(context.page) }
  } },

  'chapter-selection': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    const prose = chapterView.prose(page)
    const line = prose.getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).first()
    await line.click({ clickCount: 3 })
    const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
    await toolbar.waitFor({ state: 'visible' })
    assert.deepEqual(await toolbar.getByRole('button').allInnerTexts(), ['润色', '扩写', '续写', '改成对话', '添加批注'])
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByText(firstLine(FIXTURE_PROSE)).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await toolbar.getByRole('button', { name: '替换' }).isEnabled(), true, '预览后可以替换')
    await toolbar.getByRole('button', { name: '替换' }).click()
    await prose.getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible' })
    const second = prose.getByText('你父亲也问过钟的事').first()
    await second.click({ clickCount: 3 })
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByRole('button', { name: '取消' }).waitFor({ state: 'visible' })
    await toolbar.getByRole('button', { name: '取消' }).click()
    await toolbar.waitFor({ state: 'hidden' })
    assert.ok((await prose.innerText()).includes('你父亲也问过钟的事'), '取消后原文不变')
    await prose.getByText(firstLine(FIXTURE_PROSE)).first().click({ clickCount: 3 })
    await toolbar.waitFor({ state: 'visible' })
  } },

  'chapter-delete': { model: false, shell: 'stage', setup: seed({ extra: args => createDraft(args, 4, 2, `${STAGE_SAMPLE.drafts[4].text}\n\n这是改写的第二稿，林岚决定先不问钟的事。`) }), run: async ({ page }) => {
    await chapterView.open(page, 4)
    assert.deepEqual(await chapterView.versions(page), ['草稿 v2 · 当前', '草稿 v1'])
    await chapterView.more(page, '删除这一稿…')
    const confirm = page.getByRole('dialog', { name: '删除第 4 章 v2？' })
    await confirm.getByText('删除后无法恢复；本章其他版本不受影响。').waitFor({ state: 'visible' })
    return { confirm: true }
  }, after: async ({ page }) => {
    await page.getByRole('dialog', { name: '删除第 4 章 v2？' }).getByRole('button', { name: '删除这一稿' }).click()
    await chapterView.versionButton(page).getByText(/^草稿 v1/).waitFor({ state: 'visible' })
    assert.deepEqual(await chapterView.versions(page), ['草稿 v1 · 当前'], '版本切换器不再列出删掉的那一稿')
  } },

  'chapter-1280': { model: false, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '关闭审稿报告' }).click()
    const alone = await charsPerLine(page)
    await afterProjectOpenSettles(page)
    await runSheet.openFromPalette(page)
    await page.waitForTimeout(500)
    assert.equal(await runSheet.sheet(page).isVisible(), true, '运行侧页开着')
    const withSheet = await charsPerLine(page)
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    assert.ok(alone >= 32 && alone <= 35, `1280 宽正文一行约 34 字，实际 ${alone}`)
    assert.ok(withSheet >= 24, `运行侧页打开后正文一行 ${withSheet} 字，被挤得太窄`)
    assert.equal(horizontal, false, '页面没有横向滚动')
    await assertContrast(page, CONTRAST.page, '单章视图')
    return { charsPerLine: alone, charsPerLineWithRunSheet: withSheet }
  } },

  'chapter-sheet-landing': { model: false, shell: 'stage', setup: seed({ extra: async ({ page, invoke, path, session }) => {
    const [finalized] = (await invoke(page, 'db:draft-list', 2, path, session)).filter(draft => draft.status === 'finalized')
    const full = await invoke(page, 'db:draft-get-full', finalized.id, path, session)
    const expectedSource = { id: full.id, chapterNumber: 2, version: full.version, status: full.status, content: full.content }
    const created = await invoke(page, 'db:review-create', { baseDraftId: full.id, content: STAGE_SAMPLE.drafts[3].review, expectedSource }, path, session)
    assert.equal(created.success, true, created.error)
    for (const draft of await invoke(page, 'db:draft-list', 4, path, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
    }
  } }), run: async ({ page }) => {
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    const landing0s = (await sheetLayout(page)).sheets
    await page.waitForTimeout(4000)
    const landing4s = (await sheetLayout(page)).sheets
    await chapterView.open(page, 2)
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible' })
    const finalChapter = (await sheetLayout(page)).sheets
    await chapterView.view(page).getByRole('button', { name: '更多操作' }).click()
    const reportInMore = await page.getByRole('menuitem', { name: '审稿报告' }).isVisible()
    await page.keyboard.press('Escape')
    await chapterView.open(page, 3)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    const backToReviewed = (await sheetLayout(page)).sheets
    assert.deepEqual({ landing0s, landing4s, finalChapter, reportInMore, backToReviewed },
      { landing0s: ['审稿报告'], landing4s: ['审稿报告'], finalChapter: [], reportInMore: true, backToReviewed: ['审稿报告'] },
      '审稿侧页只在已审稿的那一稿上展开，打开作品后不被收起')
    return { landing0s, landing4s, finalChapter, backToReviewed }
  } },

  'chapter-sheets-1280': { model: false, shell: 'stage', setup: seed(), run: ({ page }) => sheetsAt(page, 1280) },
  'chapter-sheets-1440': { model: false, shell: 'stage', setup: seed(), run: ({ page }) => sheetsAt(page, 1440) },

  'chapter-focus': { model: false, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await chapterView.open(page, 4)
    await chapterView.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).waitFor({ state: 'visible' })
    await stage.focusToggle(page).click()
    const bar = chapterView.view(page).locator('.stage-ch-focusbar')
    await bar.waitFor({ state: 'visible' })
    const panel = await page.locator('.stage-panel').evaluate(node => {
      const style = getComputedStyle(node)
      return { margin: style.margin, radius: style.borderTopLeftRadius, shadow: style.boxShadow }
    })
    assert.deepEqual(panel, { margin: '0px', radius: '0px', shadow: 'none' }, '纸面全出血')
    const words = countUnits(STAGE_SAMPLE.drafts[4].text)
    assert.equal(await bar.locator('span').first().innerText(), `${words} / ${STAGE_SAMPLE.wordsPerChapter} 字`)
    assert.equal(await bar.getByRole('progressbar').getAttribute('aria-valuenow'), String(Math.min(words, STAGE_SAMPLE.wordsPerChapter)))
    const indent = await chapterView.prose(page).locator('.cm-line').first().evaluate(node => getComputedStyle(node).textIndent)
    assert.equal(indent, '36px', '正文首行缩进两字')
    await assertContrast(page, CONTRAST.focus, '沉浸写作')
    return { words, target: STAGE_SAMPLE.wordsPerChapter }
  } },

  'chapter-tour': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    const pause = ms => page.waitForTimeout(ms)
    await pause(1200)
    await chapterView.open(page, 4)
    await pause(2000)
    await chapterView.view(page).getByRole('button', { name: '检查维度' }).click()
    await pause(2000)
    await page.keyboard.press('Escape')
    const reviewing = await runsStarted(page)
    await chapterView.review(page)
    await waitRunDone(page, reviewing)
    await pause(3000)
    await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' }).click()
    await chapterView.reviewSheet(page).getByRole('textbox', { name: '审稿问题' }).pressSequentially('守塔人的咳嗽提前出现。', { delay: 90 })
    await pause(1500)
    const revising = await runsStarted(page)
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page, revising)
    await pause(2500)
    await chapterView.merge(page).getByRole('group', { name: /用哪一版$/ }).first().getByRole('button', { name: '用修稿' }).click()
    await pause(2000)
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitRunDone(page)
    await pause(2000)
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).click()
    await pause(3000)
    await chapterView.finalizeDialog(page, 4).getByRole('button', { name: '再看看' }).click()
    await pause(800)
    await chapterView.open(page, 3)
    await pause(1500)
    const finalizing = await runsStarted(page)
    await chapterView.finalize(page, 3)
    await waitRunDone(page, finalizing)
    await pause(3000)
  } },

  'chapter-finalize-gone-en': { model: true, shell: 'stage', setup: seed(), run: async ({ app, page, invoke, shoot }) => {
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
    assert.ok(await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      const original = handlers.get('finalization:commit')
      if (!original) return false
      const gate = Promise.withResolvers()
      globalThis.__driveFinalizeGate = { release: gate.resolve, held: null }
      handlers.set('finalization:commit', async (event, snapshot, context) => {
        globalThis.__driveFinalizeGate.held = { draftId: snapshot.draftId, session: context }
        await gate.promise
        return original(event, snapshot, context)
      })
      return true
    }), '能在主进程里卡住定稿提交')
    await chapterView.view(page).getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Finalize…' }).click()
    await page.getByRole('dialog', { name: 'Finalize chapter 3?' }).getByRole('button', { name: 'Finalize', exact: true }).click()
    let held = null
    for (const deadline = Date.now() + 15_000; !held; await new Promise(resolve => setTimeout(resolve, 50))) {
      assert.ok(Date.now() < deadline, '15 秒内定稿提交没有卡在门上')
      held = await app.evaluate(() => globalThis.__driveFinalizeGate.held)
    }
    const deleted = await invoke(page, 'db:draft-delete', held.draftId, held.session.projectPath, held.session)
    assert.equal(deleted.success, true, deleted.error)
    await app.evaluate(() => globalThis.__driveFinalizeGate.release())
    const failure = page.getByText('The finalization transaction was not committed.', { exact: false }).first()
    await failure.waitFor({ state: 'visible', timeout: 30_000 })
    const observed = { failure: await failure.innerText(), lang: await page.evaluate(() => document.documentElement.lang) }
    await shoot('chapter-finalize-gone-en')
    assert.equal(observed.lang, 'en-US')
    assert.match(observed.failure, /The finalization transaction was not committed\. This draft no longer exists \(it may have been deleted\), so the change was not saved\./u)
    assert.doesNotMatch(observed.failure, /\p{Script=Han}|DRAFT_NOT_FOUND/u, '失败说明不带汉字与错误码')
    return observed
  } },

  'chapter-open': { model: false, setup: seed({ extra: args => createDraft(args, LONG_CHAPTER, 1, LONG_TEXT) }), run: async ({ page }) => {
    return { ...await openLongChapter(page), shell: await isStage(page) ? 'stage' : 'writer' }
  } },

  'typing-latency': { model: false, setup: seed({ extra: args => createDraft(args, LONG_CHAPTER, 1, LONG_TEXT) }), run: async ({ page }) => {
    await openLongChapter(page)
    const content = await proseOf(page)
    await content.getByText(LONG_TEXT_HEAD, { exact: false }).first().click()
    await page.keyboard.press('End')
    const keys = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'.split('')
    return { ...await typingLatency(page, content, keys), shell: await isStage(page) ? 'stage' : 'writer' }
  } },
}

const MERGE_PICK = {
  p1: '守塔人的屋子在灯塔背风的一侧，窗玻璃上积着经年的盐。他给林岚倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。',
  p1r: '守塔人的屋子在灯塔背风的一侧，窗玻璃上积着三十年的盐。他给林岚倒了一杯很淡的茶，自己却只是捧着杯子，盯着炉火出神。',
  p2r: '「你父亲也问过钟的事，」他顿了顿，「问得比你还急。」说完这句话，他就再也没有开口。',
  p3r: '炉火噼啪一声，林岚注意到墙上挂着一张褪色的航海图，图上的北堤被人用红笔圈了三次。',
}
const MERGE_AWAY = {
  'tab-switch': async page => {
    await stage.tab(page, /第 3 章/).click()
    await chapterView.view(page).waitFor({ state: 'visible' })
    await stage.tab(page, /第 4 章/).click()
  },
  'merge-later': async page => {
    await chapterView.merge(page).getByRole('button', { name: '稍后再合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '打开修稿合并' }).click()
  },
}
const mergeHint = page => chapterView.merge(page).locator('.stage-ch-hint')
const mergePickScenario = away => ({ model: true, shell: 'stage', setup: seed(), run: async context => {
  const { page, fake, invoke, projectPath, shoot } = context
  const flat = text => text.replace(/\s+/g, '')
  fake.replyReview(prompt => prompt.includes('【已确认纳入本次修稿的审稿项】') ? [MERGE_PICK.p1r, MERGE_PICK.p2r, MERGE_PICK.p3r].join('\n\n') : null)
  await chapterView.open(page, 4)
  const reviewing = await runsStarted(page)
  await chapterView.review(page)
  await waitRunDone(page, reviewing)
  const revising = await runsStarted(page)
  await chapterView.reviseButton(page).click()
  await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
  await waitRunDone(page, revising)
  const groups = chapterView.merge(page).getByRole('group', { name: /用哪一版$/ })
  await groups.nth(0).getByRole('button', { name: '用修稿' }).click()
  await groups.nth(2).getByRole('button', { name: '用修稿' }).click()
  const picked = await mergeHint(page).innerText()
  await shoot(`merge-pick-${away}-1-picked`)
  await MERGE_AWAY[away](page)
  await chapterView.merge(page).waitFor({ state: 'visible', timeout: 30_000 })
  const returned = await mergeHint(page).innerText()
  await shoot(`merge-pick-${away}-2-returned`)
  assert.equal(returned, picked, '回来后合并视图仍是作者选好的样子')
  await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
  await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  await waitRunDone(page)
  await shoot(`merge-pick-${away}-3-merged`)
  const session = await reopenForReading(context)
  const [draft] = await invoke(page, 'db:draft-list', 4, projectPath, session)
  const saved = flat((await invoke(page, 'db:draft-get-full', draft.id, projectPath, session)).content)
  const has = Object.fromEntries(['p1', 'p1r', 'p3r'].map(key => [key, saved.includes(flat(MERGE_PICK[key]))]))
  assert.deepEqual(has, { p1: false, p1r: true, p3r: true }, '库里的草稿正文按作者的逐段选择合并')
  return { picked, returned, status: draft.status, has }
} })
Object.assign(CHAPTER_SCENARIOS, {
  'merge-pick-tab-switch': mergePickScenario('tab-switch'),
  'merge-pick-merge-later': mergePickScenario('merge-later'),
})
