// README 截图：中文与英文界面各走一遍书房、正文单章、蓝图写作选项、架构、角色名单、运行侧页，每一步拍一张。
// 预置用公开 IPC，模型走本机假服务；作品内容按界面语言各写一份，英文界面配英文作品。
// 重拍：node scripts/redesign/drive.mjs --scenario readme-<zh|en> | readme-hero-<zh|en> | readme-<timeline|check|annotate|trash>-<zh|en> [--theme dark] --out <目录>
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { finalizeChapter } from './f491-scenarios.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const ZH = {
  lang: 'zh',
  locale: 'zh-CN',
  ui: { shelf: '最近的作品', preview: name => `预览《${name}》`, overview: name => `《${name}》概览`, open: name => `打开《${name}》`,
    spine: '创作流程', chapters: '章节', architecture: /^架构/, blueprint: /^蓝图/, castOpen: '打开角色名单', cast: '角色名单',
    writeOptions: '本次写作选项', write: /^写第 \d+ 章$/, review: '审稿报告', plan: '章节规划',
    profileView: '档案视图', currentState: '当前状态', check: 'AI 检查', trash: count => `回收站（${count}）`,
    selection: '选中文字的操作', annotate: '添加批注', note: '批注意见', annotations: '本章批注', reviseAll: count => `统一修改（${count}）`,
    annotationReview: '批注修改对比', chapterTab: number => `第 ${number} 章` },
  model: '我的模型',
  timeline: [
    { marker: '灯室的门没有锁', evidence: '林岚把纸条夹进父亲的地图里。',
      state: { location: '灯塔顶层灯室', keyItems: '父亲的地图、钟绳上的纸条', recentEvents: '在灯室找到「别在涨潮时敲钟」的纸条' } },
    { marker: '守塔人的屋子在灯塔背风的一侧', evidence: '「你父亲也问过钟的事。」',
      state: { location: '守塔人的屋子', recentEvents: '守塔人说父亲也问过钟的事' },
      relation: { value: '开始信任', evidence: '他给林岚倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。' } },
  ],
  check: { chapter: 6, relation: '素不相识', keyEvents: '林岚回到小时候常来的灯塔，守塔人一眼认出她，说是看着她长大的。',
    issue: '第 6 章写守塔人看着林岚长大，时间线上两人素不相识。', suggestion: '改成守塔人只在父亲的信里见过她的名字。' },
  annotate: {
    notes: ['把盐写得具体一点，让人看得见', '结尾留一个动作，别直接收住'],
    revised: [
      '守塔人的屋子在灯塔背风的一侧，窗玻璃上结着一层白霜似的盐花，指甲一刮就簌簌往下掉。他给林岚倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。',
      '「你父亲也问过钟的事。」他说完这句话，就再也没有开口，只是起身往炉子里添了一块木柴。',
    ],
  },
  book: {
    name: STAGE_SAMPLE.name, genre: '悬疑', audience: '成年读者', core: STAGE_SAMPLE.core, titles: STAGE_SAMPLE.titles,
    finalized: STAGE_SAMPLE.finalized, drafts: STAGE_SAMPLE.drafts,
    plans: [
      ['到旧港落脚，找到地图上标记的灯塔。', '林岚抵达旧港；守塔人说昨夜钟声早了一刻。', '地图上灯塔的位置与实际差了半格。'],
      ['在北堤核对地图，确认偏差不是画错。', '堤脚刻痕旁的年份正是父亲离家那年。', '刻痕下还有一道更深的痕。'],
      ['弄清雾钟为什么提前响。', '钟绳上系着纸条：别在涨潮时敲钟。', '守塔人始终没问她为什么来。'],
      ['从守塔人口中套出父亲当年的事。', '守塔人承认父亲也问过钟的事，随后闭口不言。', '炉火边多了一只父亲用过的铜罗盘。'],
      ['在潮汐表里找到三十年前断线的那一页。', '整整一个潮期是空白，边上有父亲的铅笔字。', '守塔人说那一页是他撕的。'],
      ['追查第二盏灯为何从不出现在航标图上。', '林岚在礁石后发现一座废弃的灯座。', '灯座里压着一份沉船名录的残页。'],
      ['在何婆婆的鱼摊打听沉船的船员。', '何婆婆的丈夫是沉船上的水手。', '她手里留着一把灯室的钥匙。'],
      ['进港务局档案室找沉船名录。', '沈砚拦下调阅申请，档案按潮期缺了一年。', '名录最后一行写着父亲的名字。'],
      ['风暴将至，旧港封港。', '林岚决定在涨潮时登上灯室。', '雾钟在风里自己响了。'],
      ['在灯室里对上钟声与沉船的时间。', '钟摆的停角正是沉船那夜的潮位。', '有人在楼梯上点亮了第二盏灯。'],
      ['面对沈砚与守塔人各自的隐瞒。', '真相拼齐：钟声提前，是为了提醒那条船避开暗礁。', '林岚握住了钟绳。'],
      ['风暴过后，旧港重新报时。', '林岚把父亲的地图补全，交给港务局存档。', '钟声第一次准时响起。'],
    ],
    cast: [
      ['林岚', 'protagonist', '旧港潮汐记录的测绘师，带着父亲留下的残缺地图回到旧港。', '查明失踪地图的来源。',
        { gender: '女', age: '29', appearance: '短发，常年穿一件洗旧的防风外套，口袋里插着两支铅笔。', personality: '沉静，较真，遇事先量再说。',
          abilities: '测绘、读潮汐表、记住看过的每一张图。', arc: '从只想找到父亲的下落，到愿意替整座港口敲响那口钟。' }],
      ['守塔人', 'supporting', '看守灯塔三十年，记得每一次钟声。', '守住雾钟的秘密。'],
      ['沈砚', 'antagonist', '港务局档案员，掌管按潮期装订的旧档。', '让三十年前的沉船永远不被提起。'],
      ['何婆婆', 'supporting', '北堤边卖鱼的老人，丈夫死在那次沉船里。', '找回丈夫的遗物。'],
    ],
    stream: ['潮汐表挂在值班室的墙上，纸页已经泛黄。', '林岚一页一页往前翻，翻到三十年前的那一年，整整一个潮期都是空白。',
      '空白的边上有一行铅笔字，写得很轻，像是怕被人看见。', '她认出那是父亲的笔迹。', '窗外的雾钟又响了一次，比昨夜还早。',
      '守塔人站在门口，手里提着一盏没点的灯。', '「那一页是我撕的。」他说。', '林岚没有回头，她把潮汐表合上，压在掌心下面。',
      '海面上，第一盏航标灯亮了。', '她数着灯，一盏，两盏，三盏，一直数到那片她从没去过的海湾。'],
  },
  shelfBook: { name: '雾港', genre: '悬疑', audience: '成年读者', titles: ['渡口', '潮声', '无名船'],
    core: { coreOutline: '一个摆渡人在雾里接到一位不肯报上姓名的乘客。', premise: '雾港的渡船只在起雾时开。',
      worldbuilding: '雾港靠渡船与对岸相连，渡口的钟决定开船的时刻。', synopsis: '摆渡人要在雾散之前把乘客送到对岸。' },
    finalized: { 1: '雾从河面上升起来的时候，老周解开了缆绳。\n\n渡口只剩一位乘客，他把帽檐压得很低，一句话也没有说。' },
    deleted: { 2: '船过河心，雾浓得看不见船头。老周听见船底擦过一块礁石，像有人在水下轻轻敲了一下。\n\n乘客终于开口，问他对岸的钟今晚还响不响。老周没有回答，只是把桨握得更紧了。' } },
}

const EN = {
  lang: 'en',
  locale: 'en-US',
  ui: { shelf: 'Recent books', preview: name => `Preview “${name}”`, overview: name => `“${name}” overview`, open: name => `Open “${name}”`,
    spine: 'Writing flow', chapters: 'Chapters', architecture: /^Architecture/, blueprint: /^Blueprint/, castOpen: 'Open cast', cast: 'Cast',
    writeOptions: 'Options for this run', write: /^Write chapter \d+$/, review: 'Review report', plan: 'Chapter plan',
    profileView: 'Profile view', currentState: 'Current state', check: 'AI check', trash: count => `Trash (${count})`,
    selection: 'Actions for the selected text', annotate: 'Add annotation', note: 'Annotation note', annotations: 'Chapter annotations',
    reviseAll: count => `Revise all (${count})`, annotationReview: 'Annotation revision comparison', chapterTab: number => `Chapter ${number}` },
  model: 'My model',
  timeline: [
    { marker: 'The lamp room was unlocked', evidence: 'Mara slipped the note into her father\'s map.',
      state: { location: 'The lamp room at the top of the lighthouse', keyItems: 'Her father\'s map, the note from the bell rope',
        recentEvents: 'Found the note "do not ring at high tide" in the lamp room' } },
    { marker: 'The keeper\'s house sat on the lee side', evidence: '"Your father asked about the bell too," he said, and did not speak again.',
      state: { location: 'The keeper\'s house', recentEvents: 'The keeper said her father asked about the bell too' },
      relation: { value: 'Starting to trust him', evidence: 'He poured Mara a weak cup of tea and only held his own, watching the stove.' } },
  ],
  check: { chapter: 6, relation: 'Strangers', keyEvents: 'Mara returns to the lighthouse she visited as a child. The keeper recognizes her and says he watched her grow up.',
    issue: 'Chapter 6 says the keeper watched Mara grow up, but on the timeline the two are strangers.',
    suggestion: 'Have the keeper know her name only from her father\'s letters.' },
  annotate: {
    notes: ['Make the salt concrete enough to see', 'End on a small action instead of a full stop'],
    revised: [
      'The keeper\'s house sat on the lee side of the tower, its windows crusted with a white rime of salt that flaked off under a fingernail. He poured Mara a weak cup of tea and only held his own, watching the stove.',
      '"Your father asked about the bell too," he said. He did not speak again, only got up and fed another log to the stove.',
    ],
  },
  book: {
    name: 'Lighthouse', genre: 'Mystery', audience: 'Adult readers',
    core: {
      coreOutline: 'Surveyor Mara Lind follows a missing map her father left behind to a lighthouse that should have been retired. Its fog bell rings a quarter hour early every night, and she has to tie the bell to a shipwreck before the next spring tide.',
      premise: 'A decommissioned lighthouse still keeps time at night, and its fog bell runs a quarter hour early. Mara Lind arrives at the old harbor with her father\'s torn map and finds that the drift matches a wreck off the north pier thirty years ago, the same year every archive goes silent.',
      worldbuilding: 'The old harbor runs on tides and lights. Beacons, tide tables, and the fog bell are its clock. The harbor office binds its records by tide season, and anything outside a season is treated as if it never happened.',
      synopsis: 'Act one: Mara reaches the harbor, meets the keeper, and notices the bell is early. Act two: the tide tables lead her to a list of wrecks and to her father\'s name on one crew. Act three: on the night before the storm she must decide whether to ring the bell at high tide.',
    },
    titles: ['The Old Harbor', 'North Pier', 'The Fog Bell', 'The Keeper', 'Tide Tables', 'The Second Light', 'Salt Frost',
      'List of Wrecks', 'Before the Storm', 'The Lamp Room', 'Echoes', 'Homeward'],
    finalized: {
      1: 'Mara walked down the stone steps of the old harbor just after the tide went out. A thin crust of salt still clung to the stones. She spread her father\'s map across her knees and counted the squares toward the lighthouse.\n\nThe keeper waved from the foot of the tower. Last night, he said, the bell rang a quarter hour early.',
      2: 'The north pier was longer than the map said. Mara walked to its end while the wind pulled her scarf inland, as if someone behind her had tugged it.\n\nA tide line was cut into the rocks below. Beside the highest mark someone had carved a year: the year her father left home.',
    },
    drafts: {
      3: { status: 'reviewed', text: [
        'The fog climbed off the water one layer at a time. Mara pinned the tide table to the windowsill of the watch room and circled last night in pencil. The bell had rung a quarter hour early, yet the tide had not changed at all.',
        'The keeper said the bell went up thirty years ago and had failed only once. That was the night a ship went down off the north pier, and no archive has ever recorded its name.',
        'She climbed the spiral stairs. Every step had been polished by the sea wind. At the seventy-third step a fresh scratch ran along the wall, as if someone had tried a key against the bricks.',
        'The lamp room was unlocked. The pendulum hung at an unnatural angle, and a folded note was tied to the end of the bell rope. The fog had softened the paper, but the words were still clear: do not ring at high tide.',
        'Mara slipped the note into her father\'s map. Outside, the first beacon lit, then the second and the third, all the way to a bay she had never seen.',
        'The keeper coughed downstairs. It struck her that he had not once asked why she had come.',
      ].join('\n\n'),
      review: JSON.stringify({ summary: 'The clues move forward clearly. One timing detail does not line up.', items: [
        { category: 'Continuity', severity: 'warning', description: 'Chapter 1 says the bell rang a quarter hour early. Here the tide "had not changed at all". Reconcile the two.', quote: 'the tide had not changed at all' },
        { category: 'Wording', severity: 'pass', description: 'The prose reads naturally.' },
      ] }) },
      4: { status: 'draft', text: [
        'The keeper\'s house sat on the lee side of the tower, its windows crusted with years of salt. He poured Mara a weak cup of tea and only held his own, watching the stove.',
        '"Your father asked about the bell too," he said, and did not speak again.',
      ].join('\n\n') },
    },
    plans: [
      ['Settle in at the old harbor and find the lighthouse marked on the map.', 'Mara arrives. The keeper says the bell rang a quarter hour early last night.', 'The lighthouse on the map is half a square off.'],
      ['Check the map against the north pier and prove the drift is real.', 'The year carved beside the tide line is the year her father left.', 'A deeper mark sits under the carving.'],
      ['Find out why the fog bell rings early.', 'A note on the bell rope says: do not ring at high tide.', 'The keeper never asks why she came.'],
      ['Draw out what the keeper knows about her father.', 'The keeper admits her father asked about the bell too, then goes silent.', 'Her father\'s brass compass sits by the stove.'],
      ['Find the page of the tide tables where the record breaks off.', 'A whole tide season is blank, with her father\'s pencil note beside it.', 'The keeper says he tore the page out.'],
      ['Learn why the second light is missing from every chart.', 'Mara finds an abandoned lamp base behind the rocks.', 'A scrap of the wreck list is pinned under it.'],
      ['Ask Old Mrs. He at the fish stall about the crew.', 'Her husband was a sailor on the wreck.', 'She still holds a key to the lamp room.'],
      ['Search the harbor office archive for the list of wrecks.', 'Silas Shen blocks the request. One tide season is missing.', 'The last line of the list is her father\'s name.'],
      ['The storm is coming and the harbor closes.', 'Mara decides to climb to the lamp room at high tide.', 'The fog bell rings by itself in the wind.'],
      ['Match the bell to the night of the wreck.', 'The pendulum stopped at the exact tide level of that night.', 'Someone lights the second light on the stairs.'],
      ['Face what Silas and the keeper each kept hidden.', 'The truth: the early bell was a warning to steer the ship off the reef.', 'Mara takes hold of the bell rope.'],
      ['After the storm the harbor keeps time again.', 'Mara completes her father\'s map and files it with the harbor office.', 'For the first time the bell rings on time.'],
    ],
    cast: [
      ['Mara Lind', 'protagonist', 'A tide surveyor who returns to the old harbor with her father\'s torn map.', 'Find out where the missing map came from.',
        { gender: 'Female', age: '29', appearance: 'Short hair, a worn windbreaker, two pencils always in the pocket.', personality: 'Quiet and exact. Measures first, talks later.',
          abilities: 'Surveying, reading tide tables, remembering every chart she has seen.', arc: 'From looking for her father to ringing the bell for the whole harbor.' }],
      ['The Keeper', 'supporting', 'Has kept the lighthouse for thirty years and remembers every bell.', 'Keep the secret of the fog bell.'],
      ['Silas Shen', 'antagonist', 'Archivist at the harbor office, in charge of the records bound by tide season.', 'Keep the wreck from thirty years ago buried.'],
      ['Old Mrs. He', 'supporting', 'Sells fish by the north pier. Her husband died in the wreck.', 'Recover what her husband left behind.'],
    ],
    stream: ['The tide tables hung on the watch room wall, their pages gone yellow. ', 'Mara turned them back one by one until she reached the year thirty years ago, where a whole tide season was blank. ',
      'Beside the blank someone had written a line in pencil, so lightly it seemed afraid of being read. ', 'She knew the handwriting. It was her father\'s. ',
      'Outside, the fog bell rang again, earlier than the night before. ', 'The keeper stood in the doorway holding an unlit lamp. ', '"I tore that page out," he said. ',
      'Mara did not turn around. She closed the tide tables and pressed them flat under her palm. ', 'Out on the water the first beacon came on. ',
      'She counted the lights, one, two, three, all the way to the bay she had never seen. '],
  },
  shelfBook: { name: 'Fog Harbor', genre: 'Mystery', audience: 'Adult readers', titles: ['The Ferry Landing', 'Tide Voices', 'The Nameless Boat'],
    core: { coreOutline: 'A ferryman takes on a passenger in the fog who will not give his name.', premise: 'The Fog Harbor ferry only runs when the fog comes in.',
      worldbuilding: 'Fog Harbor reaches the far shore only by ferry, and the landing bell decides when it sails.', synopsis: 'The ferryman has to land his passenger before the fog lifts.' },
    finalized: { 1: 'When the fog rose off the river, old Zhou untied the mooring line.\n\nOnly one passenger was left at the landing. He wore his hat low and said nothing at all.' },
    deleted: { 2: 'Halfway across, the fog was so thick that Zhou could not see the bow. He heard the hull scrape a rock, as if someone under the water had knocked once.\n\nAt last the passenger spoke. He asked whether the bell on the far shore would ring tonight. Zhou did not answer. He only gripped the oar harder.' } },
}

/** 章节定位按存储值写（界面按语言显示），12 章一一对应。 */
const ROLES = ['建置', '铺垫', '发展', '冲突', '发展', '转折', '发展', '冲突', '高潮', '高潮', '转折', '收尾']

async function createBook(context, language, book) {
  const { app, page, roots, invoke } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: book.name, genre: book.genre, targetAudience: book.audience, writingLanguage: language }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const path = created.projectPath
  const session = { projectId: created.projectId, projectPath: path, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'db:project-core-update', { ...book.core, totalChapters: book.titles.length, wordsPerChapter: 2000 }, path, session)).success, true)
  for (const [index, title] of book.titles.entries()) {
    const [purpose, keyEvents, suspenseHook] = book.plans?.[index] ?? [title, '', '']
    const characters = book.cast ? [book.cast[0][0], ...(index === 3 || index === 4 ? [book.cast[1][0]] : [])] : []
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: index + 1, title, role: ROLES[index], purpose, keyEvents, suspenseHook, characters },
      path, session)).success, true)
  }
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
    chapters: Object.entries(book.finalized).map(([number, content]) => ({ chapterNumber: Number(number),
      title: book.titles[Number(number) - 1], content, wordCount: countUnits(content) })) }, path, session)
  assert.equal(imported.success, true, imported.error)
  return { path, session }
}

/** 先建书架上的第二本再建主作品，主作品最近打开才排在书架最前。beforeLocale 在切界面语言前执行。 */
async function seed(context, sample, { afterShelf, beforeLocale } = {}) {
  const { page, invoke, reload } = context
  const shelf = await createBook(context, sample.locale, sample.shelfBook)
  await afterShelf?.(context, shelf)
  const { path, session } = await createBook(context, sample.locale, sample.book)
  assert.equal((await invoke(page, 'llm:save-model', { ...FAKE_MODEL, name: sample.model })).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  const roster = await invoke(page, 'db:character-roster-read', path, session)
  const blank = { gender: '', age: '', appearance: '', personality: '', abilities: '', relationships: [], arc: '', notes: '' }
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: sample.book.cast.map(([name, role, background, motivation, more]) => ({ ...blank, ...more, characterId: `draft:${randomUUID()}`, name, role, background, motivation })) },
  path, session)).success, true)
  for (const [number, { status, text, review }] of Object.entries(sample.book.drafts)) {
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: Number(number), version: 1, source: 'write', content: text, wordCount: countUnits(text) }, path, session)
    assert.equal(draft.success, true, draft.error)
    if (status !== 'draft') assert.equal((await invoke(page, 'db:draft-update-status', draft.id, status, undefined, path, session)).success, true)
    if (review) {
      const expectedSource = { id: draft.id, chapterNumber: Number(number), version: 1, status, content: text }
      assert.equal((await invoke(page, 'db:review-create', { baseDraftId: draft.id, content: review, expectedSource }, path, session)).success, true)
    }
  }
  await beforeLocale?.(context, { path, session })
  assert.equal((await invoke(page, 'config:set', { locale: sample.locale })).success, true)
  await reload()
  await page.getByRole('list', { name: sample.ui.shelf }).waitFor({ state: 'visible' })
}

const settle = page => page.waitForTimeout(600)
const HERO_VIEWPORT = { width: 1440, height: 1080 }

/** 关掉内容区里除 keep 以外的标签，截图里只剩要看的那一页。 */
async function closeOtherTabs(page, keep) {
  const closers = page.getByRole('tablist').getByRole('button', { name: new RegExp(`^(关闭「|Close “)(?!${keep})`) })
  for (let open = await closers.count(); open > 0; open = await closers.count()) {
    await closers.first().click()
    await page.waitForTimeout(150)
  }
}

async function openBook(page, ui, name) {
  await page.getByRole('list', { name: ui.shelf }).getByRole('button', { name: ui.preview(name) }).click()
  await page.getByRole('region', { name: ui.overview(name) }).getByRole('button', { name: ui.open(name) }).click()
  await page.getByRole('navigation', { name: ui.spine }).waitFor({ state: 'visible' })
}

async function shootBoth(page, shoot, sample, name) {
  await settle(page)
  await shoot(`readme-${sample.lang}-${name}`)
  await page.setViewportSize(HERO_VIEWPORT)
  await settle(page)
  await shoot(`hero-${sample.lang}-${name}`)
}

function walk(sample, { prefix, viewport }) {
  const { ui, book } = sample
  return async ({ page, fake, shoot }) => {
    if (viewport) await page.setViewportSize(viewport)
    const spine = page.getByRole('navigation', { name: ui.spine })
    await page.getByRole('list', { name: ui.shelf }).getByRole('button', { name: ui.preview(book.name) }).click()
    const overview = page.getByRole('region', { name: ui.overview(book.name) })
    await overview.waitFor({ state: 'visible' })
    await settle(page)
    await shoot(`${prefix}-library`)

    await overview.getByRole('button', { name: ui.open(book.name) }).click()
    await spine.waitFor({ state: 'visible' })
    await spine.getByRole('list', { name: ui.chapters }).getByRole('button', { name: /^3\D/ }).click()
    await page.getByRole('complementary', { name: ui.review }).waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('.stage-content .cm-content').getByText(book.drafts[3].text.slice(0, 12)).first().waitFor({ state: 'visible' })
    await closeOtherTabs(page, ui.chapterTab(3))
    await settle(page)
    await shoot(`${prefix}-chapter`)

    await spine.getByRole('button', { name: ui.architecture }).click()
    await page.locator('.arch-page:not([data-loading]):not([data-cast-loading])').waitFor({ state: 'visible', timeout: 20_000 })
    await settle(page)
    await shoot(`${prefix}-architecture`)
    await page.getByRole('button', { name: ui.castOpen }).click()
    await page.getByRole('complementary', { name: ui.cast }).waitFor({ state: 'visible' })
    await settle(page)
    await shoot(`${prefix}-cast`)

    await spine.getByRole('button', { name: ui.blueprint }).click()
    await page.getByRole('button', { name: ui.write }).waitFor({ state: 'visible' })
    await page.getByRole('complementary', { name: ui.plan }).getByRole('button', { name: /^3\D/ }).click()
    await page.getByRole('button', { name: ui.writeOptions }).click()
    await page.getByRole('dialog', { name: ui.writeOptions }).waitFor({ state: 'visible' })
    await settle(page)
    await shoot(`${prefix}-blueprint`)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: ui.writeOptions }).waitFor({ state: 'hidden' })

    fake.streamProse({ chunks: book.stream, intervalMs: 400 })
    await page.getByRole('button', { name: ui.write }).click()
    await runSheet.output(page).waitFor({ state: 'visible', timeout: 60_000 })
    await page.waitForFunction(([selector, text]) => [...document.querySelectorAll(selector)].at(-1)?.textContent?.includes(text),
      [runSheet.OUTPUT_TEXT, book.stream[5].trim()], { timeout: 30_000 })
    await shoot(`${prefix}-run`)
  }
}

/** 截图后取消这次写作：夹具只回几句，写不满每章字数，等它跑完只会以失败收场。 */
const scenario = (sample, options) => ({ model: true, shell: 'stage', setup: context => seed(context, sample), run: walk(sample, options),
  after: async ({ page }) => {
    await runSheet.sheet(page).getByRole('button', { name: /^(取消「|Cancel “)/ }).first().click()
    await runSheet.anyCard(page).filter({ hasText: /^(上一次运行|Last run)/ }).waitFor({ state: 'visible', timeout: 30_000 })
  } })

const characterId = (prompt, name) => new RegExp(`"characterId": "([^"]+)",\\s*"name": "${name}"`, 'u').exec(prompt)?.[1]

/** 证据必须是该章原句。 */
function stateReply(sample) {
  const [hero, keeper] = sample.book.cast.map(([name]) => name)
  return prompt => {
    const update = sample.timeline.find(item => prompt.includes(item.marker))
    if (!update) return '{"updates":[]}'
    const heroId = characterId(prompt, hero)
    return JSON.stringify({ updates: [{ characterId: heroId, currentState: update.state, evidence: { text: update.evidence } }],
      relations: update.relation ? [{ source: heroId, target: characterId(prompt, keeper), relation: update.relation.value, evidence: { text: update.relation.evidence } }] : [] })
  }
}

/** 时间线节点来自定稿后处理，所以要在中文界面里真实定稿第 3、4 章。 */
async function finalizeThreeAndFour(context, sample) {
  const { page, fake, reload } = context
  fake.replyCharacterState(stateReply(sample))
  await reload()
  await stage.openFromLibrary(page, sample.book.name)
  for (const chapterNumber of [3, 4]) await finalizeChapter(page, chapterNumber)
  await stage.backToLibrary(page, sample.book.name)
}

const timeline = sample => ({ model: true, shell: 'stage', setup: context => seed(context, sample, { beforeLocale: context => finalizeThreeAndFour(context, sample) }),
  run: async ({ page, shoot }) => {
    const { ui, book } = sample
    await openBook(page, ui, book.name)
    await page.getByRole('navigation', { name: ui.spine }).getByRole('button', { name: ui.architecture }).click()
    await page.getByRole('button', { name: ui.castOpen }).click()
    await page.getByRole('complementary', { name: ui.cast }).getByRole('button', { name: new RegExp(`^${book.cast[0][0]}`) }).click()
    await page.getByRole('group', { name: ui.profileView }).getByRole('button', { name: ui.currentState, exact: true }).click()
    const profile = page.locator('.cast-profile')
    await profile.locator('.cast-timeline-summary').click()
    await profile.locator('.cast-timeline-chapter').nth(1).waitFor({ state: 'visible' })
    await profile.locator('.cast-timeline-row').filter({ hasText: sample.timeline[1].relation.value }).locator('.cast-timeline-quote summary').click()
    await shootBoth(page, shoot, sample, 'timeline')
  } })

async function seedConflict({ page, invoke }, sample, { path, session }) {
  const { chapter, relation, keyEvents } = sample.check
  const roster = await invoke(page, 'db:character-roster-read', path, session)
  const [hero, keeper] = sample.book.cast.map(([name]) => roster.entries.find(entry => entry.name === name))
  const committed = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: roster.entries.map(entry => entry === hero ? { ...entry, relationships: [{ targetCharacterId: keeper.characterId, target: keeper.name, relation }] } : entry) },
  path, session)
  assert.equal(committed.success, true, JSON.stringify(committed))
  const current = await invoke(page, 'db:blueprint-get', chapter, path, session)
  assert.equal((await invoke(page, 'db:blueprint-upsert', { ...current, keyEvents }, path, session)).success, true)
}

function conflictReply(sample) {
  const [hero, keeper] = sample.book.cast.map(([name]) => name)
  const { chapter, relation, issue, suggestion } = sample.check
  return prompt => {
    if (!prompt.includes('"timeline":[')) return null
    const id = new RegExp(`"id":"(e\\d+)","character":"${hero}","aspect":"relation","target":"${keeper}","value":"${relation}"`, 'u').exec(prompt)?.[1]
    assert.ok(id, '发给模型的时间线里有主角和守塔人的关系节点')
    return JSON.stringify({ findings: [{ chapterNumber: chapter, eventIds: [id], issue, suggestion }] })
  }
}

const check = sample => ({ model: true, shell: 'stage', setup: context => seed(context, sample, { beforeLocale: (context, main) => seedConflict(context, sample, main) }),
  run: async ({ page, fake, shoot }) => {
    const { ui, book } = sample
    fake.replyReview(conflictReply(sample))
    await openBook(page, ui, book.name)
    await page.getByRole('navigation', { name: ui.spine }).getByRole('button', { name: ui.blueprint }).click()
    await page.getByRole('complementary', { name: ui.plan }).getByRole('button', { name: new RegExp(`^${sample.check.chapter}\\D`) }).click()
    await page.getByRole('button', { name: ui.check, exact: true }).click()
    await page.getByText(sample.check.issue, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await shootBoth(page, shoot, sample, 'check')
  } })

const annotate = sample => ({ model: true, shell: 'stage', setup: context => seed(context, sample),
  run: async ({ page, fake, shoot }) => {
    const { ui, book } = sample
    const { notes, revised } = sample.annotate
    fake.replyReview(prompt => notes.every(note => prompt.includes(note)) ? revised.join('\n\n') : null)
    await openBook(page, ui, book.name)
    await page.getByRole('navigation', { name: ui.spine }).getByRole('list', { name: ui.chapters }).getByRole('button', { name: /^4\D/ }).click()
    const prose = page.locator('.stage-content .cm-content')
    const paragraphs = book.drafts[4].text.split('\n\n')
    await prose.getByText(paragraphs[0].slice(0, 12)).first().waitFor({ state: 'visible' })
    await closeOtherTabs(page, ui.chapterTab(4))
    for (const [index, paragraph] of paragraphs.entries()) {
      await prose.getByText(paragraph).first().click({ clickCount: 3 })
      const toolbar = page.getByRole('toolbar', { name: ui.selection })
      await toolbar.getByRole('button', { name: ui.annotate }).click()
      await toolbar.getByRole('textbox', { name: ui.note }).fill(notes[index])
      await toolbar.getByRole('button', { name: ui.annotate }).click()
      await toolbar.waitFor({ state: 'hidden' })
    }
    await page.getByRole('region', { name: ui.annotations }).getByRole('button', { name: ui.reviseAll(notes.length) }).click()
    await page.getByRole('region', { name: ui.annotationReview }).waitFor({ state: 'visible', timeout: 60_000 })
    await shootBoth(page, shoot, sample, 'annotate')
  } })

/** 导入的定稿没走过知识库，删除时要作者确认知识库里没有这一章，所以先导入再删除。 */
async function deleteShelfChapter({ page, invoke }, sample, { path, session }) {
  const [[number, content]] = Object.entries(sample.shelfBook.deleted)
  const chapterNumber = Number(number)
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
    chapters: [{ chapterNumber, title: sample.shelfBook.titles[chapterNumber - 1], content, wordCount: countUnits(content) }] }, path, session)
  assert.equal(imported.success, true, imported.error)
  const draft = (await invoke(page, 'db:draft-list', chapterNumber, path, session)).find(item => item.status === 'finalized')
  const asked = await invoke(page, 'chapter:delete-finalized', { draftId: draft.id, chapterNumber }, path, session)
  assert.equal(asked.error, 'CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED', JSON.stringify(asked))
  const deleted = await invoke(page, 'chapter:confirm-legacy-knowledge-absent', asked.operation.operationId, path, session)
  assert.equal(deleted.success, true, JSON.stringify(deleted))
}

const trash = sample => ({ model: true, shell: 'stage', setup: context => seed(context, sample, { afterShelf: (context, shelf) => deleteShelfChapter(context, sample, shelf) }),
  run: async ({ page, shoot }) => {
    const { ui } = sample
    await openBook(page, ui, sample.shelfBook.name)
    await page.getByRole('navigation', { name: ui.spine }).getByRole('button', { name: ui.trash(1) }).click()
    await page.getByRole('dialog', { name: ui.trash(1) }).waitFor({ state: 'visible' })
    await shootBoth(page, shoot, sample, 'trash')
  } })

export const README_SCENARIOS = Object.fromEntries([ZH, EN].flatMap(sample => [
  [`readme-${sample.lang}`, scenario(sample, { prefix: `readme-${sample.lang}` })],
  // README 顶部主图（docs/readme-visuals）要 4:3 的完整窗口截图。
  [`readme-hero-${sample.lang}`, scenario(sample, { prefix: `hero-${sample.lang}`, viewport: HERO_VIEWPORT })],
  [`readme-timeline-${sample.lang}`, timeline(sample)],
  [`readme-check-${sample.lang}`, check(sample)],
  [`readme-annotate-${sample.lang}`, annotate(sample)],
  [`readme-trash-${sample.lang}`, trash(sample)],
]))
