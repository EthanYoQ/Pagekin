import type { NovelConfig, ProjectSessionContext } from '../shared/ipc-channels'
import type { GenerationRecoveryContext } from '../shared/generation-owner-contract'
import { CANONICAL_PROJECT_DIRECTORY } from '../shared/project-format'
import { outlineProgress } from '../shared/plot-outline-checkpoint'
import type { PlotOutlineRangeSource } from '../shared/plot-outline-contract'
import { resolveWritingLanguage } from '../shared/writing-language'
import { ipc } from './ipc-client'
import { judgeArchCore } from './architecture-step-selection'
import { architectureRecoveryHandle } from '../shared/architecture-recovery-navigation'
import { planningRecoverable } from '../shared/planning-recovery'

export async function readArchCheckpointWithOutline(projectSession: ProjectSessionContext): Promise<{
  checkpoint: Record<string, unknown> | undefined
  outline: GenerationRecoveryContext | null
}> {
  const { projectPath } = projectSession
  const result = await ipc.invokeWithProjectSession(projectSession, 'fs:read-json', `${projectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`, projectPath)
    .catch(() => null)
  const checkpoint = result?.success === true ? (result as { data?: Record<string, unknown> }).data : undefined
  const handle = architectureRecoveryHandle(checkpoint, 'synopsis', projectSession.projectId)
  if (!checkpoint || !handle) return { checkpoint, outline: null }
  const outline = await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle }).catch(() => null)
  if (!outline?.plotOutlineRecovery || planningRecoverable(outline)) return { checkpoint, outline }
  return { checkpoint: Object.fromEntries(Object.entries(checkpoint).filter(([key]) => !key.startsWith('synopsis_'))), outline }
}

export async function readArchCheckpoint(projectSession: ProjectSessionContext): Promise<Record<string, unknown> | undefined> {
  return (await readArchCheckpointWithOutline(projectSession)).checkpoint
}

export function archOutlineSource(
  core: { synopsis?: string | null; totalChapters?: number | null; writingLanguage?: string | null } | null | undefined,
  novelConfig?: Pick<NovelConfig, 'totalChapters' | 'writingLanguage'>,
): PlotOutlineRangeSource {
  return {
    synopsis: core?.synopsis ?? '',
    totalChapters: Number(core?.totalChapters ?? novelConfig?.totalChapters) || 0,
    writingLanguage: resolveWritingLanguage(core?.writingLanguage ?? novelConfig?.writingLanguage),
  }
}

export async function checkArchStatus(
  projectSession: ProjectSessionContext,
): Promise<Record<string, boolean>> {
  const status: Record<string, boolean> = {
    premise: false,
    characters: false,
    worldbuilding: false,
    synopsis: false,
  }

  const [core, roster] = await Promise.all([
    ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      projectSession.projectPath,
    ),
    ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      projectSession.projectPath,
    ),
  ])
  if (!core) return status

  status.premise = (core.premise?.length ?? 0) > 50
  status.characters = roster.status === 'ready'
  status.worldbuilding = (core.worldbuilding?.length ?? 0) > 50
  status.synopsis = (core.synopsis?.length ?? 0) > 50

  return status
}

export async function checkArchConfirmed(
  projectSession: ProjectSessionContext,
  novelConfig?: Pick<NovelConfig, 'totalChapters' | 'writingLanguage'>,
): Promise<Record<string, boolean>> {
  const { projectPath } = projectSession
  const [core, roster, checkpoint] = await Promise.all([
    ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath),
    ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectPath),
    readArchCheckpoint(projectSession),
  ])
  if (!core) return { premise: false, characters: false, worldbuilding: false, synopsis: false }
  const { synopsis, totalChapters, writingLanguage } = archOutlineSource(core, novelConfig)
  const progress = outlineProgress(synopsis, checkpoint, writingLanguage, totalChapters)
  return { ...judgeArchCore(core, progress.kind).confirmed, characters: roster.status === 'ready' }
}

export async function getBlueprintCount(projectSession: ProjectSessionContext): Promise<number> {
  try {
    const blueprints = await ipc.invokeWithProjectSession(
      projectSession,
      'db:blueprint-get-all',
      projectSession.projectPath,
    )
    return blueprints.length
  } catch {
    return 0
  }
}
