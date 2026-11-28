import { readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'
import { REPO_ROOT, repoSourceFiles } from './helpers/repo-source-files.ts'

export const REPO_SOURCE_FILES_MODULE = 'test/helpers/repo-source-files.ts'
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const MODULE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts']

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false

function resolveRelative(root: string, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.join(posix.dirname(from), specifier)
  const sources = [base.replace(/\.js$/u, '.ts'), base.replace(/\.jsx$/u, '.tsx'), base.replace(/\.mjs$/u, '.mts')]
  return [...MODULE_SUFFIXES.map(suffix => base + suffix), ...sources].find(file => isFile(join(root, file)))
}

export function reachesRepoSourceFiles(root: string, file: string, seen = new Set<string>()): boolean {
  if (file === REPO_SOURCE_FILES_MODULE) return true
  if (seen.has(file)) return false
  seen.add(file)
  return ts.preProcessFile(readFileSync(join(root, file), 'utf8'), true, true).importedFiles.some(({ fileName }) => {
    const target = resolveRelative(root, file, fileName)
    return target !== undefined && target.startsWith('test/') && reachesRepoSourceFiles(root, target, seen)
  })
}

/** 不经 repoSourceFiles() 扫源码，按 import 推断不出来，但守着跨模块不变式的测试。 */
const NAMED_GUARD_TESTS = [
  'electron/__tests__/startup-native-isolation.test.ts',
  'electron/services/__tests__/live-row-sentinel.test.ts',
]

export function guardTestFiles(): string[] {
  const scanning = ['electron', 'scripts', 'src', 'test'].flatMap(dir => repoSourceFiles(dir))
    .filter(file => TEST_FILE.test(file) && reachesRepoSourceFiles(REPO_ROOT, file))
  return [...new Set([...scanning, ...NAMED_GUARD_TESTS])]
}
