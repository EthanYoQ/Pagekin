import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { openChapter } from './f491-scenarios.mjs'
import { BOOK, buildByReviewCycle, chapterMarker, chapterText, chapterTitle, seedLargeBook } from './perf702-scenarios.mjs'
import { countUnits } from './stage-sample.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try { return action(database) } finally { database.close() }
}

function cycleOf(database, chapter) {
  const cycle = database.prepare(`SELECT c.root_action_id AS rootActionId, c.review_id AS reviewId FROM review_cycles c
    JOIN reviews r ON r.id=c.review_id JOIN drafts_all d ON d.id=r.base_draft_id WHERE d.chapter_number=?`).get(chapter)
  assert.ok(cycle, `第 ${chapter} 章有一条审修循环`)
  return cycle
}

/** 与 test/helpers/review-cycle-fixture.ts 的 breakReviewProof 保持一致。 */
function breakReviewProof(projectRoot, chapter) {
  withBook(projectRoot, database => {
    const cycle = cycleOf(database, chapter)
    const changed = database.prepare(`UPDATE generation_attempts
      SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contentHash',?)
      WHERE root_action_id=? AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='review'
        AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.id')=?`).run('0'.repeat(64), cycle.rootActionId, cycle.reviewId).changes
    assert.equal(changed, 1, `第 ${chapter} 章应改坏一条审稿证据，实际改了 ${changed} 条`)
  })
}

/** 清空根预算，使去掉坏循环后这棵根仍过不了投影（ADR-0029「照旧失败」）。 */
function breakRootBudget(projectRoot, chapter) {
  withBook(projectRoot, database => {
    const changed = database.prepare("UPDATE generation_roots SET budget_json='{}' WHERE root_action_id=?").run(cycleOf(database, chapter).rootActionId).changes
    assert.equal(changed, 1)
  })
}

/** 静止树打开时不查绑定，只有导出前的全量进门封存它（#749）。 */
function addUnreadableSiblingRun(projectRoot, chapter) {
  withBook(projectRoot, database => {
    const { rootActionId } = cycleOf(database, chapter)
    const review = database.prepare(`SELECT attempt_id AS attemptId, run_id AS runId FROM generation_attempts
      WHERE root_action_id=? AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='review'`).get(rootActionId)
    assert.ok(review, `第 ${chapter} 章有一次审稿尝试`)
    database.prepare(`INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key)
      SELECT 'run-extra',root_action_id,'{坏',status,created_at_ms,'open-extra' FROM generation_runs WHERE run_id=?`).run(review.runId)
    database.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,usage_receipt_json,invocation_nonce)
      SELECT 'attempt-extra','reservation-extra','run-extra',root_action_id,
        json_set(attempt_json,'$.attemptId','attempt-extra','$.reservationId','reservation-extra'),'{}','invocation-extra'
      FROM generation_attempts WHERE attempt_id=?`).run(review.attemptId)
    database.prepare("UPDATE generation_roots SET action_json=json_set(action_json,'$.status','paused')").run()
  })
}

const notice = (page, role) => stage.root(page).locator(`[data-testid="project-backup-panel"] p[role="${role}"]`)

async function exportOnce(context, archive, { settings, page: pageName, button }, role, expected) {
  const { app, page } = context
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, archive)
  await stage.root(page).getByRole('navigation', { name: settings }).getByRole('button', { name: pageName, exact: true }).click()
  await stage.root(page).getByRole('button', { name: button, exact: true }).click()
  const deadline = Date.now() + 60_000
  let shown = ''
  while (!expected.test(shown)) {
    if (Date.now() > deadline) assert.fail(`等不到导出提示，最后看到：${shown || '（无）'}`)
    await page.waitForTimeout(200)
    const notices = (await notice(page, role).allInnerTexts()).map(text => text.trim())
    shown = notices.find(text => expected.test(text)) ?? notices.join(' | ')
  }
  assert.equal(fs.existsSync(archive), role === 'status', role === 'status' ? '导出成功时写出了存档' : '导出失败时没有写出存档')
  return shown
}

async function switchLocale(page, from, to) {
  await stage.root(page).getByRole('navigation', { name: from.settings }).getByRole('button', { name: from.appearance, exact: true }).click()
  await page.getByLabel(from.languageLabel).selectOption(to)
  await page.waitForFunction(lang => document.documentElement.lang === lang, to)
}

const ZH = { settings: '设置分组', page: '项目备份', button: '导出本地存档' }
const EN = { settings: 'Settings sections', page: 'Project backup', button: 'Export local archive' }
const SHA = '[0-9a-f]{64}'

export const CCH_SCENARIOS = {
  'cch-export-damaged': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false,
      beforeLaunch: () => breakReviewProof(path.join(context.roots.projects, BOOK), 2) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-zh.ainovel'), ZH, 'status',
      new RegExp(`^本地存档已导出：${SHA}。第 2 章「远航之2」有条审稿记录损坏，没放进存档。正文和其他审稿内容都在。$`, 'u'))
    await shoot('cch-1-zh')

    await switchLocale(page, { settings: '设置分组', appearance: '外观', languageLabel: '界面语言' }, 'ja-JP')
    const ja = await exportOnce(context, path.join(roots.projects, 'cch-ja.ainovel'), EN, 'status',
      new RegExp(`^Local archive exported: ${SHA}\\. 第2章「远航之2」のレビュー記録が破損していたため、アーカイブに含めませんでした。本文とその他のレビュー内容は含まれています。$`, 'u'))
    await shoot('cch-2-ja')

    await switchLocale(page, { settings: 'Settings sections', appearance: 'Appearance', languageLabel: 'Interface language' }, 'en-US')
    const en = await exportOnce(context, path.join(roots.projects, 'cch-en.ainovel'), EN, 'status',
      new RegExp(`^Local archive exported: ${SHA}\\. A damaged review record in Chapter 2 "远航之2" was left out of the archive\\. The text and other reviews are included\\.$`, 'u'))
    await shoot('cch-3-en')
    return { zh, ja, en }
  } },
  'cch-export-multi': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false, beforeLaunch: () => {
      for (const chapter of [1, 2]) breakReviewProof(path.join(context.roots.projects, BOOK), chapter)
    } })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-multi-zh.ainovel'), ZH, 'status',
      new RegExp(`^本地存档已导出：${SHA}。第 1 章「远航之1」、第 2 章「远航之2」有审稿记录损坏，没放进存档。正文和其他审稿内容都在。$`, 'u'))
    await shoot('cch-5-multi-zh')

    await switchLocale(page, { settings: '设置分组', appearance: '外观', languageLabel: '界面语言' }, 'en-US')
    const en = await exportOnce(context, path.join(roots.projects, 'cch-multi-en.ainovel'), EN, 'status',
      new RegExp(`^Local archive exported: ${SHA}\\. Damaged review records in Chapter 1 "远航之1", Chapter 2 "远航之2" were left out of the archive\\. The text and other reviews are included\\.$`, 'u'))
    await shoot('cch-6-multi-en')
    return { zh, en }
  } },
  'cch-trash-damaged': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false,
      beforeLaunch: () => breakReviewProof(path.join(context.roots.projects, BOOK), 1) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await openChapter(page, 1)
    await chapterView.more(page, '删除正文…')
    const confirm = page.getByRole('dialog', { name: '删除正文' })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    await page.getByText(/^已把「.+」移到回收站/u).first().waitFor({ state: 'visible', timeout: 30_000 })
    await stage.openSettings(page)
    const inTrash = await exportOnce(context, path.join(roots.projects, 'cch-trash.ainovel'), ZH, 'status',
      new RegExp(`^本地存档已导出：${SHA}。回收站里第 1 章「远航之1」有条审稿记录损坏，没放进存档。正文和其他审稿内容都在。$`, 'u'))
    await shoot('cch-4-trash')
    return { inTrash }
  } },
  'cch-export-sealed-ledger': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false,
      beforeLaunch: () => addUnreadableSiblingRun(path.join(context.roots.projects, BOOK), 2) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-sealed-zh.ainovel'), ZH, 'status',
      new RegExp(`^本地存档已导出：${SHA}。第 2 章「远航之2」有条审稿记录损坏，没放进存档。正文和其他审稿内容都在。$`, 'u'))
    await shoot('cch-8-sealed-ledger')
    return { zh }
  } },
  'cch-export-still-fails': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false, beforeLaunch: () => {
      breakReviewProof(path.join(context.roots.projects, BOOK), 2)
      breakRootBudget(path.join(context.roots.projects, BOOK), 2)
    } })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-fail-zh.ainovel'), ZH, 'alert',
      /^作品没有改动。第 2 章「远航之2」有条审稿记录损坏，存档没生成。请把这条提示反馈给我们。$/u)
    await shoot('cch-7-still-fails')
    return { zh }
  } },
}

function addDamagedOrphanAvatar(projectRoot) {
  const relativePath = `avatars/${'a'.repeat(64)}/${'0'.repeat(20)}-${'b'.repeat(64)}.png`
  const file = path.join(projectRoot, '.ai-novel', ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  withBook(projectRoot, database => {
    database.prepare(`INSERT INTO character_avatar_unresolved(record_id,disposition,source_reference,source_relative_path,
      preserved_relative_path,content_hash,mime,byte_size,candidate_character_ids_json) VALUES ('orphan-ec','orphan','character-delete:gone',?,?,?,'image/png',?,'[]')`)
      .run(relativePath, relativePath, '1'.repeat(64), fs.statSync(file).size)
  })
}

/** 每章约 3 MiB，三章定稿合起来超过审修上下文的 8 MiB 上限。 */
function hugeChapter(number) {
  const body = chapterText(number)
  return [body, ...Array.from({ length: 340 }, () => body.slice(chapterMarker(number).length))].join('\n\n')
}

Object.assign(CCH_SCENARIOS, {
  'ec-export-orphan-avatar': { model: true, shell: 'stage', setup: async context => {
    await seedLargeBook(context, 1)
    await context.restart({ beforeLaunch: () => addDamagedOrphanAvatar(path.join(context.roots.projects, BOOK)) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'ec-orphan.ainovel'), ZH, 'alert',
      /^作品没有改动。一张没归到任何角色名下的旧头像文件坏了或不见了，存档没有生成。请把这条提示反馈给我们。$/u)
    await shoot('ec-1-orphan-avatar')
    return { zh }
  } },
  'ec-review-overflow': { model: true, shell: 'stage', setup: async context => {
    const { page, invoke, reload } = context
    const { projectPath } = await seedLargeBook(context, 0)
    const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const session = { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
    for (const number of [1, 2, 3]) {
      const content = hugeChapter(number)
      const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
        chapters: [{ chapterNumber: number, title: chapterTitle(number), content, wordCount: countUnits(content) }] }, projectPath, session)
      assert.equal(imported.success, true, imported.error)
    }
    const draft = chapterText(4)
    const created = await invoke(page, 'db:draft-create', { chapterNumber: 4, version: 1, source: 'write', content: draft, wordCount: countUnits(draft) }, projectPath, session)
    assert.equal(created.success, true, created.error)
    await reload()
  }, run: async context => {
    const { page, shoot } = context
    await stage.openFromLibrary(page, BOOK)
    await chapterView.open(page, 4)
    await chapterView.view(page).getByRole('button', { name: 'AI 审稿', exact: true }).click()
    const shown = page.getByText('本章正文和附加修稿要求合计超过上限', { exact: false }).first()
    await shown.waitFor({ state: 'visible', timeout: 120_000 })
    await shoot('ec-2-review-overflow')
    return { text: (await shown.innerText()).trim() }
  } },
})

Object.assign(CCH_SCENARIOS, {
  'ec-export-unknown-file': { model: true, shell: 'stage', setup: async context => {
    await seedLargeBook(context, 1)
    await context.restart({ beforeLaunch: () => fs.writeFileSync(path.join(context.roots.projects, BOOK, '.ai-novel', 'desktop.ini'), '[.ShellClassInfo]\r\n') })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'ec-unknown.ainovel'), ZH, 'alert',
      /^作品没有改动。作品文件夹里有不认识的文件或链接，存档没有生成。请把这条提示反馈给我们。$/u)
    await shoot('ec-3-unknown-file')
    return { zh }
  } },
})

async function restoreOnce(context, archive, parent, expected) {
  const { app, page } = context
  await app.evaluate(({ dialog }, answers) => {
    const queue = [...answers]
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] })
  }, [archive, parent])
  await stage.root(page).getByRole('navigation', { name: ZH.settings }).getByRole('button', { name: ZH.page, exact: true }).click()
  await stage.root(page).getByRole('button', { name: '从本地存档恢复副本', exact: true }).click()
  const shown = notice(page, 'alert').filter({ hasText: expected })
  await shown.waitFor({ state: 'visible', timeout: 60_000 })
  return (await shown.innerText()).trim()
}

Object.assign(CCH_SCENARIOS, {
  'ec-restore-not-archive': { model: true, shell: 'stage', setup: async context => {
    await seedLargeBook(context, 1)
  }, run: async context => {
    const { page, roots, shoot } = context
    const archive = path.join(roots.projects, '下载了一半.ainovel')
    fs.writeFileSync(archive, 'PK\u0003\u0004 not a whole archive')
    const parent = path.join(roots.projects, 'restore-here')
    fs.mkdirSync(parent)
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await restoreOnce(context, archive, parent,
      /^没有新建副本。所选文件不是完整的书童存档，可能坏了或没下载完。请换一个存档，再点「从本地存档恢复副本」。$/u)
    assert.deepEqual(fs.readdirSync(parent), [], '没有留下副本或暂存')
    await shoot('ec-4-restore-not-archive')
    return { zh }
  } },
  'ec-cloud-endpoint': { model: true, shell: 'stage', setup: async context => {
    await seedLargeBook(context, 1)
  }, run: async context => {
    const { page, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    await stage.root(page).getByRole('navigation', { name: ZH.settings }).getByRole('button', { name: ZH.page, exact: true }).click()
    const panel = stage.root(page).locator('[data-testid="project-backup-panel"]')
    await panel.getByLabel('WebDAV 地址').fill('http://dav.example.com/dav/')
    await panel.getByLabel('用户名').fill('writer')
    await panel.getByLabel('密码或应用密钥').fill('app-secret')
    await panel.getByLabel('云书标识').fill('my-book')
    await panel.getByRole('button', { name: '连接并绑定', exact: true }).click()
    const shown = notice(page, 'alert').filter({ hasText: /^没有连接。WebDAV 地址要是 https:\/\/ 开头的完整网址，不能带 \?、# 或用户名密码。请改好地址，再点「连接并绑定」。$/u })
    await shown.waitFor({ state: 'visible', timeout: 30_000 })
    await shoot('ec-6-cloud-endpoint')
    return { zh: (await shown.innerText()).trim() }
  } },
})
