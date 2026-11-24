import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 列出仓库某目录下的全部文件（递归，跳过 node_modules），返回按字典序排好的仓库相对路径，分隔符一律为 /。
 * 测试扫仓库源码只经这里列目录；import 了它的测试就是 test:guards 的成员。
 */
export function repoSourceFiles(directory: string): string[] {
  const walk = (relative: string): string[] => readdirSync(join(REPO_ROOT, relative), { withFileTypes: true }).flatMap(entry => {
    const path = `${relative}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
    return [path]
  })
  return walk(directory.replace(/\\/gu, '/').replace(/\/+$/u, '')).sort()
}
