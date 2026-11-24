import { readdirSync, realpathSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function listTemporaryDirectory(directory: string): Dirent[] {
  const inside = relative(realpathSync.native(tmpdir()), realpathSync.native(resolve(directory)))
  if (inside === '' || inside.split(sep)[0] === '..' || isAbsolute(inside)) {
    throw new Error(`listTemporaryDirectory 只列 os.tmpdir() 下的目录，列仓库源码改用 repoSourceFiles()：${directory}`)
  }
  return readdirSync(directory, { withFileTypes: true })
}
