import type { ProjectData, ProjectSessionContext } from './ipc-channels'

let activeProjectSessionContext: ProjectSessionContext | null = null

export function isProjectSessionContext(value: unknown): value is ProjectSessionContext {
  if (!value || typeof value !== 'object') return false
  const context = value as Partial<ProjectSessionContext>
  return typeof context.projectId === 'string'
    && typeof context.leaseId === 'string'
    && typeof context.projectPath === 'string'
}

export function projectPathKey(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null

  let value = projectPath.trim().replace(/\//g, '\\')
  if (!value) return null

  if (value.startsWith('\\\\?\\')) {
    value = value.slice(4)
    if (value.toLocaleLowerCase('en-US').startsWith('unc\\')) {
      value = `\\\\${value.slice(4)}`
    }
  }

  const isUnc = value.startsWith('\\\\')
  const drive = !isUnc ? /^([A-Za-z]:)(\\|$)/.exec(value) : null
  const isAbsoluteDrive = !!drive && value.slice(2).startsWith('\\')
  const prefix = isUnc
    ? '\\\\'
    : drive
      ? isAbsoluteDrive ? `${drive[1]}\\` : drive[1]
      : ''
  const rawSegments = (isUnc
    ? value.slice(2)
    : drive
      ? value.slice(2).replace(/^\\+/, '')
      : value
  ).split('\\')
  const segments: string[] = []
  const protectedSegments = isUnc ? 2 : 0

  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > protectedSegments && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!prefix) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }

  const body = segments.join('\\')
  if (!body) return prefix.toLocaleLowerCase('en-US') || null
  if (!prefix) return body.toLocaleLowerCase('en-US')
  return `${prefix}${body}`.toLocaleLowerCase('en-US')
}

export function sameProjectPathKey(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftKey = projectPathKey(left)
  const rightKey = projectPathKey(right)
  return !!leftKey && leftKey === rightKey
}

export function projectSessionContextFromProject(
  project: Pick<ProjectData, 'id' | 'path' | 'sessionLease'> | null | undefined,
): ProjectSessionContext | null {
  if (!project?.id || !project.path || !project.sessionLease) return null
  return Object.freeze({
    projectId: project.id,
    leaseId: project.sessionLease,
    projectPath: project.path,
  })
}

export function setActiveProjectSessionContext(context: ProjectSessionContext | null): void {
  if (context && activeProjectSessionContext?.projectId === context.projectId
    && activeProjectSessionContext.leaseId === context.leaseId
    && activeProjectSessionContext.projectPath === context.projectPath) return
  activeProjectSessionContext = context
    ? Object.freeze({ ...context })
    : null
}

export function getActiveProjectSessionContext(): ProjectSessionContext | null {
  return activeProjectSessionContext
}

export function sameProjectSessionContext(
  left: ProjectSessionContext | null | undefined,
  right: ProjectSessionContext | null | undefined,
): boolean {
  return !!left
    && !!right
    && left.projectId === right.projectId
    && left.leaseId === right.leaseId
    && sameProjectPathKey(left.projectPath, right.projectPath)
}
