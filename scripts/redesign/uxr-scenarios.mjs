import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const LONG_OUTLINE = [
  '民国二十六年秋，测绘师林岚带着父亲留下的半张海图回到旧港。港务局说北堤外的那座灯塔十年前就停用了，可雾钟仍然每晚报时，而且一天比一天早一刻。',
  '她受雇为新航道重测潮位，白天量水，夜里对钟。潮汐表上的每一格都对得上，只有钟声对不上。守塔人什么都不解释，只劝她别在涨潮时上塔。',
  '林岚顺着父亲在海图背面留下的铅笔记号，找到三十年前的一份沉船名录。那条船没有船名，船上的测绘员一栏写着父亲的名字，而档案里那一年的潮期整册不见了。',
  '风暴前夜，港务局要拆掉雾钟。林岚必须在大潮到来之前弄清钟声到底在为谁报时，并决定是否敲响它：敲了，新航道作废，旧港保不住生计；不敲，三十年前的事会在同一片礁石上再来一遍。',
].join('\n\n')

const LONG_CONFIG = {
  coreOutline: LONG_OUTLINE,
  subGenre: '近代海港悬疑',
  protagonistProfile: '林岚，二十九岁，海道测量局的外勤测绘师。做事先量后信，口袋里永远有一支削好的铅笔和一卷皮尺。父亲在她十二岁那年出海未归，只留下半张海图，她因此入了这一行。\n\n她不信鬼神，也不信档案：前者量不出来，后者被人改过。核心目标是弄清父亲那次出海测的到底是什么。弱点是把一切都当成可以量的东西，包括人。',
  worldSetting: '旧港是一座靠潮汐、灯塔和雾钟维持秩序的小城。港务局的档案按潮期装订，不在潮期里的事等于没有发生。北堤外有一片暗礁，退大潮时才露出水面，当地人叫它「晒网石」。\n\n灯塔归港务局管，雾钟却是三十年前由船户们凑钱装的，两边的钥匙不在同一个人手里。新航道一旦开通，旧港的引水生意就没了。\n\n【第3章必现】灯塔楼梯第七十三级拐角的刮痕。\n【第8章必现】沉船名录上被裁掉的那一页。',
  goldenFinger: '林岚能从潮位刻痕和水色里读出年份与潮期，误差不超过一个朔望月。这不是异能，是父亲教的一套土办法，全书只有她和守塔人会。',
  writingStyle: '短句为主，少用形容词。多写手上的动作和量出来的数字，少写心理。叙述距离贴着林岚，不进入别人的内心。每章至少出现一次潮水或灯光。',
  globalGuidance: '',
  referenceWorks: '',
}

const seedFilled = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
  const core = await invoke(page, 'db:project-core-update', LONG_CONFIG, path, session)
  assert.equal(core.success, true, core.error)
} })

const AUTHOR_STYLE = '少用形容词，多写手上的动作。'

const seedNew = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
  const core = await invoke(page, 'db:project-core-update', { coreOutline: '', genre: '', targetAudience: '', subGenre: '', worldSetting: '', goldenFinger: '',
    protagonistProfile: '', writingStyle: AUTHOR_STYLE, globalGuidance: '', referenceWorks: '' }, path, session)
  assert.equal(core.success, true, core.error)
} })

const innerScrolls = (page, selector) => page.locator(selector).evaluateAll(nodes => nodes
  .filter(node => node.scrollHeight > node.clientHeight + 1)
  .map(node => `${node.getAttribute('aria-label') ?? node.id}: ${node.scrollHeight}>${node.clientHeight}`))

async function setupFacts(page) {
  return page.evaluate(() => {
    const top = selector => Math.round(document.querySelector(selector)?.getBoundingClientRect().top ?? -1)
    const marks = kind => document.querySelectorAll(`.stage-setup-sheet [data-mark="${kind}"]`).length
    return {
      sheetCount: document.querySelector('.stage-setup-sheet-count')?.textContent,
      marks: { empty: marks('empty'), filled: marks('ai-filled'), expanded: marks('ai-expanded') },
      outlineUnits: document.querySelector('.stage-setup-outline-foot .pi-num-ui')?.textContent,
      hint: document.querySelector('.stage-setup-hint')?.textContent,
      spineLeft: document.querySelector('[aria-label="创作流程"]')?.textContent?.match(/还差 \d+ 项/)?.[0] ?? null,
      basicsTop: top('.stage-setup-basics'), sheetTop: top('.stage-setup-sheet'), outlineTop: top('.stage-setup-outline'), footTop: top('.stage-setup-foot'),
    }
  })
}

const LONG_CHAPTER = 5
const LONG_BLUEPRINT = {
  characters: ['林岚', '守塔人', '何婆婆', '港务局书记'],
  purpose: '林岚要在港务局收走旧潮汐表之前，把三十年前那一册抄下来。她以为只要抄到数字就够了，这一章结束时她会发现缺的不是数字，是整整一个潮期。',
  keyEvents: '上午，林岚借口核对航标，进了港务局的档案间。书记只肯让她看近十年的册子，她用重测北堤的公文换到了半个时辰。\n\n她抄到第三页时发现装订线是新的：有一整册被拆出去，又按原样缝了回来，页码连得上，潮期连不上。\n\n转折：何婆婆在门口等她，说那一册不在港务局，在灯塔。当年是船户们自己把它收走的，为的是不让人知道那天夜里钟敲过。\n\n林岚回到灯塔，守塔人第一次没有拦她上楼，只说了一句「你父亲也是这个时辰来的」。',
  suspenseHook: '林岚在灯室的地板缝里摸到那一册潮汐表，翻开第一页，上面的字迹是她父亲的。最后一行没有写完，停在「涨潮，钟」三个字上。楼下，雾钟自己响了，比昨天又早了一刻。',
  userGuidance: '这一章只写雾，不写人脸：所有人物都只写手、背影和声音。\n何婆婆的话要短，一句不超过十个字。\n不要让林岚说出「父亲」两个字，用「他」。',
  notes: [
    '# 第5章 要点',
    '',
    '## 剧情节点',
    '- [触发] 林岚以重测北堤的公文为由进入港务局档案间，只获准查看半个时辰。',
    '- [转折] 她发现三十年前那一册潮汐表被整册拆走后重新装订，页码连续而潮期缺了一个。',
    '- [转折] 何婆婆告诉她那一册在灯塔，是船户们当年自己收走的。',
    '- [结果] 林岚在灯室地板缝里找到那一册，认出第一页是父亲的字迹。',
    '',
    '## 角色动态',
    '- **林岚**：从「只要数字」转为怀疑档案本身被人动过；本章没有说出「父亲」。',
    '- **守塔人**：第一次不阻拦林岚上塔，并提到她父亲来过。',
    '',
    '## 伏笔与钩子',
    '- 潮汐表最后一行停在「涨潮，钟」，没有写完。',
    '- 雾钟无人敲击自己响了，比前一天又早一刻。',
  ].join('\n'),
}

const MANY = 112

const seedLongBlueprints = context => seedStageSample(context, { landOnChapter3: false, totalChapters: MANY, blueprintCount: MANY, beforeReload: async ({ page, invoke, path, session }) => {
  const more = Array.from({ length: MANY - STAGE_SAMPLE.titles.length }, (_, index) => {
    const chapterNumber = STAGE_SAMPLE.titles.length + index + 1
    return { chapterNumber, title: `远航之${chapterNumber}`, role: '发展', purpose: LONG_BLUEPRINT.purpose, keyEvents: LONG_BLUEPRINT.keyEvents,
      characters: ['林岚'], suspenseHook: LONG_BLUEPRINT.suspenseHook, userGuidance: '', notes: LONG_BLUEPRINT.notes.replace('第5章', `第${chapterNumber}章`) }
  })
  assert.equal((await invoke(page, 'db:blueprint-upsert-many', more, path, session)).success, true)
  const current = await invoke(page, 'db:blueprint-get', LONG_CHAPTER, path, session)
  assert.equal((await invoke(page, 'db:blueprint-upsert', { ...current, ...LONG_BLUEPRINT }, path, session)).success, true)
} })

const card = (page, number) => page.getByRole('region', { name: `第 ${number} 章蓝图` })

async function blueprintFacts(page, number) {
  return page.evaluate(chapter => {
    const scroller = document.querySelector('.stage-bp-card')
    return {
      planTop: document.querySelector('.stage-bp-plan-top')?.textContent,
      planRows: document.querySelectorAll('.stage-bp-plan-item').length,
      currentRow: document.querySelector('.stage-bp-plan-item[aria-current] .stage-bp-plan-no')?.textContent,
      cardNumber: document.querySelector('.stage-bp-title-no')?.textContent,
      expected: chapter,
      cardScrollTop: Math.round(scroller.scrollTop),
      notesRendered: Boolean(document.querySelector('.stage-bp-notes-read')),
    }
  }, number)
}

/** commitMs：点击后排的微任务里这一章已提交，不受帧率取整；layoutMs：再读 scrollHeight 强制排版；twoFramesMs：点击到两帧之后，含绘制。 */
async function measureSwitching(page) {
  return page.evaluate(async () => {
    const items = [...document.querySelectorAll('.stage-bp-plan-item')]
    const longTasks = []
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(entry.duration) })
    observer.observe({ type: 'longtask' })
    const commit = [], layout = [], frames = [], committed = [], landed = []
    for (let round = 0; round < 20; round++) {
      const target = items[(round * 37 + 11) % items.length]
      const expected = target.querySelector('.stage-bp-plan-no')?.textContent
      const started = performance.now()
      target.click()
      await new Promise(resolve => queueMicrotask(resolve))
      commit.push(performance.now() - started)
      committed.push(document.querySelector('.stage-bp-title-no')?.textContent === expected)
      void document.querySelector('.stage-bp-card').scrollHeight
      layout.push(performance.now() - started)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      frames.push(performance.now() - started)
      landed.push(document.querySelector('.stage-bp-title-no')?.textContent === expected)
    }
    observer.disconnect()
    const stats = values => {
      const sorted = [...values].sort((a, b) => a - b)
      return { median: +sorted[Math.floor(sorted.length / 2)].toFixed(1), max: +sorted.at(-1).toFixed(1), min: +sorted[0].toFixed(1) }
    }
    return { commitMs: stats(commit), layoutMs: stats(layout), twoFramesMs: stats(frames), longTasks: longTasks.length,
      committedInWindow: committed.filter(Boolean).length, switchedToExpected: landed.filter(Boolean).length }
  })
}

export const UXR_SCENARIOS = {
  'uxr-bp-switch-bench': { model: false, shell: 'stage', setup: seedLongBlueprints, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, LONG_CHAPTER).click()
    await card(page, LONG_CHAPTER).waitFor({ state: 'visible' })
    const warmup = await measureSwitching(page)
    const runs = []
    for (let index = 0; index < 5; index++) runs.push(await measureSwitching(page))
    for (const run of [warmup, ...runs]) assert.equal(run.switchedToExpected, 20, '每次点击都换到了点的那一章')
    return { warmup, runs }
  } },
  'uxr-setup-filled': { model: false, shell: 'stage', setup: seedFilled, run: async ({ page, shoot }) => {
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    const top = await setupFacts(page)
    const scrolls = await innerScrolls(page, '.stage-setup textarea')
    assert.deepEqual(scrolls, [], '设定页没有一个输入框要在框里滚动')
    await shoot('uxr-setup-filled-top')
    await page.locator('.stage-setup-scroll').evaluate(node => { node.scrollTop = node.scrollHeight })
    await shoot('uxr-setup-filled-bottom')
    return { top, scrolls, expectedOutlineUnits: countUnits(LONG_OUTLINE) }
  } },
  'uxr-setup-new': { model: true, shell: 'stage', setup: seedNew, run: async context => {
    const { page, shoot } = context
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    const empty = await setupFacts(page)
    await shoot('uxr-setup-new-empty')
    await stage.setupField(page, '类型').selectOption('悬疑')
    await stage.setupField(page, '目标读者').selectOption({ index: 1 })
    await stage.setupOutline(page).fill(STAGE_SAMPLE.core.coreOutline)
    await stage.setupFill(page).click()
    const confirm = page.getByRole('dialog', { name: '扩写已有的设定？' })
    await confirm.getByRole('button', { name: '继续扩写', exact: true }).click()
    await page.locator('.stage-setup-sheet [data-mark="ai-filled"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByRole('button', { name: /^AI 补全其余设定$/ }).waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('.stage-setup-scroll').evaluate(node => { node.scrollTop = 0 })
    const afterFill = await setupFacts(page)
    assert.equal(afterFill.sheetCount, '6 项 · 1 项未填 · 4 项 AI 填写 · 1 项 AI 扩写', '表头计数')
    assert.deepEqual(afterFill.marks, { empty: 1, filled: 4, expanded: 1 }, '行内标记与表头计数一致')
    await shoot('uxr-setup-new-filled')
    const scrolls = await innerScrolls(page, '.stage-setup textarea')
    const unsavedAfterFill = await stage.setupFoot(page).getByRole('button', { name: /^保存/ }).isVisible()
    assert.equal(unsavedAfterFill, false, 'AI 补全已写进库，设定页不算未保存')
    await stage.saveStatus(page).filter({ hasText: '已保存' }).waitFor({ state: 'visible' })
    await context.restart()
    await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
    await stage.stageButton(context.page, '设定').click()
    await stage.setupOutline(context.page).waitFor({ state: 'visible' })
    const reopened = await setupFacts(context.page)
    assert.deepEqual([reopened.sheetCount, reopened.marks], [afterFill.sheetCount, afterFill.marks], '冷重启再打开，标记与计数不变')
    await context.shoot('uxr-setup-new-reopened')
    return { empty, afterFill, unsavedAfterFill, reopened, scrolls }
  } },
  'uxr-bp-long': { model: false, shell: 'stage', setup: seedLongBlueprints, run: async ({ page, shoot }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, LONG_CHAPTER).click()
    await card(page, LONG_CHAPTER).waitFor({ state: 'visible' })
    const top = await blueprintFacts(page, LONG_CHAPTER)
    const scrolls = await innerScrolls(page, '.stage-bp-card textarea')
    assert.deepEqual(scrolls, [], '蓝图卡片没有一个输入框要在框里滚动')
    await shoot('uxr-bp-long-top')
    const scroller = page.locator('.stage-bp-card')
    await blueprint.planItem(page, 60).click()
    await card(page, 60).waitFor({ state: 'visible' })
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight })
    const scrolledBeforeSwitch = await scroller.evaluate(node => Math.round(node.scrollTop))
    await card(page, 60).getByRole('button', { name: '编辑章节要点' }).click()
    const editingBeforeSwitch = (await page.locator('.stage-bp-notes-read').count()) === 0
    await blueprint.planItem(page, 61).click()
    await card(page, 61).waitFor({ state: 'visible' })
    const reset = { scrolledBeforeSwitch, scrollTopAfterSwitch: await scroller.evaluate(node => Math.round(node.scrollTop)),
      editingBeforeSwitch, notesRenderedAfterSwitch: (await page.locator('.stage-bp-notes-read').count()) === 1 }
    assert.ok(scrolledBeforeSwitch > 0 && reset.scrollTopAfterSwitch === 0, '换章后卡片回到顶上')
    assert.ok(editingBeforeSwitch && reset.notesRenderedAfterSwitch, '换章后要点编辑态收起')
    await blueprint.planItem(page, LONG_CHAPTER).click()
    await card(page, LONG_CHAPTER).waitFor({ state: 'visible' })
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight })
    await shoot('uxr-bp-long-bottom')
    await card(page, LONG_CHAPTER).getByRole('button', { name: '编辑章节要点' }).click()
    await page.mouse.move(460, 130)
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight })
    await shoot('uxr-bp-long-notes-edit')
    return { top, reset, bottom: await blueprintFacts(page, LONG_CHAPTER), scrolls, editScrolls: await innerScrolls(page, '.stage-bp-card textarea') }
  } },
  'uxr-bp-new': { model: false, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false }), run: async ({ page, shoot }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, 6).click()
    await card(page, 6).waitFor({ state: 'visible' })
    await shoot('uxr-bp-new')
    return { facts: await blueprintFacts(page, 6), scrolls: await innerScrolls(page, '.stage-bp-card textarea') }
  } },
}
