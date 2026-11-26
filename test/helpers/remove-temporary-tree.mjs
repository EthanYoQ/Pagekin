import fs from 'node:fs'
import path from 'node:path'

const isStrictlyInside = (child, parent) => {
  const relative = path.relative(parent, child)
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative)
}

function detachLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) fs.unlinkSync(file)
    else if (entry.isDirectory()) detachLinks(file)
  }
}

export function removeTemporaryTree(target, parent) {
  if (!fs.existsSync(target)) return
  const realTarget = fs.realpathSync.native(target)
  const realParent = fs.existsSync(parent) ? fs.realpathSync.native(parent) : path.resolve(parent)
  if (!isStrictlyInside(realTarget, realParent)) {
    throw new Error(`Refusing to remove ${path.resolve(target)}: it is not inside ${realParent}`)
  }
  detachLinks(realTarget)
  fs.rmSync(realTarget, { recursive: true, force: true })
}
