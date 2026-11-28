import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { guardTestFiles, reachesRepoSourceFiles, REPO_SOURCE_FILES_MODULE } from './guards'
import { REPO_ROOT, repoSourceFiles } from './helpers/repo-source-files'
import { listTemporaryDirectory } from './helpers/temporary-directory'
import BASELINE from './directory-listing-baseline.json'
import FAILURE_BASELINE from './legacy-failure-baseline.json'
import {
  currentLegacyFailureCounts, failureRewrites, failureTypeAssertions, legacyFailureCounts, legacySum, rawTextInNoteArguments, removedFailureEntries, scanProduction,
  type LegacyFailureCounts,
} from './helpers/legacy-failure-scan'

const eslint = new ESLint({ cwd: REPO_ROOT })

async function listingErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) })
  return result!.messages.filter(message => message.message.includes('repoSourceFiles()')).map(message => message.message)
}

function withFixture(files: Record<string, string>, check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'guards-'))
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('repoSourceFiles()', () => {
  it('递归列出仓库目录下的文件，返回排好序、以 / 分隔的仓库相对路径', () => {
    const files = repoSourceFiles('test')
    expect(files).toContain(REPO_SOURCE_FILES_MODULE)
    expect(files).toContain('test/helpers/__tests__/review-cycle-fixture.test.ts')
    expect(files).toEqual([...files].sort())
    expect(files.filter(file => file.includes('\\') || !file.startsWith('test/'))).toEqual([])
  })
})

describe('listTemporaryDirectory()', () => {
  it('列 os.tmpdir() 下测试自建的目录', () => {
    withFixture({ 'a.txt': '', 'sub/b.txt': '' }, root => {
      expect(listTemporaryDirectory(root).map(entry => `${entry.name}:${entry.isDirectory()}`).sort()).toEqual(['a.txt:false', 'sub:true'])
    })
  })

  it('传仓库路径就抛错，并指向 repoSourceFiles()', () => {
    expect(() => listTemporaryDirectory(REPO_ROOT)).toThrow(/repoSourceFiles\(\)/u)
    expect(() => listTemporaryDirectory(join(REPO_ROOT, 'src'))).toThrow(/repoSourceFiles\(\)/u)
    expect(() => listTemporaryDirectory(tmpdir())).toThrow(/os\.tmpdir\(\)/u)
  })

  it('仓库本身在 os.tmpdir() 下时，仓库路径照样抛错', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guards-checkout-'))
    try {
      mkdirSync(join(root, 'test/helpers'), { recursive: true })
      mkdirSync(join(root, 'src'))
      for (const file of ['test/helpers/repo-source-files.ts', 'test/helpers/temporary-directory.ts']) writeFileSync(join(root, file), readFileSync(join(REPO_ROOT, file)))
      const copy: typeof import('./helpers/temporary-directory') = await import(pathToFileURL(join(root, 'test/helpers/temporary-directory.ts')).href)
      expect(() => copy.listTemporaryDirectory(join(root, 'src'))).toThrow(/repoSourceFiles\(\)/u)
      expect(() => copy.listTemporaryDirectory(root)).toThrow(/repoSourceFiles\(\)/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('test:guards 的成员是经 repoSourceFiles() 扫源码的测试', () => {
  const helper = 'export function repoSourceFiles() { return [] }\n'

  it('直接 import、经 test/ 下的辅助模块 import、动态 import 都算；没走到它的不算', () => {
    withFixture({
      [REPO_SOURCE_FILES_MODULE]: helper,
      'test/helpers/scan.ts': "export { repoSourceFiles as list } from './repo-source-files'\n",
      'src/__tests__/direct.test.ts': "import { repoSourceFiles } from '../../test/helpers/repo-source-files'\n",
      'src/__tests__/via-helper.test.ts': "import { list } from '../../test/helpers/scan'\n",
      'scripts/__tests__/dynamic.test.mjs': "const { repoSourceFiles } = await import('../../test/helpers/repo-source-files.ts')\n",
      'src/__tests__/js-extension.test.ts': "import { repoSourceFiles } from '../../test/helpers/repo-source-files.js'\n",
      'src/__tests__/unrelated.test.ts': "import { readFileSync } from 'node:fs'\nimport { x } from '../x'\n",
      'src/x.ts': "export { repoSourceFiles as x } from '../test/helpers/repo-source-files'\n",
    }, root => {
      const member = (file: string) => reachesRepoSourceFiles(root, file)
      expect(['src/__tests__/direct.test.ts', 'src/__tests__/via-helper.test.ts', 'scripts/__tests__/dynamic.test.mjs', 'src/__tests__/js-extension.test.ts'].filter(member)).toHaveLength(4)
      expect(member('src/__tests__/unrelated.test.ts')).toBe(false)
    })
  })

  it('仓库里扫源码的测试都在成员里，只读固定文件或只用临时目录的不在', () => {
    const members = guardTestFiles()
    expect(members).toEqual(expect.arrayContaining([
      'test/guards.test.ts',
      'electron/controllers/__tests__/external-file-grant-controller.test.ts',
      'scripts/redesign/__tests__/issue-scenarios-docs.test.mjs',
      'src/shared/__tests__/review-proof.test.ts',
    ]))
    expect(members).not.toContain('electron/controllers/__tests__/import-controller-secure-file.test.ts')
    expect(members.filter(file => BASELINE.includes(file))).toEqual([])
  })

  it('不扫源码、但守着跨模块不变式的测试按名字登记，改名或删掉就红', () => {
    const members = guardTestFiles()
    expect(members).toEqual(expect.arrayContaining([
      'electron/__tests__/startup-native-isolation.test.ts',
      'electron/services/__tests__/live-row-sentinel.test.ts',
    ]))
    expect(members.filter(file => !existsSync(join(REPO_ROOT, file)))).toEqual([])
  })
})

describe('测试文件按标识符禁用列目录原语', () => {
  const probe = 'src/__tests__/listing-probe.test.ts'

  it.each([
    "import fs from 'node:fs'\nfs.readdirSync('.')",
    "import * as fs from 'node:fs'\nfs.readdirSync(process.cwd())",
    "import { readdirSync } from 'node:fs'",
    "import { readdirSync as ls } from 'fs'",
    "import { readdir } from 'node:fs/promises'",
    "import fs from 'node:fs'\nawait fs.promises.opendir('.')",
    "import fs from 'node:fs'\nfs.globSync('src/**/*.css')",
    "const { readdirSync } = require('node:fs')",
    "import fg from 'fast-glob'",
    "import { globSync } from 'glob'",
    "const glob = require('glob')",
    "await import('tinyglobby')",
    "import ts from 'typescript'\nts.sys.readDirectory('src')",
    "import.meta.glob('./*.ts')",
  ])('报错并点名 helper：%s', async code => {
    expect(await listingErrors(probe, code)).not.toEqual([])
    expect(await listingErrors('scripts/__tests__/listing-probe.test.mjs', code)).not.toEqual([])
  })

  it.each([
    "import { readFileSync } from 'node:fs'\nreadFileSync('src/styles/app.css', 'utf8')",
    "import fs from 'node:fs'\nimport { vi } from 'vitest'\nvi.spyOn(fs, 'readdirSync')",
    'const fakeFs = { readdirSync: () => [] }',
  ])('不读目录的写法不报：%s', async code => {
    expect(await listingErrors(probe, code)).toEqual([])
  })

  it('两个 helper 自己和生产代码不受限，其余 test/helpers 受限', async () => {
    const code = "import { readdirSync } from 'node:fs'\nreaddirSync('.')"
    expect(await listingErrors(REPO_SOURCE_FILES_MODULE, code)).toEqual([])
    expect(await listingErrors('test/helpers/temporary-directory.ts', code)).toEqual([])
    expect(await listingErrors('src/listing-probe.ts', code)).toEqual([])
    expect(await listingErrors('test/helpers/listing-probe.ts', code)).not.toEqual([])
  })

  it('新建一个直接列仓库根的测试文件就报错', async () => {
    const code = "import fs from 'node:fs'\nimport { it } from 'vitest'\nit('x', () => { fs.readdirSync(process.cwd()) })\n"
    expect(await listingErrors('src/__tests__/new-scan.test.ts', code)).toEqual([expect.stringContaining('repoSourceFiles()')])
  })

  it('不在 baseline 里的测试文件都受这条规则约束，后面的覆盖块没把它冲掉', async () => {
    const exempt = new Set([REPO_SOURCE_FILES_MODULE, 'test/helpers/temporary-directory.ts', ...BASELINE])
    const testFiles = ['electron', 'scripts', 'src', 'test'].flatMap(dir => repoSourceFiles(dir))
      .filter(file => /\.(?:test|spec)\.|\/__tests__\/|^test\//u.test(file) && /\.(?:ts|tsx|mjs)$/u.test(file) && !exempt.has(file))
    const unguarded: string[] = []
    for (const file of testFiles) {
      if ((await listingErrors(file, "import { opendirSync } from 'node:fs'\nopendirSync('.')\n")).length === 0) unguarded.push(file)
    }
    expect(unguarded).toEqual([])
  }, 120_000)
})

describe('存量 baseline 只减不增', () => {
  it('名单排好序、不重复（只减不增由 scripts/check-baseline-shrink.mjs 对比基准提交核对）', () => {
    expect(BASELINE).toEqual([...new Set(BASELINE)].sort())
  })

  it('名单里每个文件仍在直接用列目录原语，改掉的要从名单删除', async () => {
    const stale: string[] = []
    for (const file of BASELINE) {
      const name = posix.basename(file)
      const probe = posix.join(posix.dirname(file), `listing-probe${name.slice(name.indexOf('.'))}`)
      if ((await listingErrors(probe, readFileSync(join(REPO_ROOT, file), 'utf8'))).length === 0) stale.push(file)
    }
    expect(stale).toEqual([])
  }, 60_000)

  it('测试范围内没有 lint 不检查的扩展名（全仓 lint 只跑 ts、tsx、mjs）', () => {
    const unlinted = ['electron', 'scripts', 'src', 'test'].flatMap(dir => repoSourceFiles(dir))
      .filter(file => /\.(?:test|spec)\.|\/__tests__\/|^test\//u.test(file) && /\.(?:js|cjs|mts|cts|jsx)$/u.test(file))
    expect(unlinted).toEqual([])
  })
})

describe('失败的码与说明（#844）', () => {
  const ORIGINAL_LEGACY_TOTAL = 154 + 27 + 19 + 27
  const baseline = FAILURE_BASELINE as LegacyFailureCounts
  const legacyTotal = (counts: LegacyFailureCounts) => Object.values(counts).reduce((sum, perFile) => sum + legacySum(perFile), 0)

  it('旧约定只减不增', () => {
    expect(legacyTotal(baseline)).toBeLessThanOrEqual(ORIGINAL_LEGACY_TOTAL)
    expect(currentLegacyFailureCounts(), '旧约定的调用数变了：新增改用 failureText，删掉的从 test/legacy-failure-baseline.json 减下来').toEqual(baseline)
  })

  it('旧约定按合计比较：种类互换合计不变放行，合计变大拦下', () => {
    const before = { 'src/a.ts': { displayedErrorMessage: 1, appErrorMessage: 1 } }
    expect(legacyTotal({ 'src/a.ts': { knownAppErrorMessage: 1, appErrorMessage: 1, authorOwned: 4 } })).toBe(legacyTotal(before))
    expect(legacyTotal({ 'src/a.ts': { displayedErrorMessage: 1, appErrorMessage: 1, knownAppErrorMessage: 1 } })).toBeGreaterThan(legacyTotal(before))
  })

  it('计数认调用，不认定义和别的写法', () => {
    expect(legacyFailureCounts('src/x.ts', [
      'export function displayedErrorMessage() {}',
      'displayedErrorMessage(locale, error)',
      'errors.appErrorMessage(locale, error)',
      'const note = authorOwned(name)',
      'const legacy = 1',
    ].join('\n'))).toEqual({ displayedErrorMessage: 1, appErrorMessage: 1, authorOwned: 1 })
  })

  it('旧失败约定的入口不存在', () => {
    expect(scanProduction(removedFailureEntries).flatMap(([, found]) => found)).toEqual([])
    for (const planted of [
      'englishWithReason(locale, text, reason)',
      'import type { LegacyReason } from "./failure"',
      'const keys = WIRE_EXCLUDED_KEYS',
      "translate(locale, 'error.unknown', { message })",
      "import DIRECT_CHANNELS from './direct-channels.json'",
      'authorError(locale, { note, because: { legacy: error.message } })',
      'const merged = { ...base, legacy: text }',
    ]) expect(removedFailureEntries('src/x.ts', planted), planted).not.toEqual([])
    for (const allowed of [
      "const SOURCE = { author: 'author', derived: 'finalized', legacy: 'legacy' }",
      "translate(locale, 'error.unregisteredCode')",
      'const legacy = 1',
    ]) expect(removedFailureEntries('src/x.ts', allowed), allowed).toEqual([])
  })

  it('direct-channels.json 不存在，CI 与守卫不读它', () => {
    expect(existsSync(join(REPO_ROOT, 'electron/ipc/direct-channels.json'))).toBe(false)
    const readers = ['src', 'electron', 'scripts', '.github', 'test'].flatMap(dir => repoSourceFiles(dir))
      .filter(file => file !== 'test/helpers/legacy-failure-scan.ts' && file !== 'test/guards.test.ts')
      .filter(file => readFileSync(join(REPO_ROOT, file), 'utf8').includes('direct-channels'))
    expect(readers).toEqual([])
  })

  it('authorOwned( 的参数不许含异常原文', () => {
    expect(scanProduction(rawTextInNoteArguments).flatMap(([, found]) => found)).toEqual([])
    for (const planted of ['authorOwned(error.message)', 'authorOwned(String(error))', 'authorOwned(`第 ${error.stack} 行`)', 'authorOwned(String (error))', 'authorOwned(error["message"])', "authorOwned(error?.['stack'])"]) {
      expect(rawTextInNoteArguments('src/x.ts', planted), planted).toHaveLength(1)
    }
    expect(rawTextInNoteArguments('src/x.ts', 'writtenNote(error.message)')).toHaveLength(1)
    expect(rawTextInNoteArguments('src/x.ts', 'authorOwned(material.fileName)')).toEqual([])
    expect(rawTextInNoteArguments('src/x.ts', 'authorOwned(`Chapter ${title}`)')).toEqual([])
  })

  it('过 IPC 的参数不含异常原文', () => {
    for (const planted of [
      "wireNote('error.importRunCheckFailed', { code: authorOwned(error.message) })",
      "wireNote('error.importRunCheckFailed', { code: authorOwned(String(error)) })",
      "wireNote('error.importRunCheckFailed', { code: authorOwned(`${error.stack}`) })",
      "wireNote('error.importRunCheckFailed', { code: authorOwned(error['message']) })",
      "wireNote('error.importRunCheckFailed', { code: authorOwned(error.toString()) })",
      "try {} catch (error) { wireNote('error.importRunCheckFailed', { code: authorOwned(`${error}`) }) }",
      "try {} catch (caught) { wireNote('error.importRunCheckFailed', { code: authorOwned(`${(caught)}`) }) }",
    ]) expect(rawTextInNoteArguments('electron/x.ts', planted), planted).toHaveLength(1)
    expect(rawTextInNoteArguments('electron/x.ts', "wireNote('error.projectPathTooDeepForDatabase', { max: error.maxProjectRootLength })")).toEqual([])
    expect(rawTextInNoteArguments('electron/x.ts', "wireNote('error.importRunCheckFailed', { code: authorOwned(material.fileName) })")).toEqual([])
  })

  it('造完错误不再改码或 message', () => {
    expect(scanProduction(failureRewrites).flatMap(([, found]) => found)).toEqual([])
    for (const planted of [
      'Object.assign(error, { code })', "Object.assign(error, { errorCode: 'X_Y' })", 'Object.assign(new Error(text), { message: other })', "error.code = 'X_Y'", 'failure.message = text',
      "error['message'] = text", "error['code'] = 'X_Y'", "error['errorCode'] = 'X_Y'",
    ]) {
      expect(failureRewrites('src/x.ts', planted), planted).toHaveLength(1)
    }
    for (const allowed of ['this.code = code', "this['message'] = text", "state['status'] = 'done'", 'error[field] = text', 'Object.assign(state, { status })']) {
      expect(failureRewrites('src/x.ts', allowed), allowed).toEqual([])
    }
    expect(failureRewrites('electron/x.ts', 'Object.assign(new Error(code), { code })')).toEqual([])
  })

  it('复合赋值和包了一层的左值也算改码或 message', () => {
    for (const planted of [
      "error.code += '_X'", "error.code ??= 'X_Y'", 'error.message ||= text', 'error.message &&= text', "error['message'] += text",
      "(error.code) = 'X_Y'", "(error.code as string) = 'X_Y'", "error.code! = 'X_Y'",
    ]) expect(failureRewrites('src/x.ts', planted), planted).toHaveLength(1)
    for (const allowed of ['this.code ??= code', "this['message'] += text", "state['status'] ??= 'done'", 'count += 1']) {
      expect(failureRewrites('src/x.ts', allowed), allowed).toEqual([])
    }
  })

  it('catch 变量本身以值的形式进说明参数也算异常原文，包一层断言或逗号也认得出', () => {
    for (const argument of [
      'e', 'e as string', '<string>e', 'e!', 'e satisfies unknown', '(0, e)', '`${e as string}`', '`${e!}`', "'失败：' + e", "ok ? e : '失败'", "e ?? '失败'",
    ]) {
      const planted = `try {} catch (e) { authorOwned(${argument}) }`
      expect(rawTextInNoteArguments('src/x.ts', planted), planted).toHaveLength(1)
    }
    for (const argument of ['e.fileName', 'describe(e)', "e === undefined ? '甲' : '乙'", 'files[e.index]']) {
      const allowed = `try {} catch (e) { authorOwned(${argument}) }`
      expect(rawTextInNoteArguments('src/x.ts', allowed), allowed).toEqual([])
    }
  })

  it('回调参数和 catch 变量同名时，用的是回调参数，不算异常原文', () => {
    for (const allowed of [
      'try {} catch (error) { items.map(error => authorOwned(`${error}`)) }',
      'try {} catch (error) { items.map(function (error) { return authorOwned(error) }) }',
      'try {} catch (error) { items.map(({ error }) => authorOwned(error)) }',
    ]) expect(rawTextInNoteArguments('src/x.ts', allowed), allowed).toEqual([])
    expect(rawTextInNoteArguments('src/x.ts', 'try {} catch (error) { items.map(item => authorOwned(`${item}: ${error}`)) }')).toHaveLength(1)
    expect(rawTextInNoteArguments('src/x.ts', 'try {} catch (error) { ({ [authorOwned(`${error}`)](error: unknown) {} }) }')).toHaveLength(1)
  })

  it('断言成 AuthorNote、Failure 或作者数据只许在 src/shared/failure.ts 和测试里', () => {
    expect(scanProduction(failureTypeAssertions).flatMap(([, found]) => found)).toEqual([])
    for (const planted of ['value as AuthorNote', 'value as unknown as Failure', '<Failure>value', 'value as Failure | undefined', 'text as AuthorOwned', 'params as NoteParams']) {
      expect(failureTypeAssertions('src/x.ts', planted), planted).toHaveLength(1)
    }
    expect(failureTypeAssertions('src/shared/failure.ts', 'value as FailureCode')).toEqual([])
  })
})
