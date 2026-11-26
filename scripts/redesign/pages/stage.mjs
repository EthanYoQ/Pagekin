import { decodePng } from '../png.mjs'

const SHELL = '[data-shell-presentation="stage"]'

export const root = page => page.locator(SHELL)
export const spine = page => page.getByRole('navigation', { name: '创作流程' })
export const chapterList = page => spine(page).getByRole('list', { name: '章节' })
export const tabList = page => page.getByRole('tablist', { name: '已打开的页面' })
export const characterList = page => root(page).getByRole('complementary', { name: '角色名单' })
export const prose = page => page.locator(`${SHELL} .stage-content .cm-content`)

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const stageButton = (page, name) => spine(page).getByRole('button', { name: new RegExp(`^${escape(name)}`) })

export async function stageStates(page) {
  return spine(page).locator('[data-stage]').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.dataset.stage, row.dataset.state])))
}

export const chapterButton = (page, number) => chapterList(page).getByRole('button', { name: new RegExp(`^${number}\\D`) })

export async function chapterRows(page) {
  return chapterList(page).getByRole('button').evaluateAll(rows => rows.map(row => ({
    number: Number(row.querySelector('.stage-chapter-no')?.textContent),
    phase: row.dataset.phase,
    current: row.getAttribute('aria-current') === 'page',
  })))
}

export const shelf = page => page.getByRole('list', { name: '最近的作品' })
export const cover = (page, name) => shelf(page).getByRole('button', { name: `预览《${name}》` })
export const overview = (page, name) => page.getByRole('region', { name: `《${name}》概览` })

export async function previewBook(page, name) {
  await cover(page, name).click()
  const region = overview(page, name)
  await region.waitFor({ state: 'visible' })
  const stats = region.locator('.pi-stats')
  const reason = region.locator('.stage-ov-status').filter({ hasNotText: '正在读取' })
  try {
    await stats.or(reason).first().waitFor({ state: 'visible' })
  } catch (error) {
    throw new Error(`《${name}》的预览一直停在「正在读取这部作品…」`, { cause: error })
  }
  if (await reason.isVisible()) throw new Error(`《${name}》的预览读不到：${await reason.textContent()}`)
}

export async function openFromLibraryEn(page, name) {
  await page.getByRole('list', { name: 'Recent books' }).getByRole('button', { name: `Preview “${name}”` }).click()
  await page.getByRole('region', { name: `“${name}” overview` }).getByRole('button', { name: `Open “${name}”` }).click()
}

export async function openFromLibrary(page, name) {
  await cover(page, name).click()
  await overview(page, name).waitFor({ state: 'visible' })
  if (await overview(page, name).locator('.stage-eyebrow').filter({ hasText: /^继续$/ }).count() > 0) return openFromPalette(page, name)
  await overview(page, name).getByRole('button', { name: `打开《${name}》` }).click()
  await spine(page).waitFor({ state: 'visible' })
}

export async function openFromPalette(page, name) {
  await page.keyboard.press('ControlOrMeta+K')
  await paletteInput(page).waitFor({ state: 'visible' })
  await paletteInput(page).fill(name)
  await palette(page).getByRole('option', { name: new RegExp(`打开《${escape(name)}》`) }).click()
  await spine(page).waitFor({ state: 'visible' })
}

export async function openAfterRestart(page, name) {
  await spine(page).or(cover(page, name)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await spine(page).isVisible()) await openFromLibrary(page, name)
}

export async function bookMenu(page, name, item) {
  await shelf(page).getByRole('button', { name: `《${name}》更多操作` }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export async function waitForProse(page, text) {
  await prose(page).getByText(text).first().waitFor({ state: 'visible', timeout: 20_000 })
}

export const tab = (page, name) => tabList(page).getByRole('tab', { name })
export const closeTabButton = (page, name) => tabList(page).getByRole('button', { name: new RegExp(`^关闭「${escape(name)}」`) })
export const closeOtherTabButtons = (page, keep) => tabList(page).getByRole('button', { name: new RegExp(`^关闭「(?!${escape(keep)}」)`) })

export const saveStatus = page => root(page).getByRole('banner').getByRole('status')

export const focusToggle = page => page.getByRole('button', { name: /^(进入|退出)沉浸写作$/ })

export const palette = page => page.getByRole('dialog', { name: /^(搜索与跳转|查找章节)$/ })
export const paletteInput = page => palette(page).getByRole('combobox')

export async function findChapter(page, query) {
  await page.keyboard.press('ControlOrMeta+P')
  await paletteInput(page).waitFor({ state: 'visible' })
  await paletteInput(page).fill(query)
  await page.keyboard.press('Enter')
  await palette(page).waitFor({ state: 'hidden' })
}

export const capsule = page => root(page).getByRole('button', { expanded: false }).filter({ hasText: /运行中|%|等你确认/ }).first()

export const settingsNav = page => root(page).getByRole('navigation', { name: '设置分组' })
export const settingsLink = (page, name) => settingsNav(page).getByRole('button', { name, exact: true })

export async function openSettings(page) {
  if (await spine(page).isVisible()) await spine(page).getByRole('button', { name: '设置', exact: true }).click()
  else await root(page).getByRole('banner').getByRole('button', { name: '设置', exact: true }).click()
  await settingsNav(page).waitFor({ state: 'visible' })
}

export async function showSettingsPage(page, name) {
  await settingsLink(page, name).click()
  await root(page).getByRole('heading', { level: 1, name, exact: true }).waitFor({ state: 'visible' })
}

export function currentSettingsPage(page) {
  return settingsNav(page).locator('[aria-current="page"] .stage-set-link-name').innerText()
}

export function settingsGroups(page) {
  return settingsNav(page).getByRole('group').evaluateAll(groups => groups.map(group => ({
    group: group.getAttribute('aria-label'),
    pages: [...group.querySelectorAll('.stage-set-link-name')].map(name => name.textContent.trim()),
  })))
}

export async function closeSettings(page, { dispatch = false } = {}) {
  const back = settingsNav(page).getByRole('button', { name: /^返回(作品|书房)$/ })
  await (dispatch ? back.dispatchEvent('click') : back.click())
  await settingsNav(page).waitFor({ state: 'detached' })
}

export const exitDialog = page => page.locator('.stage-dialog').filter({ hasText: '退出前处理未保存的内容' })

export async function openWorkMenuItem(page, name, item) {
  await root(page).getByRole('banner').getByRole('button', { name: `《${name}》作品菜单` }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export async function backToLibrary(page, name) {
  await root(page).getByRole('banner').getByRole('button', { name: `《${name}》作品菜单` }).click()
  await page.getByRole('menuitem', { name: '回到书房' }).click()
  await shelf(page).waitFor({ state: 'visible' })
}

export function isTopmost(locator) {
  return locator.evaluate(element => {
    const probe = document.createElement('style')
    probe.textContent = '* { pointer-events: auto !important; }'
    document.head.append(probe)
    try {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    } finally { probe.remove() }
  })
}

export async function exposedEdge(page, lower, upper) {
  const probe = await lower.evaluate((element, upperElement) => {
    const l = element.getBoundingClientRect(), u = upperElement.getBoundingClientRect()
    const point = [[l.left + l.width / 2, l.top + 3], [l.left + l.width / 2, l.bottom - 3], [l.left + 3, l.top + l.height / 2], [l.right - 3, l.top + l.height / 2]]
      .find(([x, y]) => x < u.left || x > u.right || y < u.top || y > u.bottom)
    if (!point) return null
    const style = document.createElement('style')
    style.textContent = '* { pointer-events: auto !important; }'
    document.head.append(style)
    try {
      return { point, paper: [u.left + u.width / 2, u.top + 3], hit: document.elementFromPoint(point[0], point[1])?.getAttribute('class') ?? '', scale: devicePixelRatio }
    } finally { style.remove() }
  }, await upper.elementHandle())
  if (!probe) return null
  const image = decodePng(await page.screenshot({ animations: 'disabled' }))
  const luma = ([x, y]) => {
    const offset = (Math.round(y * probe.scale) * image.width + Math.round(x * probe.scale)) * 4
    const [r, g, b] = image.pixels.subarray(offset, offset + 3)
    return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
  }
  return { hit: probe.hit, edgeLuma: luma(probe.point), paperLuma: luma(probe.paper) }
}

export async function landing(page) {
  const crumbs = await page.getByRole('navigation', { name: '位置' }).locator('span').allInnerTexts().catch(() => [])
  const empty = await root(page).getByRole('heading', { name: '从流程脊选一步开始' }).count()
  return { crumbs, empty: empty > 0 }
}

export const proseSearch = page => root(page).locator('.stage-content .cm-search')

export function spineLayout(page) {
  return spine(page).evaluate(nav => {
    const setup = nav.querySelector('[data-stage="setup"]')
    const name = setup.querySelector('.stage-row-name').getBoundingClientRect()
    const meta = setup.querySelector('.stage-row-meta').getBoundingClientRect()
    return {
      ringRadius: setup.querySelector('.stage-ring circle')?.getAttribute('r') ?? null,
      setupMetaBelowName: meta.top >= name.bottom - 1,
      resourceIconsFollowRow: [...nav.querySelectorAll('[data-resource]')]
        .every(row => getComputedStyle(row.querySelector('svg')).color === getComputedStyle(row).color),
    }
  })
}

export function primaryButtons(page) {
  return root(page).locator('.pi-btn--primary').evaluateAll(buttons => buttons
    .filter(button => button.getClientRects().length > 0)
    .map(button => button.textContent.trim()))
}

export const modelMissingNotice = page => root(page).getByRole('status').filter({ hasText: '还没有连接 AI 模型' })

export function overviewBars(page, name) {
  return overview(page, name).getByRole('list', { name: '阶段进度' }).locator('[data-stage]')
    .evaluateAll(rows => Object.fromEntries(rows.map(row => [row.dataset.stage, row.dataset.state])))
}

export const updateCard = page => root(page).getByRole('status', { name: '应用更新' })

export const setupOutline = page => root(page).getByRole('textbox', { name: /^核心大纲/ })
export const setupNext = page => root(page).getByRole('button', { name: /^下一步：故事架构/ })
export const setupFoot = page => root(page).locator('.stage-setup-foot')
export const setupHint = page => setupFoot(page).getByRole('status')
export const missingSetupLabels = page => root(page).locator('.stage-setup-label[data-missing]')
export const settingsNavElement = page => root(page).locator('.stage-set-nav')
export const legacySettings = page => root(page).locator('.stage-set-legacy')
export const setupFill = page => root(page).getByRole('button', { name: /^(AI 补全其余设定|AI 正在补全…)$/ })
export const setupDetailRow = (page, name) => root(page).locator('.stage-setup-row').filter({ has: page.getByText(name, { exact: true }) })
export const setupDetail = (page, name) => root(page).getByRole('region', { name: '设定细则' }).getByRole('textbox', { name, exact: true })
export const setupField = (page, name) => root(page).getByRole('combobox', { name: new RegExp(`^${escape(name)}`) })

export async function dirtySetup(page, addition = '还有一盏灯没有熄灭。') {
  const outline = setupOutline(page)
  await outline.fill(`${await outline.inputValue()}${addition}`)
  await saveStatus(page).filter({ hasText: '未保存' }).waitFor({ state: 'visible' })
}

export const toastStack = page => page.locator('.pi-toast-stack')
export const LIVE_TOAST = '.pi-toast:not([data-exiting])'
export const PRIMARY_BUTTON = '.pi-btn--primary'
export const SECONDARY_BUTTON_CLASS = 'pi-btn--secondary'
export const CONTENT_TAB = '.stage-tab'
export const WORK_NAME = ['.stage-work-name', '.stage-work-title']
export const WINDOW_CLOSE = '.stage-window-close'

export const STAGE_SHELL = SHELL

export async function waitForStage(page, timeout = 30_000) {
  await root(page).waitFor({ state: 'visible', timeout })
}

export async function dismissMigrationNotice(page) {
  const acknowledge = page.locator('.startup-migration-notice').getByRole('button', { name: '知道了', exact: true })
  if (await acknowledge.isVisible()) await acknowledge.click()
}

export async function showLibrary(page) {
  const workMenu = root(page).getByRole('banner').getByRole('button', { name: /作品菜单$/ })
  if (await workMenu.count() > 0 && await workMenu.first().isVisible()) {
    await workMenu.first().click()
    await page.getByRole('menuitem', { name: '回到书房' }).click()
  }
  await root(page).locator('.stage-library').waitFor({ state: 'visible' })
}

export async function importLegacyCopy(page) {
  const direct = root(page).getByRole('button', { name: '导入旧项目副本', exact: true })
  if (await direct.isVisible()) return direct.click()
  await root(page).getByRole('button', { name: /^导入/ }).first().click()
  await page.getByRole('menuitem', { name: '导入旧项目副本…' }).click()
}

export const workMenuButton = (page, name) => root(page).getByRole('banner').getByRole('button', { name: `《${name}》作品菜单` })

export async function waitForWork(page, name, timeout = 30_000) {
  await workMenuButton(page, name).waitFor({ state: 'visible', timeout })
  await spine(page).waitFor({ state: 'visible', timeout })
}

export async function openFromLibraryAt(page, name, index) {
  await shelf(page).getByRole('listitem').nth(index).getByRole('button', { name: `预览《${name}》` }).click()
  await overview(page, name).getByRole('button', { name: `打开《${name}》` }).click()
  await spine(page).waitFor({ state: 'visible' })
}

export async function openChapter(page, number) {
  if (!await chapterList(page).isVisible()) await stageButton(page, '正文').click()
  await chapterButton(page, number).click()
  await prose(page).waitFor({ state: 'visible' })
  return prose(page)
}

export async function saveWithCtrlS(page) {
  await saveStatus(page).filter({ hasText: /^未保存$/ }).waitFor({ state: 'visible' })
  await page.keyboard.press('ControlOrMeta+S')
  await saveStatus(page).filter({ hasText: /^已保存$/ }).waitFor({ state: 'visible' })
}

export async function saveProse(page) {
  await prose(page).click()
  await saveWithCtrlS(page)
}

export function proseBody(locator) {
  return locator.evaluate(element => Array.from(element.querySelectorAll('.cm-line'), line => {
    const copy = line.cloneNode(true)
    copy.querySelector('.cm-lp-paperhead')?.remove()
    return copy.textContent
  }).join('\n'))
}

export const versionSwitcherName = version => new RegExp(String.raw`^本章版本：\S+ v${version} · `)
export const versionItemText = version => new RegExp(String.raw`^\S+ v${version}(?: · 当前)?$`)

export async function openChapterVersion(page, number, version) {
  await openChapter(page, number)
  const switcher = root(page).getByRole('button', { name: /^本章版本：/ })
  if (!versionSwitcherName(version).test(await switcher.getAttribute('aria-label'))) {
    await switcher.click()
    await page.getByRole('menu', { name: '本章版本' }).getByRole('menuitemradio')
      .filter({ has: page.locator('span', { hasText: versionItemText(version) }) }).click()
    await root(page).getByRole('button', { name: versionSwitcherName(version) }).waitFor({ state: 'visible' })
  }
  await prose(page).waitFor({ state: 'visible' })
  return prose(page)
}
