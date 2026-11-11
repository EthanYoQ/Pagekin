import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { it } from 'vitest'

const ROOT = 'scripts'
const KEYS = join(ROOT, 'redesign', 'keys.mjs')

function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : scripts(path)
    return entry.name.endsWith('.mjs') ? [path] : []
  })
}

it('驱动脚本不写死 Control+ 组合键：macOS 上应用快捷键认 Cmd，写死 Control 按下去不生效', () => {
  const offenders = scripts(ROOT).filter(file => file !== KEYS).flatMap(file =>
    readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
      /['"`]Control\+/.test(line) ? [`${relative(ROOT, file).replaceAll('\\', '/')}:${index + 1}`] : []))
  assert.deepEqual(offenders, [], `组合键写 ControlOrMeta+；移到正文首尾、重做用 redesign/keys.mjs 的 documentStartKey()、documentEndKey()、redoKey()。写死处：${offenders.join('、')}`)
})

it('正文首尾与重做的按键按平台选：macOS 用 Cmd+↑、Cmd+↓、Cmd+Shift+Z，其余平台用 Ctrl+Home、Ctrl+End、Ctrl+Y', async () => {
  const { documentStartKey, documentEndKey, redoKey } = await import('../keys.mjs')
  const platforms = ['darwin', 'win32', 'linux']
  assert.deepEqual(platforms.map(documentStartKey), ['Meta+ArrowUp', 'Control+Home', 'Control+Home'])
  assert.deepEqual(platforms.map(documentEndKey), ['Meta+ArrowDown', 'Control+End', 'Control+End'])
  assert.deepEqual(platforms.map(redoKey), ['Meta+Shift+z', 'Control+y', 'Control+y'])
})
