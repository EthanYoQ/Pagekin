import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { it } from 'vitest'

const ROOT = 'scripts/redesign'

function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : scripts(path)
    return entry.name.endsWith('.mjs') ? [path] : []
  })
}

it('驱动脚本不写死 Control+ 组合键：macOS 上应用快捷键认 Cmd，写死 Control 按下去不生效', () => {
  const offenders = scripts(ROOT).filter(file => !file.endsWith('keys.mjs')).flatMap(file =>
    readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
      /['"`]Control\+/.test(line) ? [`${relative(ROOT, file).replaceAll('\\', '/')}:${index + 1}`] : []))
  assert.deepEqual(offenders, [], '组合键写 ControlOrMeta+；移到正文末尾用 keys.mjs 的 documentEndKey()')
})

it('移到正文末尾的按键按平台选：macOS 用 Cmd+↓，其余平台用 Ctrl+End', async () => {
  const { documentEndKey } = await import('../keys.mjs')
  assert.deepEqual(['darwin', 'win32', 'linux'].map(documentEndKey), ['Meta+ArrowDown', 'Control+End', 'Control+End'])
})
