// 审修证明 v2 与库版本 12 的实机验证。
//   bs702-cycle12       假模型按审稿、修稿、合并复核、定稿写 12 章，证明全是 v2；导出再恢复两轮都通过，副本里证明仍是 v2。
//   bs702-upgrade-open  PERF702_FIXTURE（库版本 10 的 112 章书）从书房打开，量升级耗时与主进程无响应时长，升级中截图；再写第 113 章并开一次审稿。
//   real-bs702-112      同一夹具接真实模型，写第 113 章、审稿、修稿、合并。
//   bs702-seal          PERF702_FIXTURE（库版本 10、审修证明是 v1 的书）打开升级（同时整理源库，老证明封存）后，再按审修循环写 2 章（v2）；
//                       导出再恢复两轮，老证明仍是封存形、新证明仍是 v2，恢复走从严校验；恢复出的书里重新打开第 3 章再 AI 审稿。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { reviewProof } from '../review-proof-read.mjs'
import { exportAndRestore, openInUi } from './f491-scenarios.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { BOOK, buildByReviewCycle, chapterMarker, installLedger, installReplies, installReviewCycleReplies, reuseBuilt, reviewCycleChapter, RUNNING } from './perf702-scenarios.mjs'
import { reviewReviseMerge, writeChapter } from './real-scenarios.mjs'

const fixtureBook = () => path.join(process.env.PERF702_FIXTURE ?? assert.fail('PERF702_FIXTURE 未设置'), 'projects', BOOK)

/** 库版本和每条审修证明的版本与字节数（只读）。 */
function proofs(projectPath) {
  const db = new DatabaseSync(path.join(projectPath, '.ai-novel', 'project.db'), { readOnly: true })
  try {
    const userVersion = db.prepare('PRAGMA user_version').get().user_version
    const runs = db.prepare('SELECT binding_json FROM generation_runs ORDER BY rowid').all()
      .map(row => reviewProof(JSON.parse(row.binding_json).sourceManifest)).filter(proof => proof.kind !== 'absent')
      .map(proof => {
        assert.ok(['recomputable', 'sealed'].includes(proof.kind), proof.kind)
        return { version: proof.kind === 'sealed' ? 'sealed' : proof.context.version, bytes: Buffer.byteLength(proof.contextJson) }
      })
    const kinds = {}
    for (const run of runs) kinds[run.version] = (kinds[run.version] ?? 0) + 1
    return { userVersion, versions: [...new Set(runs.map(run => run.version))], kinds, count: runs.length, last: runs.at(-1)?.version, maxBytes: Math.max(0, ...runs.map(run => run.bytes)) }
  } finally { db.close() }
}

/** 把夹具复制进隔离目录并打开一次（这一次已升级），再把库换回夹具原样，下次从书房打开时作者付的就是真实的那次升级。 */
async function copyFixtureThenRevert(context, { real = false } = {}) {
  const { app, page, roots, invoke } = context
  const target = path.join(roots.projects, BOOK)
  fs.cpSync(fixtureBook(), target, { recursive: true })
  if (real) await context.installRealModels()
  else {
    assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  }
  const grant = await chooseProjectDirectoryGrant(app, page, target, 'project-open')
  const opened = await invoke(page, 'project:open', { grantId: grant.grantId }, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  await context.restart({ beforeLaunch: () => {
    fs.rmSync(path.join(target, '.ai-novel'), { recursive: true, force: true })
    fs.cpSync(path.join(fixtureBook(), '.ai-novel'), path.join(target, '.ai-novel'), { recursive: true })
  } })
  return target
}

/** 渲染端每 100 ms 发一次轻量 IPC，记最长往返：主进程同步升级时它会被挡住。 */
const startProbe = page => page.evaluate(() => {
  const probe = { maxMs: 0, probes: 0, stop: false }
  probe.done = (async () => {
    while (!probe.stop) {
      const startedAt = performance.now()
      await window.aiNovelAPI.invoke('config:get')
      probe.maxMs = Math.max(probe.maxMs, Math.round(performance.now() - startedAt))
      probe.probes++
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  })()
  window.__bs702Probe = probe
})

/** 等在途的那次往返回来再报数，否则恰好卡在末尾的那次会漏记。 */
const stopProbe = page => page.evaluate(async () => {
  const probe = window.__bs702Probe
  probe.stop = true
  await probe.done
  return { maxMs: probe.maxMs, probes: probe.probes }
})

/**
 * 从书房点封面预览、再点打开，各记耗时与这一段里探针的最长往返（主进程被挡多久）。预览要等概览读完，不只是卡片出现。
 * `shots` 为真时在打开途中截一张，主进程被挡住时截图同样会被挡。
 */
async function upgradeFromLibrary(context, label, { shots = true } = {}) {
  const { page, shoot } = context
  const target = path.join(context.roots.projects, BOOK)
  const before = proofs(target).userVersion
  if (shots) await shoot(`${label}-library`)
  const timed = async action => { const startedAt = performance.now(); await action(); return Math.round(performance.now() - startedAt) }
  await startProbe(page)
  const previewMs = await timed(async () => {
    await stage.cover(page, BOOK).click({ timeout: 300_000 })
    await stage.overview(page, BOOK).and(page.locator('[aria-busy="false"]')).waitFor({ state: 'visible', timeout: 300_000 })
  })
  const preview = await stopProbe(page)
  if (shots) await shoot(`${label}-preview`)
  await startProbe(page)
  const openMs = await timed(async () => {
    await stage.overview(page, BOOK).getByRole('button', { name: `打开《${BOOK}》` }).click({ timeout: 300_000 })
    if (shots) {
      await page.getByText('正在打开作品').waitFor({ state: 'visible', timeout: 10_000 })
      await shoot(`${label}-opening`)
    }
    await stage.spine(page).waitFor({ state: 'visible', timeout: 300_000 })
  })
  const open = await stopProbe(page)
  if (shots) await shoot(`${label}-opened`)
  return { before, after: proofs(target).userVersion, previewMs, previewBlockedMaxMs: preview.maxMs, openMs, openBlockedMaxMs: open.maxMs, probes: preview.probes + open.probes }
}

/** 预览、打开各自让主进程停顿不超过这么久，作者不会觉得窗口卡住。 */
const MAIN_BLOCKED_BUDGET_MS = 500
const assertResponsive = measured => {
  const over = Object.entries(measured).filter(([key, value]) => key.endsWith('BlockedMaxMs') && value > MAIN_BLOCKED_BUDGET_MS)
  assert.deepEqual(over, [], `主进程停顿超过 ${MAIN_BLOCKED_BUDGET_MS} ms：${JSON.stringify(measured)}`)
}

export const BS702_SCENARIOS = {
  'bs702-cycle12': { model: true, shell: 'stage', setup: async context => {
    context.chapters = await buildByReviewCycle(context, 12, { saveCheckpoints: false })
  }, run: async context => {
    const source = path.join(context.roots.projects, BOOK)
    const written = proofs(source)
    assert.deepEqual([written.userVersion, written.versions], [12, [2]], JSON.stringify(written))
    assert.equal(written.count, 36, '12 章各有审稿、修稿、复核三次带证明的运行')
    const first = await exportAndRestore(context, source, 'bs702-round-1')
    const second = await exportAndRestore(context, first, 'bs702-round-2')
    const restored = [proofs(first), proofs(second)]
    for (const copy of restored) assert.deepEqual([copy.userVersion, copy.versions, copy.count], [12, [2], 36], JSON.stringify(copy))
    await openInUi(context, second)
    await chapterView.open(context.page, 12)
    await context.shoot('bs702-cycle12-restored')
    return { chapters: context.chapters.length, written, restored }
  } },
  'bs702-upgrade-open': { model: true, shell: 'stage', setup: async context => {
    installReplies(context.fake)
    await copyFixtureThenRevert(context)
  }, run: async context => {
    installReplies(context.fake)
    const upgrade = await upgradeFromLibrary(context, 'bs702-upgrade')
    assert.deepEqual([upgrade.before, upgrade.after], [10, 12])
    assertResponsive(upgrade)
    const { page } = context, next = Number(process.env.PERF702_FINALIZED ?? 112) + 1
    await chapterView.open(page, next)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await chapterView.prose(page).filter({ hasText: chapterMarker(next) }).waitFor({ state: 'visible', timeout: 120_000 })
    await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
    const reviewStartedAt = performance.now()
    await chapterView.review(page)
    const failed = page.getByText('工作流未完成')
    await chapterView.reviewSheet(page).or(failed).first().waitFor({ state: 'visible', timeout: 120_000 })
    assert.equal(await failed.count(), 0, `第 ${next} 章的 AI 审稿没有完成`)
    await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
    const reviewMs = Math.round(performance.now() - reviewStartedAt)
    await context.shoot('bs702-upgrade-review')
    const after = proofs(path.join(context.roots.projects, BOOK))
    assert.equal(after.last, 2, '新开的审稿写的是 v2 证明')
    return { upgrade, reviewMs, proofs: after }
  } },
  // 只量数：库版本 10 的书从书房预览、打开（升级），重启后再预览、打开同一本（已是 12，对照）。
  'bs702-upgrade-perf': { model: true, shell: 'stage', setup: async context => {
    installReplies(context.fake)
    await copyFixtureThenRevert(context)
  }, run: async context => {
    const upgrade = await upgradeFromLibrary(context, 'bs702-perf', { shots: false })
    assert.deepEqual([upgrade.before, upgrade.after], [10, 12])
    await context.restart()
    const current = await upgradeFromLibrary(context, 'bs702-perf-current', { shots: false })
    assert.deepEqual([current.before, current.after], [12, 12])
    const measured = { upgrade, current }
    assertResponsive({ ...upgrade, currentPreviewBlockedMaxMs: current.previewBlockedMaxMs, currentOpenBlockedMaxMs: current.openBlockedMaxMs })
    return measured
  } },
  'bs702-seal': { model: true, shell: 'stage', setup: async context => {
    installReplies(context.fake)
    await reuseBuilt(context)
    await context.restart()
  }, run: async context => {
    const { page } = context, source = path.join(context.roots.projects, BOOK), old = Number(process.env.PERF702_FINALIZED ?? 10)
    await stage.spine(page).or(stage.cover(page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
    if (!await stage.spine(page).isVisible()) await stage.openFromLibrary(page, BOOK)
    await installLedger(context.app, page)
    const sent = installReviewCycleReplies(context.fake)
    for (const chapter of [old + 1, old + 2]) await reviewCycleChapter(context, chapter, sent)
    installReplies(context.fake)
    const written = proofs(source)
    assert.deepEqual([written.userVersion, written.kinds[2]], [12, 6], JSON.stringify(written))
    assert.ok(written.kinds.sealed > 0, `打开时已整理源库：${JSON.stringify(written)}`)
    const v1Total = (kinds) => (kinds.sealed ?? 0) + (kinds[1] ?? 0)
    const first = await exportAndRestore(context, source, 'bs702-seal-1')
    const second = await exportAndRestore(context, first, 'bs702-seal-2')
    const restored = [proofs(first), proofs(second)]
    for (const copy of restored) {
      assert.equal(copy.kinds[2], 6, JSON.stringify(copy))
      assert.equal(v1Total(copy.kinds), v1Total(written.kinds), JSON.stringify(copy))
      assert.ok(copy.kinds.sealed > 0, JSON.stringify(copy))
    }
    await openInUi(context, second)
    await chapterView.open(page, 3)
    await chapterView.view(page).getByRole('button', { name: '重新打开修改' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '重新打开', exact: true }).click()
    await chapterView.view(page).getByRole('button', { name: 'AI 审稿', exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    await chapterView.review(page)
    const failed = page.getByText('工作流未完成')
    await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
    assert.equal(await failed.count(), 0, '恢复出的书里第 3 章的 AI 审稿没有完成')
    await context.shoot('bs702-seal-rereview')
    const after = proofs(second)
    assert.equal(after.kinds[2], restored[1].kinds[2] + 1, '重新审稿新写了一条 v2 证明')
    return { written, restored, after }
  } },
  'real-bs702-112': { real: true, setup: async context => { await copyFixtureThenRevert(context, { real: true }) }, run: async context => {
    const upgrade = await upgradeFromLibrary(context, 'real-bs702-upgrade')
    const { page } = context, next = Number(process.env.PERF702_FINALIZED ?? 112) + 1, confirmations = []
    const write = await writeChapter(page, next, confirmations)
    const review = await reviewReviseMerge(page, next, confirmations)
    await context.shoot('real-bs702-merged')
    const after = proofs(path.join(context.roots.projects, BOOK))
    assert.equal(after.last, 2, JSON.stringify(after))
    return { upgrade, write, review, proofs: after, confirmations }
  } },
}
