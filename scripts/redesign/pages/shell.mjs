const SHELL_READY = '.app-skin-root [data-shell-presentation="writer"][data-shell-variant="v3"], [data-shell-presentation="stage"]'
const STARTUP_NOTICE = '[role="status"].fixed.inset-x-0.top-10'

export async function waitForShell(page, timeout) {
  await page.locator(SHELL_READY).first().waitFor({ state: 'visible', timeout })
}

export async function dismissStartupNotice(page) {
  const acknowledge = page.locator(STARTUP_NOTICE).getByRole('button', { name: '知道了', exact: true })
  if (await acknowledge.isVisible()) await acknowledge.click()
}

const completionToastIgnore = page =>
  page.getByRole('button', { name: '打开查看', exact: true }).locator('xpath=following-sibling::button[1]')

export async function waitForCompletionToast(page) {
  await completionToastIgnore(page).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
}

export async function dismissCompletionToasts(page) {
  for (const button of await completionToastIgnore(page).all()) await button.click().catch(() => {})
  await completionToastIgnore(page).last().waitFor({ state: 'detached' })
}

export function firstInteractiveControl(page) {
  return page.getByRole('button', { name: '新建作品', exact: true })
}

const LEFT_RAIL = '.writer-left-rail'
const PANELS = { sidebar: '#writer-sidebar', assistant: '#writer-assistant', bottom: '#writer-bottom' }

export async function clickRail(page, label) {
  await page.locator(LEFT_RAIL).getByRole('button', { name: label }).click()
}

export function panels(page) {
  return page.evaluate(ids => Object.fromEntries(Object.entries(ids)
    .map(([name, selector]) => [name, !document.querySelector(selector)?.hasAttribute('hidden')])), PANELS)
}

export function bottomTabLabel(page, label) {
  return page.locator(PANELS.bottom).getByText(label, { exact: true })
}

export function shelf(page) {
  return page.locator('.writer-shelf')
}

export async function isImmersive(page) {
  return await page.locator('[data-writer-immersive="true"]').count() > 0
}

export async function toggleImmersion(page) {
  await page.getByRole('button', { name: /^(进入|退出)沉浸写作$/ }).click()
}

export async function closeBottomPanel(page) {
  await page.locator(PANELS.bottom).getByTitle('关闭面板', { exact: true }).click()
  await page.locator(PANELS.bottom).waitFor({ state: 'hidden' })
}

export async function switchProject(page) {
  await page.locator('button[title="切换项目"]').click()
}

export async function openBackupSettings(page) {
  await page.getByRole('button', { name: '备份', exact: true }).click()
}

export async function clickStatusBarModel(page) {
  await page.locator('[title^="当前模型："]').click()
}

export async function hideRunPanel(page) {
  await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
}

export async function requestWindowClose(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
}
