import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const notifySwitch = page => page.getByRole('switch', { name: '在后台时通知我' })

export const M33SMALL_SCENARIOS = {
  'm33small-config-damaged': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, roots, onCleanup }) => {
    const recent = fs.readdirSync(roots.canonical, { recursive: true }).find(file => path.basename(file) === 'recent-projects.json')
    assert.ok(recent, '打开示例作品后全局数据目录里有最近项目文件')
    const config = path.join(roots.canonical, path.dirname(recent), 'config.json')
    const original = fs.existsSync(config) ? fs.readFileSync(config) : undefined
    onCleanup(() => original ? fs.writeFileSync(config, original) : fs.rmSync(config))
    fs.writeFileSync(config, '{"locale":')
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await notifySwitch(page).scrollIntoViewIfNeeded()
    await notifySwitch(page).click({ force: true })
    const alert = page.getByRole('alert').filter({ hasText: '后台通知设置保存失败' })
    await alert.waitFor({ state: 'visible' })
    const shown = (await alert.innerText()).trim()
    assert.equal(shown, '后台通知设置保存失败：全局配置文件已损坏，已拒绝覆盖。请修复或删除应用数据目录里的 config.json 后重试。')
    const switchOn = await notifySwitch(page).isChecked()
    assert.equal(switchOn, true, '保存失败后开关退回打开')
    assert.equal(fs.readFileSync(config, 'utf8'), '{"locale":', '损坏的配置文件没有被覆盖')
    return { shown, switchOn }
  } },
}
