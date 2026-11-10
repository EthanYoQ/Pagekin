import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { FIXTURE_PROSE } from './fake-model.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as stage from './pages/stage.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

const PLANS = Object.freeze([
  { title: '青铜钥匙', type: '伏笔', targetStartChapter: 1, targetEndChapter: 2, authorIntent: '第二章揭示钥匙能打开灯室。' },
  { title: '父亲的旧信', type: '伏笔', targetStartChapter: 3, targetEndChapter: 5, authorIntent: '第五章林岚读到父亲的旧信。' },
])

/** 只给线索硬任务场景加的一条：夹具正文写了林岚对照父亲的地图找灯塔，审稿判已回收有引文可依。 */
const MAP_PLAN = Object.freeze({ title: '父亲的地图', type: '伏笔', targetStartChapter: 3, targetEndChapter: 5, authorIntent: '林岚对照父亲的地图找到灯塔。' })

const ECHO_PLAN = Object.freeze({ title: '灯塔的回声', type: '支线', targetStartChapter: 4, targetEndChapter: 9, authorIntent: '后文交代回声的来源。' })

const seedWith = plans => context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(), chapters: [3, 4].map((number) => {
    const content = STAGE_SAMPLE.drafts[number].text
    return { chapterNumber: number, title: stageChapterTitle(number), content, wordCount: countUnits(content) }
  }) }, path, session)
  assert.equal(imported.success, true, imported.error)
  for (const plan of plans) {
    const created = await invoke(page, 'db:narrative-thread-plan-create', plan, path, session)
    assert.equal(created.success, true, created.error)
  }
} })
const seed = seedWith(PLANS)

const contractOf = chat => chat.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
  .split('\n').filter(text => text.startsWith('- 本章推进或回收：'))

export const A11_SCENARIOS = {
  'a11-thread-defer': { model: true, shell: 'stage', setup: seedWith([...PLANS, ECHO_PLAN]), run: async ({ page, fake, shoot }) => {
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    const hint = count => chapterView.view(page).getByRole('button', { name: `本章要处理 ${count} 条线索` })
    const row = title => popover.getByRole('listitem').filter({ hasText: title })
    const writeChapter = async () => {
      const before = fake.chats.filter(chat => chat.kind === 'prose').length
      await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
      await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 90_000 })
      const prose = fake.chats.filter(chat => chat.kind === 'prose').slice(before)
      assert.equal(prose.length, 1, '开写只发一次正文请求')
      return prose[0]
    }

    await chapterView.open(page, 5)
    await hint(2).waitFor({ state: 'visible', timeout: 15_000 })
    assert.equal(await popover.isVisible(), false, '线索到期不自动打开弹层')
    await shoot('a11-thread-defer-hint')
    await blueprint.open(page)
    await page.getByRole('button', { name: '本章要处理 2 条线索' }).waitFor({ state: 'visible', timeout: 15_000 })
    await shoot('a11-thread-defer-blueprint')
    await stage.stageButton(page, '正文').click()
    await chapterView.open(page, 5)

    await hint(2).click()
    await row('父亲的旧信').getByText('本章到期').waitFor({ state: 'visible' })
    await row('青铜钥匙').getByText('逾期 3 章').waitFor({ state: 'visible' })
    await popover.getByText('也可以本章推进').click()
    await row('灯塔的回声').getByRole('button', { name: '本章推进' }).waitFor({ state: 'visible' })
    await shoot('a11-thread-defer-open')

    await row('父亲的旧信').getByRole('button', { name: '延后一章' }).click()
    await row('父亲的旧信').getByText('已延到第 6 章').waitFor({ state: 'visible' })
    await row('灯塔的回声').getByRole('button', { name: '本章推进' }).click()
    await hint(2).waitFor({ state: 'visible' })
    await row('灯塔的回声').getByRole('button', { name: '撤销' }).waitFor({ state: 'visible' })
    await shoot('a11-thread-defer-done')
    await page.keyboard.press('Escape')

    const chapter5 = await writeChapter()
    const contract5 = contractOf(chapter5)
    assert.deepEqual(contract5, [
      '- 本章推进或回收：灯塔的回声（作者指定本章推进；作者意图：后文交代回声的来源。）',
      '- 本章推进或回收：青铜钥匙（已逾期 3 章；作者意图：第二章揭示钥匙能打开灯室。）',
    ], '第 5 章合同：指定的在最前，延后的旧信不在')
    const prompt5 = chapter5.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    const letterLine = prompt5.split('\n').find(text => text.startsWith('- 父亲的旧信 ')) ?? ''
    assert.match(letterLine, /目标第3–6章/, '旧信仍作软参考，目标写新的截止章')
    assert.doesNotMatch(letterLine, /本章到期|已逾期/, '旧信不再标到期')

    await chapterView.finalize(page, 5)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    await chapterView.open(page, 6)
    await hint(2).waitFor({ state: 'visible', timeout: 15_000 })
    await shoot('a11-thread-defer-next-chapter')
    await hint(2).click()
    await row('父亲的旧信').getByText('本章到期').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    // 假模型每章回同一段正文，第 6 章开头会被判成重演而不落稿；这里只看发出去的合同。
    const proseBefore = fake.chats.filter(chat => chat.kind === 'prose').length
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    for (const deadline = Date.now() + 60_000; fake.chats.filter(chat => chat.kind === 'prose').length === proseBefore;) {
      assert.ok(Date.now() < deadline, '第 6 章发出了正文请求')
      await page.waitForTimeout(100)
    }
    const contract6 = contractOf(fake.chats.filter(chat => chat.kind === 'prose')[proseBefore])
    assert.deepEqual(contract6, [
      '- 本章推进或回收：青铜钥匙（已逾期 4 章；作者意图：第二章揭示钥匙能打开灯室。）',
      '- 本章推进或回收：父亲的旧信（本章到期；作者意图：第五章林岚读到父亲的旧信。）',
    ], '第 6 章旧信重新到期，指定只管第 5 章')

    await refs.open(page, 'plot')
    await refs.plotView(page, '伏笔线索').click()
    await page.getByText('原定第 5 章，延到第 6 章 · 写第 5 章时延后').waitFor({ state: 'visible', timeout: 15_000 })
    await shoot('a11-thread-defer-trace')
    return { contract5, letterLine, contract6 }
  } },
  'a11-overdue-thread-prompt': { model: true, shell: 'stage', setup: seed, run: async ({ page, fake }) => {
    await chapterView.open(page, 5)
    const proseBefore = fake.chats.filter(chat => chat.kind === 'prose').length
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 90_000 })
    const prose = fake.chats.filter(chat => chat.kind === 'prose').slice(proseBefore)
    assert.equal(prose.length, 1, '写第 5 章只发一次正文请求')
    const prompt = prose[0].messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    const line = title => prompt.split('\n').find(text => text.startsWith(`- ${title} `)) ?? ''
    const measured = { overdue: line('青铜钥匙'), due: line('父亲的旧信') }
    assert.match(measured.overdue, /已逾期 3 章/, '计划第 1–2 章的线索在写第 5 章时标已逾期 3 章')
    assert.match(measured.due, /本章到期/, '计划第 3–5 章的线索在第 5 章标本章到期')
    await refs.open(page, 'plot')
    await refs.plotView(page, '伏笔线索').click()
    await page.getByText('写正文时会参考这里，到期和逾期的排在最前。', { exact: false }).waitFor({ state: 'visible' })
    return measured
  } },
  'a11-thread-tasks': { model: true, shell: 'stage', setup: seedWith([...PLANS, MAP_PLAN]), run: async ({ page, fake, shoot }) => {
    await chapterView.open(page, 5)
    const promptOf = chat => chat.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    const proseBefore = fake.chats.filter(chat => chat.kind === 'prose').length
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 90_000 })
    const prose = fake.chats.filter(chat => chat.kind === 'prose').slice(proseBefore)
    assert.equal(prose.length, 1, '写第 5 章只发一次正文请求')
    const contract = promptOf(prose[0]).split('\n').filter(text => text.startsWith('- 本章推进或回收：'))
    assert.deepEqual(contract, [
      '- 本章推进或回收：青铜钥匙（已逾期 3 章；作者意图：第二章揭示钥匙能打开灯室。）',
      '- 本章推进或回收：父亲的旧信（本章到期；作者意图：第五章林岚读到父亲的旧信。）',
      '- 本章推进或回收：父亲的地图（本章到期；作者意图：林岚对照父亲的地图找到灯塔。）',
    ], '执行合同按逾期在前列出三条线索硬任务')

    fake.replyReview(prompt => {
      if (!prompt.includes('goalReviews')) return null
      const authorGoals = [...new Set(prompt.match(/ch5:(?!thread:)[a-zA-Z]+:\d+/gu) ?? [])]
      return JSON.stringify({ summary: '地图线索已交代，钥匙和旧信还没出现。', items: [
        { category: '连续性', severity: 'pass', description: '本章时间线与前文一致。' },
      ], goalReviews: [
        ...authorGoals.map(id => ({ id, status: 'completed', description: '林岚在塔下得到钟声提前的线索。', evidence: [{ quote: '说昨夜的钟声比往常早了一刻' }] })),
        { id: 'ch5:thread:1', status: 'unaddressed', description: '本章没有写到青铜钥匙。', evidence: [] },
        { id: 'ch5:thread:2', status: 'unaddressed', description: '本章没有写到父亲的旧信。', evidence: [] },
        { id: 'ch5:thread:3', status: 'resolved', description: '林岚对照父亲的地图找到了灯塔的位置。', evidence: [{ quote: '对照远处灯塔的位置' }] },
      ] })
    })
    const reviewsBefore = fake.chats.filter(chat => chat.kind === 'review').length
    await chapterView.review(page)
    const reviews = fake.chats.filter(chat => chat.kind === 'review').slice(reviewsBefore)
    assert.equal(reviews.length, 1, '审稿只发一次请求，线索目标不另调模型')
    const reviewPrompt = promptOf(reviews[0])
    const threadGoals = [...new Set(reviewPrompt.match(/ch5:thread:\d+/gu) ?? [])]
    assert.deepEqual(threadGoals, ['ch5:thread:1', 'ch5:thread:2', 'ch5:thread:3'], '审稿目标里有三条线索任务，编号是计划 id')
    const sheet = chapterView.reviewSheet(page)
    await sheet.getByText('父亲的旧信', { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 })
    await sheet.getByText('结论：未处理。', { exact: false }).first().waitFor({ state: 'visible' })
    await sheet.getByText('本章目标已逐项检查；覆盖完整不代表全部完成。', { exact: true }).waitFor({ state: 'visible' })
    await shoot('a11-thread-tasks-review')
    return { contract, threadGoals, sheetText: (await sheet.innerText()).slice(0, 2000) }
  } },
  'a11-thread-review-candidate': { model: true, shell: 'stage', setup: seedWith([...PLANS, MAP_PLAN]), run: async ({ page, fake, shoot }) => {
    await chapterView.open(page, 5)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 90_000 })
    fake.replyReview((prompt) => {
      if (!prompt.includes('goalReviews')) return null
      const authorGoals = [...new Set(prompt.match(/ch5:(?!thread:)[a-zA-Z]+:\d+/gu) ?? [])]
      return JSON.stringify({ summary: '地图线索已交代，旧信有推进，钥匙没出现。', items: [
        { category: '连续性', severity: 'pass', description: '本章时间线与前文一致。' },
      ], goalReviews: [
        ...authorGoals.map(id => ({ id, status: 'completed', description: '林岚在塔下得到钟声提前的线索。', evidence: [{ quote: '说昨夜的钟声比往常早了一刻' }] })),
        { id: 'ch5:thread:1', status: 'unaddressed', description: '本章没有写到青铜钥匙。', evidence: [] },
        { id: 'ch5:thread:2', status: 'advanced', description: '旧信被提起，但没有读到内容。', evidence: [{ quote: '对照远处灯塔的位置' }] },
        { id: 'ch5:thread:3', status: 'resolved', description: '林岚对照父亲的地图找到了灯塔的位置。', evidence: [{ quote: '对照远处灯塔的位置' }] },
      ] })
    })
    await chapterView.review(page)
    await page.keyboard.press('Escape')
    await chapterView.finalize(page, 5)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })

    const requestsBefore = fake.requests.length
    await refs.open(page, 'plot')
    await refs.plotView(page, '伏笔线索').click()
    const candidates = page.getByRole('article', { name: '审稿发现的回收' })
    await candidates.first().waitFor({ state: 'visible', timeout: 15_000 })
    assert.equal(await candidates.count(), 1, '只有判已回收且带引文的「父亲的地图」出候选')
    const card = (await candidates.first().innerText()).split('\n').map(line => line.trim()).filter(Boolean)
    assert.deepEqual(card, ['父亲的地图', '第 5 章审稿', '对照远处灯塔的位置', '理由：林岚对照父亲的地图找到了灯塔的位置。', '确认已回收'], '候选写明线索、章号、引文和理由')
    await candidates.first().scrollIntoViewIfNeeded()
    await shoot('a11-thread-review-candidate-pending')
    const statusBefore = await page.locator('#narrative-plan-3 .stage-thread-name').innerText()
    assert.match(statusBefore, /已计划/, '确认前线索状态不变')

    await candidates.first().getByRole('button', { name: '确认已回收', exact: true }).click()
    await candidates.first().waitFor({ state: 'detached', timeout: 15_000 })
    await page.locator('#narrative-plan-3').getByText('第 5 章 · 已解决 · 对照远处灯塔的位置').waitFor({ state: 'visible' })
    const statusAfter = await page.locator('#narrative-plan-3 .stage-thread-name').innerText()
    assert.match(statusAfter, /已解决/, '确认后线索变已解决')
    const modelRequests = fake.requests.slice(requestsBefore).filter(kind => kind !== 'models')
    assert.deepEqual(modelRequests, [], '线索页显示和确认候选都不发模型请求，向量请求也算')
    await shoot('a11-thread-review-candidate-confirmed')
    return { card, statusBefore, statusAfter, modelRequests }
  } },
}
