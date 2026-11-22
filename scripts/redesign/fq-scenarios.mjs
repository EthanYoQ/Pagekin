import assert from 'node:assert/strict'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const name = STAGE_SAMPLE.name

const COPY = {
  zh: { more: `《${name}》更多操作`, remove: '从最近项目移除…', latin: '"Noto Sans SC"' },
  en: { more: `More for “${name}”`, remove: 'Remove from recent…', latin: '"Inter"' },
}

function punctuationWidths(item, latin) {
  return item.evaluate(async (element, family) => {
    const { fontFamily: stack, fontSize } = getComputedStyle(element)
    await Promise.all([stack, family].map(fontFamily => document.fonts.load(`${fontSize} ${fontFamily}`, '…·•')))
    const measure = (char, fontFamily) => {
      const span = document.createElement('span')
      span.textContent = char
      span.style.letterSpacing = '0'
      if (fontFamily) span.style.fontFamily = fontFamily
      element.append(span)
      const em = span.getBoundingClientRect().width / parseFloat(getComputedStyle(span).fontSize)
      span.remove()
      return Math.round(em * 1000) / 1000
    }
    return Object.fromEntries(['…', '·', '•'].map(char => [char, { shown: measure(char), reference: measure(char, family) }]))
  }, latin)
}

async function libraryMenu(context, lang) {
  const copy = COPY[lang]
  const { page } = context
  if (lang === 'en') {
    assert.equal((await context.invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await context.reload()
  }
  await page.getByRole('button', { name: copy.more }).click()
  const item = page.getByRole('menuitem', { name: copy.remove })
  await item.waitFor({ state: 'visible' })
  const widths = await punctuationWidths(item, copy.latin)
  for (const [char, { shown, reference }] of Object.entries(widths)) {
    assert.ok(Math.abs(shown - reference) < 0.02, `菜单里的 ${char} 应与 ${copy.latin} 同宽，实际 ${shown}，参照 ${reference}`)
  }
  return { widths }
}

const setup = context => seedStageSample(context, { open: false })

export const FQ_SCENARIOS = {
  'fq-library-menu': { model: false, shell: 'stage', setup, run: context => libraryMenu(context, 'zh') },
  'fq-library-menu-en': { model: false, shell: 'stage', setup, run: context => libraryMenu(context, 'en') },
}
