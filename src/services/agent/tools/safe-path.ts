export function safePath(projectRoot: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/')

  const segments = normalized.split('/')
  const resolvedSegments: string[] = []

  for (const seg of segments) {
    if (seg === '' || seg === '.') {
      continue
    }
    if (seg === '..') {
      if (resolvedSegments.length === 0) {
        return null
      }
      resolvedSegments.pop()
    } else {
      resolvedSegments.push(seg)
    }
  }

  const resolvedRelative = resolvedSegments.join('/')
  const fullPath = `${projectRoot}/${resolvedRelative}`

  if (!fullPath.startsWith(projectRoot)) {
    return null
  }

  return fullPath
}

export function validatePath(
  projectRoot: string,
  relativePath: string,
): { valid: true; fullPath: string } | { valid: false; error: string } {
  if (!relativePath) {
    return { valid: false, error: '缺少文件路径参数' }
  }

  const result = safePath(projectRoot, relativePath)
  if (result === null) {
    return { valid: false, error: `路径越界：「${relativePath}」超出了项目目录范围。只能访问项目内的文件。` }
  }

  return { valid: true, fullPath: result }
}
