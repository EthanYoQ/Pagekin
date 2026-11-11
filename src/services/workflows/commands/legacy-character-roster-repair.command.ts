import { createLegacyRosterGeneration } from '../../legacy-roster-generation'
import { formatCharacterProposalPreview } from '../character-proposal-preview'
import { routeModelId } from '../../model-routing'
import { pinWorkflowModel } from '../workflow-main-generation'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import { BaseWorkflowCommand, type CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../ipc-client'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
  sameProjectPathKey,
} from '../../../shared/project-session-context'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'
import { globalEventBus } from '../../../shared/event-bus'

type UiText = (zhCN: string, enUS: string) => string

function assertLegacyRepairSessionCurrent(projectSession: CommandExecuteParams['context']['projectSession'], text: UiText): void {
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) {
    throw new Error(text('当前项目已切换，旧版角色名单修复已停止以避免写入错误项目', 'The project changed, so the legacy cast repair stopped to avoid writing to the wrong project.'))
  }
}

export interface LegacyCharacterRosterRepairInput {
  expectedProjectPath: string
  recoveryHandle?: MainGenerationRunHandle
  restart?: boolean
  expectedMode?: 'existing' | 'model'
}

export class RepairLegacyCharacterRosterCommand extends BaseWorkflowCommand<string> {
  constructor(private readonly input: LegacyCharacterRosterRepairInput) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const session = requireWorkflowProjectSession(context)
    const text: UiText = (zh, en) => workflowUiText(context, zh, en)
    if (!sameProjectPathKey(session.projectPath, this.input.expectedProjectPath)) throw new Error(text('当前项目已切换，旧版角色名单修复已停止以避免写入错误项目', 'The project changed, so the legacy cast repair stopped to avoid writing to the wrong project.'))
    assertLegacyRepairSessionCurrent(session, text)
    this.assertNotCancelled(context)
    const source = this.input.recoveryHandle ? undefined : await ipc.invokeWithProjectSession(session, 'legacy-roster:read-source')
    assertLegacyRepairSessionCurrent(session, text)
    this.assertNotCancelled(context)
    if (source && this.input.expectedMode && (source.snapshot.migrationState === 'legacy_cards_preserved' ? 'existing' : 'model') !== this.input.expectedMode) throw new Error(text('确认修复后旧版角色名单发生了变化，本次修复已停止，未改动任何角色数据。请重新发起修复。', 'The legacy cast changed after you confirmed the repair, so this repair stopped. No character data was changed. Start the repair again.'))
    if (source && source.snapshot.migrationState === 'legacy_cards_preserved') {
      const result = await ipc.invokeWithProjectSession(session, 'legacy-roster:adopt-existing', {
        operationId: `legacy-cards:${context.runId}`, expectedRevision: source.snapshot.revision,
        expectedLegacyHash: source.legacyHash, expectedIdentityRevision: source.identityRevision,
        expectedFactsHash: source.factsHash,
      })
      assertLegacyRepairSessionCurrent(session, text)
      this.notifyRefresh(['characterCards'], session.projectPath, session)
      globalEventBus.emit('ARCH_FILE_UPDATED', { fileName: 'characters.md', projectPath: session.projectPath, projectSession: session, runId: context.runId })
      return result.snapshot.renderedMarkdown
    }
    let handle = this.input.recoveryHandle
    if (!handle && !this.input.restart) {
      const runs = await ipc.invokeWithProjectSession(session, 'generation:list')
      this.assertNotCancelled(context)
      assertLegacyRepairSessionCurrent(session, text)
      handle = runs.find(run => run.operation === 'legacy-character-roster-repair')?.handle
      if (handle) throw new Error(text('已有旧版角色名单修复运行，请明确查看或恢复；重新开始须单独选择。', 'A legacy cast repair run already exists. View or resume it explicitly; starting over is a separate choice.'))
    }
    const client = createLegacyRosterGeneration(session, () => { this.assertNotCancelled(context); assertLegacyRepairSessionCurrent(session, text) })
    const timer = setInterval(() => { if (context.cancelled) void client.cancel().catch(() => {}) }, 50)
    try {
      const modelId = context.generationModelId || routeModelId('legacy-character-roster-repair') || ''
      const current = await client.open(handle ? { handle } : { modelId, uiActionNonce: `legacy-roster:${context.runId}` })
      pinWorkflowModel(context, current.modelId)
      context.mainGenerationRunHandle = current.view.handle
      context.data.legacyRosterGenerationHandle = current.view.handle
      const completed = current.proposal ? current : await client.execute()
      this.assertNotCancelled(context)
      assertLegacyRepairSessionCurrent(session, text)
      context.mainGenerationRunHandle = completed.view.handle
      const batch = completed.proposal ?? await client.stage()
      context.data.characterProposalBatch = batch
      callbacks.setProgress(100)
      callbacks.log(text('候选已保存，等待明确采用；原始当前状态仅保留为候选，尚未写入定稿状态。', 'Candidates saved for explicit approval; original current state remains a candidate, not finalized state.'))
      return formatCharacterProposalPreview(batch, text)
    } finally {
      clearInterval(timer)
      if (context.cancelled) await client.cancel().catch(() => {})
      client.detach()
    }
  }
}
