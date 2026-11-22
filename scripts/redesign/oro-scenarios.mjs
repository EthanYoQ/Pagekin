import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

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

async function openThenPeek({ page, invoke }) {
  const rounds = Number(process.env.ORO_ROUNDS ?? 200)
  const minDelay = Number(process.env.ORO_MIN_DELAY ?? PEEK_AFTER_OPEN_MS.min)
  const maxDelay = Number(process.env.ORO_MAX_DELAY ?? PEEK_AFTER_OPEN_MS.max)
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
