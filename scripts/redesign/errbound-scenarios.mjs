import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

const RAW = /Cannot read properties of null|TypeError|at \w+ \(/u

async function crashSkillsPage(page) {
  return page.evaluate(() => {
    const inside = document.querySelector('.stage-set-inner .stage-set-legacy')?.firstElementChild
    const fiberKey = inside && Object.keys(inside).find(key => key.startsWith('__reactFiber$'))
    if (!fiberKey) return false
    for (let fiber = inside[fiberKey]; fiber; fiber = fiber.return) {
      for (let hook = typeof fiber.type === 'function' ? fiber.memoizedState : null; hook; hook = hook.next) {
        const [skills, bindings, sourceUrl] = [hook.memoizedState, hook.next?.memoizedState, hook.next?.next?.memoizedState]
        const skillList = Array.isArray(skills) && skills.every(item => item && typeof item.skillId === 'string')
        const bindingMap = bindings !== null && typeof bindings === 'object' && !Array.isArray(bindings)
        if (skillList && bindingMap && typeof sourceUrl === 'string' && hook.queue?.dispatch) {
          hook.queue.dispatch([null])
          return true
        }
      }
    }
    return false
  })
}

function stubClipboard(page) {
  return page.evaluate(() => {
    window.__copiedDiagnostics = null
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedDiagnostics = value } } })
  })
}

async function observe(page, panel, { heading, copy, copied, name, shoot }) {
  await panel.getByRole('heading', { name: heading }).waitFor({ state: 'visible', timeout: 10_000 })
  const shown = await panel.innerText()
  assert.doesNotMatch(shown, RAW, '面板不露异常原文与组件栈')
  await shoot(`${name}-panel`)
  await stubClipboard(page)
  await panel.getByRole('button', { name: copy }).click()
  await panel.getByRole('button', { name: copied }).waitFor({ state: 'visible', timeout: 5000 })
  const diagnostics = await page.evaluate(() => window.__copiedDiagnostics)
  assert.match(diagnostics ?? '', /Cannot read properties of null/u, '复制的诊断信息含异常原文')
  const componentStack = (diagnostics ?? '').split('\n\n').at(-1)
  assert.match(componentStack, /^\s*at \S+/u, '复制的诊断信息末段是组件栈')
  assert.doesNotMatch(componentStack, /Cannot read properties of null/u, '组件栈一段不是异常原文')
  return { shown, copiedLines: diagnostics.split('\n').length }
}

const settingsBody = page => stage.root(page).locator('.stage-set-inner')

export const ERRBOUND_SCENARIOS = {
  'errbound-settings-crash': { model: false, shell: 'stage', setup: seedStageSample, run: async context => {
    const { page } = context
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '写作 Skills')
    assert.equal(await crashSkillsPage(page), true, '能让技能设置页渲染出错')
    const result = await observe(page, settingsBody(page), {
      heading: '设置页渲染失败', copy: '复制诊断信息', copied: '已复制', name: 'errbound-settings-crash', shoot: context.shoot,
    })
    assert.match(result.shown, /已保存的内容不受影响/u)
    return result
  } },

  'errbound-settings-crash-en': { model: false, shell: 'stage', setup: seedStageSample, run: async context => {
    assert.equal((await context.invoke(context.page, 'config:set', { locale: 'en-US' })).success, true)
    await context.reload()
    const page = context.page
    await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
    await stage.root(page).getByRole('button', { name: 'Settings', exact: true }).first().click()
    const nav = stage.root(page).getByRole('navigation', { name: 'Settings sections' })
    await nav.getByRole('button', { name: 'Writing skills', exact: true }).click()
    await stage.root(page).getByRole('heading', { level: 1, name: 'Writing skills', exact: true }).waitFor({ state: 'visible' })
    assert.equal(await crashSkillsPage(page), true, '能让技能设置页渲染出错')
    const result = await observe(page, settingsBody(page), {
      heading: 'Settings failed to render', copy: 'Copy diagnostics', copied: 'Copied', name: 'errbound-settings-crash-en', shoot: context.shoot,
    })
    assert.match(result.shown, /Your saved work is not affected/u)
    return result
  } },
}
