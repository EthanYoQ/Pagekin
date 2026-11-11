import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import type { CharacterRosterSnapshot } from '../../../shared/character-roster'
import { migrateLegacyCharacterRoster } from '../architecture-workflow'

const projectPath = 'C:\\novels\\legacy-roster'
const projectSession = {
  projectId: 'legacy-project',
  leaseId: 'legacy-lease',
  projectPath,
}

const pendingLegacyRoster: CharacterRosterSnapshot = {
  schemaVersion: 1,
  revision: 0,
  migrationState: 'legacy_markdown_pending',
  status: 'legacy_repair_required',
  entries: [],
  renderedMarkdown: '',
  projectionHash: '',
  factHash: '',
  nameOnlyFactHash: '',
  legacyMarkdown: '矿场事故后，沈砺与顾湘从互相怀疑走向共同调查。这里故意没有 Markdown 标题或角色列表。',
}

function activeProject() {
  return {
    id: projectSession.projectId,
    sessionLease: projectSession.leaseId,
    name: '旧项目',
    path: projectPath,
    novelConfig: { genre: '科幻' },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function installVela(invoke: (channel: string, ...args: unknown[]) => unknown) {
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke: vi.fn((channel: string, ...args: unknown[]) => {
        if (channel === 'fs:list-dir' && args[0] === `${projectPath}/.vela/skills`) {
          return Promise.resolve([])
        }
        if (channel === 'fs:check-exists') return Promise.resolve(false)
        return invoke(channel, ...args)
      }),
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
}


beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({ currentProject: activeProject() as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [] })
})

afterEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: null })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [] })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('legacy character roster repair public workflow seam', () => {
  it('英文界面下已有修复运行时再次发起修复，报错是英文', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'legacy-roster:read-source') return { snapshot: pendingLegacyRoster }
      if (channel === 'generation:list') return [{ operation: 'legacy-character-roster-repair', handle: { runId: 'earlier-repair' } }]
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    installVela(invoke)

    await expect(migrateLegacyCharacterRoster(projectPath)).rejects
      .toThrow('A legacy cast repair run already exists. View or resume it explicitly; starting over is a separate choice.')
  })

  it('英文界面下修复确认后旧版角色名单换了修复方式：报英文说明，不报内部错误码（#408）', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    let reads = 0
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'legacy-roster:read-source') {
        reads += 1
        return { snapshot: reads === 1 ? pendingLegacyRoster : { ...pendingLegacyRoster, migrationState: 'legacy_cards_preserved' } }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    installVela(invoke)

    const failure = await migrateLegacyCharacterRoster(projectPath).then(() => null, (error: unknown) => error as Error)
    expect(failure?.message).not.toMatch(/LEGACY_ROSTER_|\p{Script=Han}/u)
    expect(failure?.message).toMatch(/legacy cast/)
  })
})
