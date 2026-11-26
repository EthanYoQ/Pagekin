import { waitForCompletionToast } from './shell.mjs'

export const OUTPUT_TEXT = '.run-output .assistant-content, .writer-ai-panel .assistant-content'

export const sheet = page => page.getByRole('complementary', { name: /^(运行|Run)$/ })
export const tab = (page, name) => sheet(page).getByRole('tab', { name, exact: true })
export const anyCard = page => sheet(page).getByRole('article')
export const lastRun = page => anyCard(page).filter({ hasText: /^(上一次运行|Last run)/ })
export const output = page => sheet(page).locator('.run-output')
export const recovery = page => sheet(page).getByRole('region', { name: /^(可恢复的内容|Recoverable work)$/ })

export async function waitUntilOpen(page) {
  await sheet(page).waitFor({ state: 'visible' })
}

export async function openFromPalette(page) {
  if (await sheet(page).isVisible()) return
  await page.keyboard.press('ControlOrMeta+K')
  const input = page.getByRole('dialog', { name: '搜索与跳转' }).getByRole('combobox')
  await input.waitFor({ state: 'visible' })
  await input.fill('运行侧页')
  await page.keyboard.press('Enter')
  await waitUntilOpen(page)
}

export async function waitForRunDone(page, timeout = 90_000) {
  await lastRun(page).getByText(/已完成|Complete/).waitFor({ state: 'visible', timeout })
  await waitForCompletionToast(page)
}

export async function activeTitles(page) {
  return sheet(page).getByRole('article').evaluateAll(cards => cards
    .filter(card => !card.textContent?.startsWith('上一次运行') && !card.textContent?.startsWith('可恢复'))
    .map(card => card.querySelector('h3')?.textContent ?? ''))
}

export function visibleWords(page, { withoutLogLines = false } = {}) {
  return sheet(page).evaluate((node, skip) => {
    const copy = node.cloneNode(true)
    if (skip) copy.querySelectorAll('.run-log-message').forEach(line => line.remove())
    document.body.append(copy)
    try {
      return [copy.innerText, ...[...copy.querySelectorAll('[aria-label],[title]')]
        .map(element => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`)].join('\n')
    } finally { copy.remove() }
  }, withoutLogLines)
}
