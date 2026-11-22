// 书房预览与打开同一本书同时进行（#702 open-readonly）。
// 作者用封面菜单「打开作品」或 Ctrl K 打开一本书，打开还没完成就点它的封面：先打开、后预览。
// 预览复制 project.db 时打开作品的可写连接曾退成只读，报 SQLITE_READONLY。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const SECOND = '雾港'

async function seedSecondBook({ app, page, roots, invoke }) {
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: SECOND, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
}

const setup = async context => {
  await seedStageSample(context, { open: false })
  await seedSecondBook(context)
  await context.reload()
}

/**
 * 直接走主进程的两个处理器：先发打开，隔 delay 毫秒再发同一本的预览，打开的总是当前没开着的那本。
 * 70–130 ms 是本机预览复制落在可写连接上的区间（master 200 轮 15 次相交、5 次报只读）。
 */
async function openThenPeek({ page, invoke }) {
  const rounds = Number(process.env.ORO_ROUNDS ?? 200)
  const minDelay = Number(process.env.ORO_MIN_DELAY ?? 70)
  const maxDelay = Number(process.env.ORO_MAX_DELAY ?? 130)
  const failures = []
  let current = SECOND
  for (let round = 0; round < rounds; round++) {
    const target = current === SECOND ? STAGE_SAMPLE.name : SECOND
    const book = (await invoke(page, 'project:recent-list')).find(item => item.name === target)
    assert.ok(book?.previewCapabilityId, `《${target}》没有预览凭据`)
    const delay = minDelay + (round * 7) % (maxDelay - minDelay + 1)
    const opened = await page.evaluate(async ({ capability, path, delay, token }) => {
      const api = window.aiNovelAPI
      const opening = api.invoke('project:open', path, token, null)
      await new Promise(resolve => setTimeout(resolve, delay))
      await api.invoke('project:peek-overview', capability)
      return opening
    }, { capability: book.previewCapabilityId, path: book.path, delay, token: randomUUID() })
    if (opened.success) current = target
    else failures.push({ round, delay, target, errorCode: opened.errorCode, error: String(opened.error).slice(0, 80) })
  }
  assert.deepEqual(failures, [], '打开作品时同一本书的预览不应让打开失败')
  return { rounds, failures }
}

export const ORO_SCENARIOS = {
  'oro-open-then-peek': { model: false, shell: 'stage', setup, run: openThenPeek },
}
