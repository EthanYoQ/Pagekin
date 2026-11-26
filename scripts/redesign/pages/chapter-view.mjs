import * as stage from './stage.mjs'

export const view = page => stage.root(page).locator('.stage-ch')
export const prose = page => view(page).locator('.stage-ch-prose .cm-content')
export const title = page => view(page).getByRole('heading', { level: 1 })
export const versionButton = page => view(page).getByRole('button', { name: /^本章版本：/ })
export const lifecycleCurrent = page => view(page).locator('.pi-life [aria-current="step"]')
export const reviewSheet = page => page.getByRole('complementary', { name: '审稿报告' })
export const merge = page => page.getByRole('region', { name: '修稿合并' })
export const postProcess = page => page.getByRole('region', { name: '定稿后处理' })
export const finalizeDialog = (page, chapterNumber) => page.getByRole('dialog', { name: `定稿第 ${chapterNumber} 章？` })
export const hint = page => view(page).locator('.stage-ch-hint')

export const primary = page => view(page).locator('.stage-ch-actions .pi-btn--primary').first()

export async function open(page, chapterNumber) {
  await stage.chapterButton(page, chapterNumber).click()
  await view(page).waitFor({ state: 'visible' })
}

export async function more(page, item) {
  await view(page).getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export async function versions(page) {
  await versionButton(page).click()
  const items = await page.getByRole('menu', { name: '本章版本' }).getByRole('menuitemradio').allInnerTexts()
  await page.keyboard.press('Escape')
  return items.map(item => item.split('\n')[0])
}

export async function review(page) {
  await view(page).getByRole('button', { name: 'AI 审稿', exact: true }).click()
  await reviewSheet(page).waitFor({ state: 'visible', timeout: 60_000 })
}

export const reviseButton = page => view(page).getByRole('button', { name: /^按 \d+ 项意见修稿$/ })

export async function finalize(page, chapterNumber, { untilReadOnly = true, beforeConfirm } = {}) {
  const button = view(page).getByRole('button', { name: '定稿', exact: true })
  const item = page.getByRole('menuitem', { name: '定稿…' })
  await view(page).getByRole('button', { name: '更多操作' }).click()
  await item.or(button).first().waitFor({ state: 'visible' })
  if (await item.isVisible()) await item.click()
  else {
    await page.keyboard.press('Escape')
    await button.click()
  }
  const confirm = finalizeDialog(page, chapterNumber).getByRole('button', { name: '确认定稿', exact: true })
  await confirm.waitFor({ state: 'visible' })
  beforeConfirm?.()
  await confirm.click()
  if (untilReadOnly) await view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
}

export async function postProcessSteps(page) {
  return postProcess(page).locator('li').evaluateAll(rows => rows.map(row => ({ label: row.querySelector('b')?.textContent, state: row.dataset.state })))
}
