import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

const PARAGRAPH = '守塔人说，雾钟是三十年前装上的，从那以后只坏过一次。那一次，北堤外沉了一条船，船名至今没人能在档案里找到。'
const NOTE = '沉船写得更具体'
const REVISED = STAGE_SAMPLE.drafts[3].text.replace('北堤外沉了一条船', '北堤外沉了一条运煤的双桅船')

const LOCK_HINT = '批注修改还在等你处理，修稿或换稿会冲掉它。先接受或取消批注修改。'
const MORE = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 次涨潮时，林岚又数了一遍台阶。`).join('\n\n')

// 修稿只改第一段，与批注的那段不重叠。
const seedPendingRevision = context => seedStageSample(context, {
  landOnChapter3: false,
  beforeReload: async ({ page, invoke, path, session }) => {
    for (const draft of await invoke(page, 'db:draft-list', 3, path, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
    }
    const content = STAGE_SAMPLE.drafts[3].text
    const created = await invoke(page, 'db:draft-create', { chapterNumber: 3, version: 1, source: 'write', content, wordCount: countUnits(content) }, path, session)
    assert.equal(created.success, true, created.error)
    const expectedSource = { id: created.id, chapterNumber: 3, version: 1, status: 'draft', content }
    const review = await invoke(page, 'db:review-create', { baseDraftId: created.id, content: STAGE_SAMPLE.drafts[3].review, expectedSource }, path, session)
    assert.equal(review.success, true, review.error)
    const revised = content.replace('钟声比往常早了一刻', '钟声比往常早了整整一刻')
    const revision = await invoke(page, 'db:revision-create', { baseDraftId: created.id, revisionType: 'review-fix', reviewSourceId: review.id,
      content: revised, wordCount: countUnits(revised), expectedSource }, path, session)
    assert.equal(revision.success, true, revision.error)
  },
})

// 第 3 章 v1 是已审稿的草稿，之后导入了 v2 定稿：v1 不能直接定稿，只能以它重新打开本章。
const seedOlderDraft = context => seedStageSample(context, {
  landOnChapter3: false,
  beforeReload: async ({ page, invoke, path, session }) => {
    const content = STAGE_SAMPLE.finalized[2]
    const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
      chapters: [{ chapterNumber: 3, title: stageChapterTitle(3), content, wordCount: countUnits(content) }] }, path, session)
    assert.equal(imported.success, true, imported.error)
  },
})

const dock = page => page.getByRole('region', { name: '本章批注' })
const marks = page => chapterView.prose(page).locator('.cm-editor-annotation').count()
const proseWidth = page => chapterView.view(page).locator('.stage-ch-prose').evaluate(node => Math.round(node.getBoundingClientRect().width))

async function annotate(page) {
  await chapterView.prose(page).getByText(PARAGRAPH).first().click({ clickCount: 3 })
  const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
  await toolbar.getByRole('button', { name: '添加批注' }).click()
  await toolbar.getByRole('textbox', { name: '批注意见' }).fill(NOTE)
  await toolbar.getByRole('button', { name: '添加批注' }).click()
  await toolbar.waitFor({ state: 'hidden' })
}

export const ADOCK_SCENARIOS = {
  'adock-dock-vs-review': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const measured = {}
    await page.setViewportSize({ width: 1028, height: 900 })
    await chapterView.open(page, 3)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    measured.proseWithReview = await proseWidth(page)

    await annotate(page)
    await dock(page).waitFor({ state: 'visible' })
    measured.reviewAfterAnnotate = await chapterView.reviewSheet(page).count()
    assert.equal(measured.reviewAfterAnnotate, 0, '加批注后审稿报告收起')
    measured.proseWithDock = await proseWidth(page)
    measured.dockTitle = await dock(page).locator('.cm-selbar-title').innerText()
    assert.equal(measured.dockTitle, '本章批注 · 1')
    assert.ok(measured.proseWithDock >= measured.proseWithReview, '只开批注坞时正文栏不比只开报告时窄')
    await shoot('adock-1-dock-1028')

    await chapterView.more(page, '审稿报告')
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    measured.dockWithReview = await dock(page).count()
    assert.equal(measured.dockWithReview, 0, '打开报告时批注坞让位')
    measured.proseReviewAgain = await proseWidth(page)
    assert.equal(measured.proseReviewAgain, measured.proseWithReview)
    measured.marks = await chapterView.prose(page).locator('.cm-editor-annotation').count()
    assert.equal(measured.marks, 1, '报告开着时正文里的批注底色还在')
    await shoot('adock-2-review-1028')

    await chapterView.reviewSheet(page).getByRole('button', { name: '关闭审稿报告' }).first().click()
    await dock(page).waitFor({ state: 'visible' })
    measured.dockTitleBack = await dock(page).locator('.cm-selbar-title').innerText()
    assert.equal(measured.dockTitleBack, '本章批注 · 1')
    await page.setViewportSize({ width: 1440, height: 900 })
    return measured
  } },

  'adock-copy': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    const measured = {}
    await chapterView.open(page, 3)
    await page.evaluate(() => {
      window.__copied = []
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied.push(text) } } })
    })
    fake.gate.hold()
    await chapterView.prose(page).getByText(PARAGRAPH).first().click({ clickCount: 3 })
    const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByRole('status').waitFor({ state: 'visible' })
    await page.keyboard.press('End')
    await page.keyboard.type('雾更浓了。')
    fake.gate.release()
    const preview = toolbar.locator('.cm-selbar-text')
    await preview.waitFor({ state: 'visible', timeout: 60_000 })
    await toolbar.getByRole('button', { name: '替换' }).click()
    measured.error = await toolbar.getByRole('alert').innerText()
    assert.equal(measured.error, '正文或原目标已变化，结果未应用；你仍可复制预览内容')
    measured.preview = await preview.innerText()
    await shoot('adock-3-copy')

    await toolbar.getByRole('button', { name: '复制' }).click()
    measured.copied = await page.evaluate(() => window.__copied)
    assert.deepEqual(measured.copied, [measured.preview], '剪贴板收到的是预览原文')
    return measured
  } },

  'adock-readonly': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    const measured = {}
    fake.replyReview(prompt => prompt.includes(NOTE) ? REVISED : null)
    await chapterView.open(page, 3)
    await annotate(page)
    await dock(page).getByRole('button', { name: '统一修改（1）' }).click()
    const review = page.getByRole('region', { name: '批注修改对比' })
    await review.waitFor({ state: 'visible', timeout: 60_000 })

    fake.gate.hold()
    await chapterView.view(page).getByRole('button', { name: '重新审稿', exact: true }).click()
    for (let i = 0; fake.gate.waiting === 0; i++) { assert.ok(i < 600, '审稿请求停在假模型的门上'); await page.waitForTimeout(100) }
    await review.getByRole('button', { name: '接受全部' }).click()
    const alert = review.getByRole('alert')
    measured.alert = await alert.innerText()
    assert.equal(measured.alert, '修改还在，但正文现在不能编辑，没有保存。等本章任务结束再点「接受全部」，或点「取消」放弃。')
    measured.alertInViewport = await alert.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight })
    assert.equal(measured.alertInViewport, true, '点「接受全部」后提示就在眼前，不在长正文的末尾')
    await shoot('adock-4-readonly')

    fake.gate.release()
    await chapterView.reviewSheet(page).waitFor({ state: 'visible', timeout: 60_000 })
    await review.getByRole('button', { name: '接受全部' }).click()
    await review.waitFor({ state: 'hidden', timeout: 30_000 })
    await chapterView.prose(page).getByText('北堤外沉了一条运煤的双桅船').waitFor({ state: 'visible' })
    measured.savedAfterTask = true
    return measured
  } },

  'adock-restore-review': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    const measured = {}
    fake.replyReview(prompt => prompt.includes(NOTE) ? REVISED : null)
    await chapterView.open(page, 3)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await shoot('adock-r1-review-before')

    await annotate(page)
    await dock(page).waitFor({ state: 'visible' })
    measured.reviewWhileDocked = await chapterView.reviewSheet(page).count()
    assert.equal(measured.reviewWhileDocked, 0, '加批注后审稿报告让位')
    measured.dockTitle = await dock(page).locator('.cm-selbar-title').innerText()
    assert.equal(measured.dockTitle, '本章批注 · 1')
    await shoot('adock-r2-docked')

    await dock(page).getByRole('button', { name: '统一修改（1）' }).click()
    const review = page.getByRole('region', { name: '批注修改对比' })
    await review.waitFor({ state: 'visible', timeout: 60_000 })
    await review.getByRole('button', { name: '接受全部' }).click()
    await review.waitFor({ state: 'hidden', timeout: 30_000 })
    await chapterView.prose(page).getByText('北堤外沉了一条运煤的双桅船').waitFor({ state: 'visible' })
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    measured.dockAfterCommit = await dock(page).count()
    assert.equal(measured.dockAfterCommit, 0, '统一修改写进正文后批注坞收起')
    await shoot('adock-r3-review-back')
    return measured
  } },

  'adock-restore-run': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const measured = {}
    await chapterView.open(page, 3)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await runSheet.openFromPalette(page)
    measured.reviewUnderRun = await chapterView.reviewSheet(page).count()
    assert.equal(measured.reviewUnderRun, 0, '运行侧页顶替审稿报告')
    await shoot('adock-r4-run-before')
    await annotate(page)
    await dock(page).waitFor({ state: 'visible' })
    measured.runWhileDocked = await runSheet.sheet(page).count()
    assert.equal(measured.runWhileDocked, 0, '加批注后运行侧页让位')
    await shoot('adock-r4-run-docked')

    await dock(page).getByRole('button', { name: '删除批注 1' }).click()
    await runSheet.waitUntilOpen(page)
    measured.dockAfterDelete = await dock(page).count()
    measured.reviewAfterDelete = await chapterView.reviewSheet(page).count()
    assert.equal(measured.dockAfterDelete, 0)
    assert.equal(measured.reviewAfterDelete, 0, '只放回运行侧页，不另开审稿报告')
    measured.marksAfterDelete = await marks(page)
    assert.equal(measured.marksAfterDelete, 0, '正文里不留批注底色')
    await chapterView.prose(page).getByText(PARAGRAPH).first().click()
    await shoot('adock-r4-run-back')
    return measured
  } },

  'adock-restore-empty': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const measured = {}
    await chapterView.open(page, 3)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await chapterView.reviewSheet(page).getByRole('button', { name: '关闭审稿报告' }).first().click()
    await chapterView.reviewSheet(page).waitFor({ state: 'hidden' })
    await annotate(page)
    await dock(page).waitFor({ state: 'visible' })

    await dock(page).getByRole('button', { name: '清空' }).click()
    await dock(page).waitFor({ state: 'hidden' })
    await page.waitForTimeout(500)
    measured.reviewAfterClear = await chapterView.reviewSheet(page).count()
    measured.runAfterClear = await runSheet.sheet(page).count()
    assert.equal(measured.reviewAfterClear, 0, '之前侧栏空着，清空批注后仍空着')
    assert.equal(measured.runAfterClear, 0)
    measured.marksAfterClear = await marks(page)
    assert.equal(measured.marksAfterClear, 0, '正文里不留批注底色')
    await chapterView.prose(page).getByText(PARAGRAPH).first().click()
    await shoot('adock-r5-empty')
    return measured
  } },

  'adock-restore-empty-commit': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    const measured = {}
    fake.replyReview(prompt => prompt.includes(NOTE) ? REVISED : null)
    await chapterView.open(page, 3)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await chapterView.reviewSheet(page).getByRole('button', { name: '关闭审稿报告' }).first().click()
    await chapterView.reviewSheet(page).waitFor({ state: 'hidden' })
    await annotate(page)
    await dock(page).getByRole('button', { name: '统一修改（1）' }).click()
    const review = page.getByRole('region', { name: '批注修改对比' })
    await review.waitFor({ state: 'visible', timeout: 60_000 })
    await review.getByRole('button', { name: '接受全部' }).click()
    await review.waitFor({ state: 'hidden', timeout: 30_000 })
    await chapterView.prose(page).getByText('北堤外沉了一条运煤的双桅船').waitFor({ state: 'visible' })
    await page.waitForTimeout(1000)
    measured.reviewAfterCommit = await chapterView.reviewSheet(page).count()
    measured.runAfterCommit = await runSheet.sheet(page).count()
    measured.dockAfterCommit = await dock(page).count()
    assert.equal(measured.reviewAfterCommit, 0, '之前侧栏空着，提交后不替作者打开报告')
    assert.equal(measured.runAfterCommit, 0)
    assert.equal(measured.dockAfterCommit, 0)
    await shoot('adock-r6-empty-commit')
    return measured
  } },

  'adock-lock-revise': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    const measured = {}
    fake.replyReview(prompt => prompt.includes(NOTE) ? REVISED : null)
    await chapterView.open(page, 3)
    await annotate(page)
    await dock(page).getByRole('button', { name: '统一修改（1）' }).click()
    const review = page.getByRole('region', { name: '批注修改对比' })
    await review.waitFor({ state: 'visible', timeout: 60_000 })

    const revise = chapterView.view(page).getByRole('button', { name: /项意见修稿$/ })
    measured.reviseLabel = await revise.innerText()
    measured.reviseDisabled = await revise.isDisabled()
    assert.equal(measured.reviseDisabled, true, '审阅摆着时「按 N 项意见修稿」不可点')
    measured.hint = await chapterView.view(page).locator('.stage-ch-hint').innerText()
    assert.equal(measured.hint, LOCK_HINT)
    await shoot('adock-l1-locked')
    await chapterView.view(page).getByRole('button', { name: '更多操作' }).click()
    const refine = page.getByRole('menuitem', { name: '直接修稿…' })
    measured.refineDisabled = await refine.isDisabled()
    assert.equal(measured.refineDisabled, true, '审阅摆着时「直接修稿」不可点')
    await shoot('adock-l1-locked-menu')

    await page.keyboard.press('Escape')
    await review.getByRole('button', { name: '取消' }).click()
    await review.waitFor({ state: 'hidden' })
    measured.reviseDisabledAfterCancel = await revise.isDisabled()
    assert.equal(measured.reviseDisabledAfterCancel, false, '取消批注修改后修稿入口恢复')
    measured.hintAfterCancel = await chapterView.view(page).locator('.stage-ch-hint').innerText()
    assert.equal(measured.hintAfterCancel, '修稿结果会以差异给你确认，不会直接覆盖')
    await shoot('adock-l2-unlocked')
    return measured
  } },

  'adock-lock-merge': { model: true, shell: 'stage', setup: seedPendingRevision, run: async ({ page, fake, shoot }) => {
    const measured = {}
    fake.replyReview(prompt => prompt.includes(NOTE) ? REVISED : null)
    await chapterView.open(page, 3)
    await chapterView.merge(page).getByRole('button', { name: '稍后再合并' }).click()
    await chapterView.merge(page).waitFor({ state: 'detached' })
    await annotate(page)
    await dock(page).getByRole('button', { name: '统一修改（1）' }).click()
    const review = page.getByRole('region', { name: '批注修改对比' })
    await review.waitFor({ state: 'visible', timeout: 60_000 })

    const openMerge = chapterView.view(page).getByRole('button', { name: '打开修稿合并' })
    measured.openMergeDisabled = await openMerge.isDisabled()
    assert.equal(measured.openMergeDisabled, true, '审阅摆着时「打开修稿合并」不可点')
    measured.hint = await chapterView.hint(page).innerText()
    assert.equal(measured.hint, LOCK_HINT)
    await shoot('adock-m1-locked')

    await review.getByRole('button', { name: '取消' }).click()
    await review.waitFor({ state: 'hidden' })
    measured.openMergeDisabledAfterCancel = await openMerge.isDisabled()
    assert.equal(measured.openMergeDisabledAfterCancel, false, '取消后「打开修稿合并」恢复可点')
    await page.waitForTimeout(500)
    measured.mergeAfterCancel = await chapterView.merge(page).count()
    assert.equal(measured.mergeAfterCancel, 0, '取消后不替作者打开修稿合并')
    measured.hintAfterCancel = await chapterView.hint(page).innerText()
    assert.equal(measured.hintAfterCancel, '修稿已生成，逐段选择后完成合并')
    await shoot('adock-m2-unlocked')
    return measured
  } },

  'adock-lock-reopen': { model: true, shell: 'stage', setup: seedOlderDraft, run: async ({ page, fake, shoot }) => {
    const measured = {}
    fake.replyReview(prompt => prompt.includes(NOTE) ? REVISED : null)
    await chapterView.open(page, 3)
    await chapterView.versionButton(page).click()
    await page.getByRole('menu', { name: '本章版本' }).getByRole('menuitemradio', { name: /^草稿 v1/ }).click()
    const reopen = chapterView.view(page).getByRole('button', { name: '以这一稿重新打开' })
    await reopen.waitFor({ state: 'visible' })
    await annotate(page)
    await dock(page).getByRole('button', { name: '统一修改（1）' }).click()
    const review = page.getByRole('region', { name: '批注修改对比' })
    await review.waitFor({ state: 'visible', timeout: 60_000 })

    measured.reopenDisabled = await reopen.isDisabled()
    assert.equal(measured.reopenDisabled, true, '审阅摆着时「以这一稿重新打开」不可点')
    measured.versionsDisabled = await chapterView.versionButton(page).isDisabled()
    assert.equal(measured.versionsDisabled, true, '审阅摆着时版本切换不可点')
    measured.hint = await chapterView.hint(page).innerText()
    assert.equal(measured.hint, LOCK_HINT)
    await reopen.scrollIntoViewIfNeeded()
    await shoot('adock-o1-locked')

    await review.getByRole('button', { name: '取消' }).click()
    await review.waitFor({ state: 'hidden' })
    await reopen.click({ trial: true })
    measured.reopenDisabledAfterCancel = await reopen.isDisabled()
    assert.equal(measured.reopenDisabledAfterCancel, false, '取消后「以这一稿重新打开」恢复可点')
    measured.versionsDisabledAfterCancel = await chapterView.versionButton(page).isDisabled()
    assert.equal(measured.versionsDisabledAfterCancel, false, '取消后版本切换恢复可点')
    await shoot('adock-o2-unlocked')
    return measured
  } },

  'adock-reveal': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    const measured = {}
    fake.replyReview(prompt => prompt.includes(NOTE) ? REVISED : null)
    await chapterView.open(page, 3)
    await annotate(page)
    fake.gate.hold()
    await dock(page).getByRole('button', { name: '统一修改（1）' }).click()
    const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
    await toolbar.getByRole('status').waitFor({ state: 'visible' })

    await chapterView.prose(page).locator('.cm-line').last().click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText(`\n\n${MORE}`)
    await toolbar.waitFor({ state: 'hidden' })
    fake.gate.release()
    const back = chapterView.view(page).getByRole('button', { name: '回到预览' })
    await back.waitFor({ state: 'visible' })
    await page.waitForTimeout(2000)
    measured.hint = await chapterView.hint(page).innerText()
    assert.equal(measured.hint, `${LOCK_HINT}回到预览`)
    measured.toolbarWhileHidden = await toolbar.count()
    assert.equal(measured.toolbarWhileHidden, 0, '预览滚出视口后看不见')
    await shoot('adock-v1-hidden')

    await back.click()
    await toolbar.getByText('正文或原目标已变化，结果未应用；你仍可复制预览内容').waitFor({ state: 'visible', timeout: 60_000 })
    measured.backAfterReveal = await back.count()
    assert.equal(measured.backAfterReveal, 0, '预览摆出后不再给「回到预览」')
    await shoot('adock-v2-revealed')

    await toolbar.getByRole('button', { name: '取消' }).click()
    await dock(page).waitFor({ state: 'visible' })
    measured.hintAfterCancel = await chapterView.hint(page).innerText()
    assert.ok(!measured.hintAfterCancel.startsWith(LOCK_HINT), '取消后解锁')
    return measured
  } },
}
