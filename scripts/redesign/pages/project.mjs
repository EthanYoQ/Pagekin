const PROJECT_TREE = '.writer-project-tree'

export const tree = page => page.locator(PROJECT_TREE)

export async function openNode(page, label) {
  await tree(page).getByText(label, { exact: true }).click()
}

export async function openBlueprints(page) {
  await openNode(page, '章节蓝图')
  await page.getByRole('button', { name: '写作此章' }).waitFor({ state: 'visible' })
}

export async function waitForTreeRefreshed(page, blueprintCount) {
  await tree(page).getByText(new RegExp(`^${blueprintCount}/\\d+ 章$`)).waitFor({ state: 'visible' })
  await tree(page).getByRole('button', { name: '刷新', disabled: false }).waitFor({ state: 'visible' })
}

export async function openLatestDraft(page) {
  await tree(page).getByText(/^草稿_v[0-9]+$/).first().click()
}

export function draftOfChapter(page, chapterNumber) {
  return tree(page).getByTitle(new RegExp(`^第${chapterNumber}章`)).first()
    .locator('xpath=following-sibling::div[1]').getByText(/^草稿_v[0-9]+$/).first()
}
