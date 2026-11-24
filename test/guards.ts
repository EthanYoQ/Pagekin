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
  return MODULE_SUFFIXES.map(suffix => base + suffix).find(file => isFile(join(root, file)))
}

/** 仓库相对路径 file 经 test/ 下的模块能否走到 repoSourceFiles()；静态 import、动态 import、require 都算。 */
export function reachesRepoSourceFiles(root: string, file: string, seen = new Set<string>()): boolean {
  if (file === REPO_SOURCE_FILES_MODULE) return true
  if (seen.has(file)) return false
  seen.add(file)
  return ts.preProcessFile(readFileSync(join(root, file), 'utf8'), true, true).importedFiles.some(({ fileName }) => {
    const target = resolveRelative(root, file, fileName)
    return target !== undefined && target.startsWith('test/') && reachesRepoSourceFiles(root, target, seen)
  })
}

/** test:guards 的成员：经 repoSourceFiles() 扫仓库源码的测试文件。 */
export function guardTestFiles(): string[] {
  return ['electron', 'scripts', 'src', 'test'].flatMap(dir => repoSourceFiles(dir))
    .filter(file => TEST_FILE.test(file) && reachesRepoSourceFiles(REPO_ROOT, file))
}
