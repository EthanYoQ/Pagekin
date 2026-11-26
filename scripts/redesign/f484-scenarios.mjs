import assert from 'node:assert/strict'

import * as architecture from './pages/architecture.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { characterStateReply as roundtripReply, exportAndRestore, finalizeChapter, openChapter, openCharacterState, openInUi, postDetail, stateFields } from './f491-scenarios.mjs'

const EVIDENCE = '林岚把纸条夹进父亲的地图里。'

function characterStateReply(prompt) {
  const id = /"characterId": "([^"]+)",\s*"name": "林岚"/u.exec(prompt)?.[1]
  if (!id || !prompt.includes(EVIDENCE)) return '{"updates":[]}'
  return JSON.stringify({ updates: [{ characterId: id, currentState: { location: '灯塔顶层灯室', recentEvents: '在灯室找到纸条' }, evidence: { text: EVIDENCE } }] })
}

export async function editLocationOnCastPage(page, value) {
  await architecture.open(page)
  await architecture.openCast(page)
  await architecture.castRow(page, '林岚').click()
  await stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name: '当前状态', exact: true }).click()
  await stage.root(page).getByRole('textbox', { name: /^当前位置/u }).fill(value)
  await stage.root(page).getByRole('button', { name: '保存角色' }).click()
  await stage.root(page).locator('.cast-save-state').getByText('已保存', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
}

const COMMIT = 'finalization-generation:commit'

async function holdCommit(app, nth) {
  assert.ok(await app.evaluate(({ ipcMain }, [channel, target]) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get(channel)
    if (!original) return false
    const gate = Promise.withResolvers()
    globalThis.__f484Commit = { calls: 0, held: false, release: gate.resolve }
    handlers.set(channel, async (...args) => {
      const state = globalThis.__f484Commit
      if (++state.calls === target) { state.held = true; await gate.promise }
      return original(...args)
    })
    return true
  }, [COMMIT, nth]), '能在主进程里卡住定稿后处理的提交')
}

async function waitHeld(app) {
  const held = async () => {
    const handle = await app.evaluateHandle(() => globalThis.__f484Commit.held)
    try { return await handle.jsonValue() } finally { await handle.dispose() }
  }
  for (const deadline = Date.now() + 60_000; !await held(); await new Promise(resolve => setTimeout(resolve, 100))) {
    assert.ok(Date.now() < deadline, '60 秒内角色状态的提交没有卡在门上')
  }
}

const releaseCommit = app => app.evaluate(() => globalThis.__f484Commit.release())

const postButtons = (page, region) => page.getByRole('region', { name: region })
  .getByRole('button', { name: /^(重试|重试失败步骤|Retry|Retry failed steps)$/u }).count()

const failedDetail = (page, region) => page.getByRole('region', { name: region }).locator('li[data-state="failed"]')
  .filter({ has: page.locator('b', { hasText: /^角色状态更新$/u }) }).locator('.stage-ch-post-detail')

export const F484_SCENARIOS = {
  'f484-field-conflict': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page, fake } = context
    fake.replyCharacterState(characterStateReply)
    await holdCommit(app, 2)
    try {
      if (!await stage.chapterButton(page, 3).isVisible()) await stage.stageButton(page, '正文').click()
      await chapterView.open(page, 3)
      await chapterView.finalize(page, 3)
      await waitHeld(app)
      assert.ok(fake.requests.includes('character-state'), '卡住的是角色状态生成之后的提交')
      await editLocationOnCastPage(page, '作者改的位置：码头')
    } finally {
      await releaseCommit(app)
    }

    await stage.stageButton(page, '正文').click()
    await chapterView.open(page, 3)
    await failedDetail(page, '定稿后处理').waitFor({ state: 'visible', timeout: 60_000 })
    const zh = await failedDetail(page, '定稿后处理').innerText()
    await context.shoot('f484-field-conflict-zh')
    const zhButtons = await postButtons(page, '定稿后处理')

    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
    await failedDetail(page, 'Post-finalization steps').waitFor({ state: 'visible', timeout: 30_000 })
    const en = await failedDetail(page, 'Post-finalization steps').innerText()
    await context.shoot('f484-field-conflict-en')
    const enButtons = await postButtons(page, 'Post-finalization steps')

    assert.match(zh, /^正文定稿已保存，但角色卡没有自动更新：生成期间/u, '中文说明字段在生成期间被改动')
    assert.match(en, /^The finalized chapter text is saved, but the character card was not updated: this character's current state changed while this step was running/u, '英文说明')
    for (const text of [zh, en]) assert.doesNotMatch(text, /Error invoking|FINALIZED_CHARACTER/u, '不显示原始错误码')
    assert.doesNotMatch(en, /\p{Script=Han}/u, '英文说明不带汉字')
    assert.deepEqual({ zhButtons, enButtons }, { zhButtons: 0, enButtons: 0 }, '两种语言下都不摆「重试」和「重试失败步骤」')
    await page.waitForFunction(() => document.querySelectorAll('.stage-capsule').length === 0, null, { timeout: 90_000 })
    return { zh, en, requests: fake.requests }
  } },
  'f484-deleted-source-roundtrip': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    context.fake.replyCharacterState(roundtripReply)
    const measured = {}
    await finalizeChapter(context.page, 3)
    const chapter3Steps = await chapterView.postProcessSteps(context.page)
    assert.equal(chapter3Steps.find(step => step.label === '角色状态更新')?.state, 'success', JSON.stringify(chapter3Steps))
    await context.reload()
    await openInUi(context, context.samplePath)
    await openCharacterState(context.page)
    const chapter3Location = (await stateFields(context.page)).find(field => field.label?.startsWith('当前位置'))
    assert.deepEqual({ hint: chapter3Location?.hint, value: chapter3Location?.value }, { hint: '定稿派生', value: '灯塔顶层灯室' }, '删章前地点由第 3 章定稿写入')
    await openChapter(context.page, 3)
    await chapterView.more(context.page, '删除正文…')
    await context.page.getByRole('button', { name: '删除', exact: true }).click()
    await chapterView.view(context.page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'detached', timeout: 60_000 })

    const first = await exportAndRestore(context, context.samplePath, 'deleted-1')
    const second = await exportAndRestore(context, first, 'deleted-2')
    await context.reload()
    await openInUi(context, second)
    await finalizeChapter(context.page, 4)
    measured.steps = await chapterView.postProcessSteps(context.page)
    measured.detail = await postDetail(context.page).count() ? await postDetail(context.page).innerText() : null
    await context.shoot('f484-deleted-source-finalize')

    await context.reload()
    await openInUi(context, second)
    await openCharacterState(context.page)
    measured.fields = await stateFields(context.page)
    await context.shoot('f484-deleted-source-character-state')

    const location = measured.fields.find(field => field.label?.startsWith('当前位置'))
    assert.equal(measured.detail, null, JSON.stringify(measured))
    assert.equal(measured.steps.length, 4, JSON.stringify(measured))
    assert.ok(measured.steps.every(step => step.state === 'success'), JSON.stringify(measured))
    assert.deepEqual({ hint: location?.hint, value: location?.value }, { hint: '定稿派生', value: '守塔人的屋子' }, '第 4 章按原项目一样更新了地点')
    return measured
  } },
}
