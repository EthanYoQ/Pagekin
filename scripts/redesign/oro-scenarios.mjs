import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const SECOND = '雾港'
const PEEK_AFTER_OPEN_MS = { min: 70, max: 130 }

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

/** 预览把库复制进 scratch 下的 attempt-*／snapshot.db，读完就删；看到它说明这一轮预览真的开始复制了。 */
function watchPeekCopy(scratchRoot) {
  let seenAt = null
  let stopped = false
  const copying = () => fs.existsSync(scratchRoot) && fs.readdirSync(scratchRoot)
    .some(attempt => fs.existsSync(path.join(scratchRoot, attempt, 'snapshot.db')))
  const done = (async () => {
    while (!stopped && seenAt === null) {
      if (copying()) seenAt = Date.now()
      else await new Promise(resolve => setImmediate(resolve))
    }
  })()
  return { stop: async () => { stopped = true; await done; return seenAt } }
}

async function openThenPeek({ page, invoke, roots }) {
  const rounds = Number(process.env.ORO_ROUNDS ?? 200)
  const minDelay = Number(process.env.ORO_MIN_DELAY ?? PEEK_AFTER_OPEN_MS.min)
  const maxDelay = Number(process.env.ORO_MAX_DELAY ?? PEEK_AFTER_OPEN_MS.max)
  const scratchRoot = path.join(roots.localAppData, 'VibeCodingScratch', 'ai-novel-writer', 'project-peek')
  const failures = []
  let effective = 0
  let current = SECOND
  for (let round = 0; round < rounds; round++) {
    const target = current === SECOND ? STAGE_SAMPLE.name : SECOND
    const book = (await invoke(page, 'project:recent-list')).find(item => item.name === target)
    assert.ok(book?.previewCapabilityId, `《${target}》没有预览凭据`)
    const delay = minDelay + (round * 7) % (maxDelay - minDelay + 1)
    const watch = watchPeekCopy(scratchRoot)
    const opened = await page.evaluate(async ({ capability, bookPath, delay, token }) => {
      const api = window.aiNovelAPI
      const opening = api.invoke('project:open', bookPath, token, null)
        .then(result => ({ ...result, doneAt: performance.timeOrigin + performance.now() }))
      await new Promise(resolve => setTimeout(resolve, delay))
      await api.invoke('project:peek-overview', capability)
      return opening
    }, { capability: book.previewCapabilityId, bookPath: book.path, delay, token: randomUUID() })
    const copyStartedAt = await watch.stop()
    if (opened.success) current = target
    else failures.push({ round, delay, target, errorCode: opened.errorCode, error: String(opened.error).slice(0, 80) })
    if (copyStartedAt !== null && copyStartedAt < opened.doneAt) effective++
  }
  assert.deepEqual(failures, [], `打开作品时同一本书的预览不应让打开失败（${rounds} 轮里预览在打开完成前开始复制的有 ${effective} 轮）`)
  const minimum = Number(process.env.ORO_MIN_EFFECTIVE ?? Math.ceil(rounds / 4))
  assert.ok(effective >= minimum, `预览在打开完成前开始复制的只有 ${effective} 轮，少于 ${minimum} 轮，这次不算验证过`)
  return { rounds, effective, failures }
}

export const ORO_SCENARIOS = {
  'oro-open-then-peek': { model: false, shell: 'stage', setup, run: openThenPeek },
}
