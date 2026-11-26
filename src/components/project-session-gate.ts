import type { ProjectData, ProjectSessionContext } from '../shared/ipc-channels'
import {
  getActiveProjectSessionContext,
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'

type SessionProject = Pick<ProjectData, 'id' | 'path' | 'sessionLease'>

export function captureProjectSession(
  project: SessionProject | null | undefined,
): ProjectSessionContext | null {
  const candidate = projectSessionContextFromProject(project)
  if (!candidate) return null

  const active = getActiveProjectSessionContext()
  return sameProjectSessionContext(candidate, active) ? candidate : null
}

export function isProjectSessionCurrent(
  session: ProjectSessionContext | null | undefined,
): session is ProjectSessionContext {
  return !!session && sameProjectSessionContext(session, getActiveProjectSessionContext())
}

export function isProjectSessionPath(
  session: ProjectSessionContext | null | undefined,
  projectPath: string | null | undefined,
): boolean {
  return !!session && sameProjectPathKey(session.projectPath, projectPath)
}
