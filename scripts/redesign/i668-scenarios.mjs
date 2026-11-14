import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const MORE = Array.from({ length: 90 }, (_, index) => `第 ${index + 1} 次涨潮时，林岚又数了一遍台阶。雾钟没有响，守塔人把灯芯剪短，窗外的航标灯一盏接一盏地亮起来。`)
const longText = text => [text, ...MORE].join('\n\n')

const seed = context => seedStageSample(context, {
  beforeReload: async ({ page, invoke, path, session }) => {
    for (const chapterNumber of [3, 4]) {
      for (const draft of await invoke(page, 'db:draft-list', chapterNumber, path, session)) {
        assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
      }
      const content = longText(STAGE_SAMPLE.drafts[chapterNumber].text)
      const created = await invoke(page, 'db:draft-create', { chapterNumber, version: 1, source: 'write', content, wordCount: countUnits(content) }, path, session)
      assert.equal(created.success, true, created.error)
      if (chapterNumber === 3) {
        const expectedSource = { id: created.id, chapterNumber, version: 1, status: 'draft', content }
        const review = await invoke(page, 'db:review-create', { baseDraftId: created.id, content: STAGE_SAMPLE.drafts[3].review, expectedSource }, path, session)
        assert.equal(review.success, true, review.error)
      } else {
        assert.equal((await invoke(page, 'db:draft-update-status', created.id, 'revised', undefined, path, session)).success, true)
      }
    }
  },
})

/** 第 3 章换成长草稿与审稿，再按审稿建一份待合并修稿：每十处涨潮改一句，合并视图里有 9 处改动。 */
const seedMerge = context => seedStageSample(context, {
  landOnChapter3: false,
  beforeReload: async ({ page, invoke, path, session }) => {
    for (const draft of await invoke(page, 'db:draft-list', 3, path, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
    }
    const content = longText(STAGE_SAMPLE.drafts[3].text)
    const created = await invoke(page, 'db:draft-create', { chapterNumber: 3, version: 1, source: 'write', content, wordCount: countUnits(content) }, path, session)
    assert.equal(created.success, true, created.error)
    const expectedSource = { id: created.id, chapterNumber: 3, version: 1, status: 'draft', content }
    const review = await invoke(page, 'db:review-create', { baseDraftId: created.id, content: STAGE_SAMPLE.drafts[3].review, expectedSource }, path, session)
    assert.equal(review.success, true, review.error)
    const revised = content.replace(/(第 \d*0 次涨潮时，林岚又数了一遍台阶。)雾钟没有响/g, '$1雾钟响了三声')
    const revision = await invoke(page, 'db:revision-create', { baseDraftId: created.id, revisionType: 'review-fix', reviewSourceId: review.id,
      content: revised, wordCount: countUnits(revised), expectedSource }, path, session)
    assert.equal(revision.success, true, revision.error)
  },
})

const scroller = page => chapterView.view(page).locator('.stage-ch-scroll')

/** 编辑器量完行高后正文还会变长，要连续几帧停在底部才算到底。 */
async function scrollToEnd(page) {
  await scroller(page).evaluate(async element => {
    for (let settled = 0; settled < 3;) {
      element.scrollTop = element.scrollHeight
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      settled = element.scrollTop + element.clientHeight >= element.scrollHeight - 1 ? settled + 1 : 0
    }
  })
}

const hit = button => button.evaluate(element => {
  const rect = element.getBoundingClientRect()
  return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
})

const scrollState = page => scroller(page).evaluate(element => ({ top: Math.round(element.scrollTop), height: element.scrollHeight, client: element.clientHeight }))

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

const bottomOf = locator => locator.evaluate(element => Math.round(element.getBoundingClientRect().bottom))

export const I668_SCENARIOS = {
  'i668-long-chapter': { model: false, shell: 'stage', setup: seed, run: async ({ page, shoot }) => {
    const revise = chapterView.reviseButton(page)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await revise.waitFor({ state: 'visible' })
    await shoot('i668-review-top')

    await scroller(page).evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await shoot('i668-review-mid')

    await scrollToEnd(page)
    const reviewEnd = await scrollState(page)
    const reviewHit = await hit(revise)
    await shoot('i668-review-end')
    assert.ok(reviewEnd.top > 0, '第 3 章正文够长，滚得动')
    assert.equal(reviewHit, true, '审稿报告开着、滚到末尾时，修稿主按钮仍可点')

    await chapterView.open(page, 4)
    const finalize = chapterView.view(page).getByRole('button', { name: '定稿', exact: true })
    await finalize.waitFor({ state: 'visible' })
    await scrollToEnd(page)
    const revisedEnd = await scrollState(page)
    const revisedHit = await hit(finalize)
    await shoot('i668-revised-end')
    assert.equal(revisedHit, true, '已修稿滚到末尾时，定稿按钮仍可点')

    await finalize.click()
    await chapterView.finalizeDialog(page, 4).waitFor({ state: 'visible' })
    const afterClick = await scrollState(page)
    assert.equal(afterClick.top, revisedEnd.top, '点定稿不用先把页面滚回去')
    await page.keyboard.press('Escape')
    await chapterView.finalizeDialog(page, 4).waitFor({ state: 'hidden' })

    await chapterView.prose(page).click()
    await page.keyboard.press('ControlOrMeta+F')
    const search = chapterView.view(page).locator('.cm-search input[name="search"]')
    await page.keyboard.type('第 20 次涨潮')
    await page.keyboard.press('Enter')
    const match = chapterView.prose(page).locator('.cm-line', { hasText: '第 20 次涨潮' })
    await match.waitFor({ state: 'visible' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const searchMatch = await chapterView.view(page).evaluate(view => ({
      bar: Math.round(view.querySelector('.stage-ch-actions-sticky').getBoundingClientRect().bottom),
      line: Math.round([...view.querySelectorAll('.cm-line')].find(line => line.textContent.includes('第 20 次涨潮')).getBoundingClientRect().top),
    }))
    await shoot('i668-search-match')
    assert.ok(searchMatch.line >= searchMatch.bar, '搜索跳到的匹配行不被动作条挡住')
    await page.keyboard.press('Escape')
    await search.waitFor({ state: 'detached' })
    const finalizeAfterSearch = await hit(finalize)
    assert.equal(finalizeAfterSearch, true, '关掉搜索后定稿按钮仍点得到')

    await stage.focusToggle(page).click()
    await stage.spine(page).waitFor({ state: 'detached' })
    await scroller(page).evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const focusHit = await hit(finalize)
    await shoot('i668-focus-mid')
    assert.equal(focusHit, true, '沉浸写作滚到中段时，定稿按钮仍可点')
    await page.keyboard.press('Escape')
    await stage.spine(page).waitFor({ state: 'visible' })

    return { reviewEnd, reviewHit, revisedEnd, revisedHit, afterClick, searchMatch, finalizeAfterSearch, focusHit }
  } },
  'i668-review-1280': { model: false, shell: 'stage', setup: async context => {
    await context.page.setViewportSize({ width: 1280, height: 900 })
    await seed(context)
  }, run: async ({ page, shoot }) => {
    const revise = chapterView.reviseButton(page)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await revise.waitFor({ state: 'visible' })
    await scroller(page).evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const reviewHit = await hit(revise)
    const barHeight = await chapterView.view(page).locator('.stage-ch-actions-sticky').evaluate(element => element.offsetHeight)
    await shoot('i668-review-1280-mid')
    assert.equal(reviewHit, true, '1280 宽、审稿报告开着、滚到中段时，修稿主按钮仍可点')
    return { reviewHit, barHeight }
  } },
  'i668-merge-search': { model: false, shell: 'stage', setup: seedMerge, run: async ({ page, shoot }) => {
    await chapterView.open(page, 3)
    const merge = chapterView.merge(page)
    const finish = merge.getByRole('button', { name: '完成合并' })
    await finish.waitFor({ state: 'visible' })
    const changes = await merge.getByRole('group', { name: /用哪一版$/ }).count()
    await shoot('i668-merge-top')

    await scrollToEnd(page)
    const mergeEnd = await scrollState(page)
    const finishHit = await hit(finish)
    await shoot('i668-merge-end')
    assert.ok(mergeEnd.top > 0, '合并视图够长，滚得动')
    assert.equal(finishHit, true, '合并视图滚到末尾时，完成合并仍可点')

    const bar = merge.locator('.stage-ch-actions')
    await merge.getByRole('group', { name: /用哪一版$/ }).last().locator('[tabindex="0"]').focus()
    const focusTops = []
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press('Shift+Tab')
      focusTops.push(await page.evaluate(() => Math.round(document.activeElement.getBoundingClientRect().top)))
    }
    const mergeBarBottom = await bottomOf(bar)
    await shoot('i668-merge-shift-tab')
    assert.ok(focusTops.every(top => top >= mergeBarBottom), 'Shift+Tab 往上走时焦点停在动作条下面')

    await merge.getByRole('button', { name: '稍后再合并' }).click()
    await merge.waitFor({ state: 'detached' })
    await scroller(page).evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
    await settle(page)
    const middleLine = chapterView.prose(page).locator('.cm-line', { hasText: '第 45 次涨潮' })
    await middleLine.click()
    await page.keyboard.press('ControlOrMeta+F')
    const input = chapterView.view(page).locator('.cm-search input[name="search"]')
    await input.waitFor({ state: 'visible' })
    await settle(page)
    const searchHit = await hit(input)
    const primaryHit = await hit(chapterView.primary(page))
    const readingLine = await middleLine.evaluate(element => Math.round(element.getBoundingClientRect().top))
    const viewport = await scrollState(page)
    await shoot('i668-search-mid')
    assert.equal(searchHit, true, '读到中段按 Ctrl F，搜索框就在眼前')
    assert.equal(primaryHit, true, '搜索框开着，动作条主按钮仍可点')
    assert.ok(readingLine > 0 && readingLine < viewport.client, '读到的那段还在视口里')

    await page.keyboard.type('第 20 次涨潮')
    await page.keyboard.press('Shift+Enter')
    const match = chapterView.prose(page).locator('.cm-line', { hasText: '第 20 次涨潮' })
    await match.waitFor({ state: 'visible' })
    await settle(page)
    const panelBottom = await bottomOf(chapterView.view(page).locator('.cm-panels-top'))
    const matchTop = await match.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return Math.round(range.getClientRects()[0].top)
    })
    await shoot('i668-search-prev')
    assert.ok(matchTop >= panelBottom, '往上找到的匹配行不被搜索面板挡住')

    return { changes, mergeEnd, finishHit, focusTops, mergeBarBottom, searchHit, primaryHit, readingLine, panelBottom, matchTop }
  } },
}
