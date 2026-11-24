import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { REPO_ROOT, repoSourceFiles } from '../../../test/helpers/repo-source-files'

it('驱动脚本不写死 Control+ 组合键：macOS 上应用快捷键认 Cmd，写死 Control 按下去不生效', () => {
  const scripts = repoSourceFiles('scripts').filter(file => !file.includes('/__tests__/') && file.endsWith('.mjs') && file !== 'scripts/redesign/keys.mjs')
  const offenders = scripts.flatMap(file =>
    readFileSync(join(REPO_ROOT, file), 'utf8').split('\n').flatMap((line, index) =>
      /['"`]Control\+/.test(line) ? [`${file.slice('scripts/'.length)}:${index + 1}`] : []))
  assert.deepEqual(offenders, [], `组合键写 ControlOrMeta+；移到正文首尾、重做用 redesign/keys.mjs 的 documentStartKey()、documentEndKey()、redoKey()。写死处：${offenders.join('、')}`)
})

it('正文首尾与重做的按键按平台选：macOS 用 Cmd+↑、Cmd+↓、Cmd+Shift+Z，其余平台用 Ctrl+Home、Ctrl+End、Ctrl+Y', async () => {
  const { documentStartKey, documentEndKey, redoKey } = await import('../keys.mjs')
  const platforms = ['darwin', 'win32', 'linux']
  assert.deepEqual(platforms.map(documentStartKey), ['Meta+ArrowUp', 'Control+Home', 'Control+Home'])
  assert.deepEqual(platforms.map(documentEndKey), ['Meta+ArrowDown', 'Control+End', 'Control+End'])
  assert.deepEqual(platforms.map(redoKey), ['Meta+Shift+z', 'Control+y', 'Control+y'])
})
