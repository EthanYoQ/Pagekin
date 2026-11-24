import { readdirSync, realpathSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const isInside = (parent: string, child: string) => {
  const inside = relative(realpathSync.native(parent), child)
  return inside === '' || (inside.split(sep)[0] !== '..' && !isAbsolute(inside))
}

export function listTemporaryDirectory(directory: string): Dirent[] {
  const target = realpathSync.native(resolve(directory))
  if (target === realpathSync.native(tmpdir()) || !isInside(tmpdir(), target) || isInside(REPO_ROOT, target)) {
    throw new Error(`listTemporaryDirectory 只列 os.tmpdir() 下的目录，列仓库源码改用 repoSourceFiles()：${directory}`)
  }
  return readdirSync(directory, { withFileTypes: true })
}
