/**
 * 工作流前置校验工具
 *
 * 每个生成步骤启动前需要校验上游数据是否就绪，
 * 以防用户在配置不完整的状态下浪费 AI Token。
 *
 * 校验失败时返回 GuardResult { ok: false, message }，
 * 由调用方选择展示方式（弹窗提示 / 日志输出）。
 */

import { useProjectStore } from '../stores/project-store'
import { useLocaleStore } from '../stores/locale-store'
import { ipc } from './ipc-client'
import type { ProjectData, ProjectSessionContext } from '../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { localize } from '../i18n/core'
import { ARCH_STEP_NAMES } from './architecture-step-selection'
import type { Locale } from '../i18n/types'

import { readPostProcessStatus, getChapterFinalizeScope, getFailedStepLabels } from './workflows/workflow-utils'

export interface GuardResult {
  ok: boolean
  /** 失败时的提示语（给用户看） */
  message?: string
  /** 用于跳转引导的目标动作标识 */
  action?: 'open-config' | 'open-world-building' | 'open-blueprint'
  /** 只是还没轮到（上一章还在整理），不是出错，界面不用错误样式。 */
  pending?: true
}

function captureGuardProject(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): { project: ProjectData; projectPath: string; projectSession: ProjectSessionContext } | null {
  const project = useProjectStore.getState().currentProject
  const projectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !projectSession
    || (expectedProjectPath && !sameProjectPathKey(project.path, expectedProjectPath))
    || (expectedProjectSession && !sameProjectSessionContext(expectedProjectSession, projectSession))
  ) return null
  return { project, projectPath: expectedProjectPath ?? project.path, projectSession }
}

// ===== Guard 1：生成故事架构前 → 校验小说配置 =====

/**
 * 生成故事架构（架构文件）前的前置校验：
 * 要求「核心大纲」或「主角人设」至少填写其中之一。
 */
export function guardArchitectureGeneration(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale: Locale = useLocaleStore.getState().locale,
): GuardResult {
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(uiLocale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { project } = captured
  const { coreOutline, protagonistProfile, worldSetting, genre } = project.novelConfig

  // 校验：小说配置是否有实质内容
  const hasConfig = !!(
    coreOutline?.trim() ||
    protagonistProfile?.trim() ||
    worldSetting?.trim()
  )

  if (!hasConfig) {
    return {
      ok: false,
      message: localize(
        uiLocale,
        `请先填写「小说配置」中的核心大纲或主角人设，AI 才能据此生成故事架构。\n\n当前类型：${genre || '未设置'}`,
        `Fill in the core outline or protagonist profile in Novel Configuration before generating the story architecture.\n\nCurrent genre: ${genre || 'Not set'}`,
      ),
      action: 'open-config',
    }
  }

  return { ok: true }
}

// ===== Guard 2：生成章节蓝图前 → 校验故事架构完成度 =====

/**
 * 生成章节蓝图前的前置校验：
 * 要求至少有 1 个架构信息（故事前提）已生成，
 * 建议 4 个都完成，但允许继续（仅提示警告）。
 */
export async function guardDirectoryGeneration(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale?: Locale,
): Promise<GuardResult> {
  // 不传语言时按写出提示这一刻的界面语言，查询期间切换了语言也不会用旧语言。
  const shown = () => uiLocale ?? useLocaleStore.getState().locale
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(shown(), '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { projectPath, projectSession } = captured
  const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
  // 只记下缺了哪几块，等最后一次查询回来再按当时的语言写出名字。
  const missing: (readonly [string, string])[] = []

  const checkHasContent = (text: string | null | undefined) => text && text.length > 50 && !text.includes('> 待生成')

  const premiseMissing = !core || !checkHasContent(core.premise)
  if (!core || !checkHasContent(core.charactersArch)) missing.push(ARCH_STEP_NAMES.characters)
  if (!core || !checkHasContent(core.worldbuilding)) missing.push(['世界观', 'Worldbuilding'])
  if (!core || !checkHasContent(core.synopsis)) missing.push(['情节大纲', 'Plot outline'])

  // 故事前提是必须的（第一个大块）
  if (premiseMissing) {
    return {
      ok: false,
      message: localize(
        shown(),
        '还没有「故事前提」，章节蓝图要靠它。\n\n请先在「故事架构」点「AI 生成架构」生成故事前提。',
        'There is no story premise yet, and chapter blueprints depend on it.\n\nGenerate it in Story Architecture first.',
      ),
      action: 'open-world-building',
    }
  }

  // 检查角色卡是否存在（不变量 1 的反向约束）
  const chars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
  if (chars.length === 0) {
    return {
      ok: false,
      message: localize(
        shown(),
        '角色卡不存在。\n\n请先在架构里生成角色名单，或手动添加角色。',
        'No character cards exist.\n\nGenerate the cast in the architecture, or add characters manually.',
      ),
    }
  }

  // 其他部分缺失：警告但允许继续
  if (missing.length > 0) {
    const labels = missing.map(label => localize(shown(), ...label))
    return {
      ok: true, // 允许继续，但携带警告信息
      message: localize(
        shown(),
        `注意：以下架构信息尚未生成，蓝图质量可能受影响：\n${labels.map(m => `• ${m}`).join('\n')}\n\n建议先生成完整架构，或继续使用现有内容。`,
        `The following architecture sections have not been generated, which may affect blueprint quality:\n${labels.map(m => `• ${m}`).join('\n')}\n\nGenerate the complete architecture first, or continue with the available content.`,
      ),
    }
  }

  return { ok: true }
}

// ===== Guard 3：章节写稿前 → 校验章节蓝图存在 =====

/**
 * 章节写稿前的前置校验：
 * 1. 要求 blueprints/ 目录中存在至少一个章节蓝图 JSON 文件。
 * 2. 如果指定了章节号且 > 1，要求前一章已定稿（存在于 manuscript/ 中），否则上下文会断裂。
 */
export async function guardChapterWriting(
  targetChapterNumber?: number,
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
  uiLocale?: Locale,
): Promise<GuardResult> {
  // 不传语言时按写出提示这一刻的界面语言，查询期间切换了语言也不会用旧语言。
  const shown = () => uiLocale ?? useLocaleStore.getState().locale
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(shown(), '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const { projectPath, projectSession } = captured
  const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', projectPath)
  if (blueprints.length === 0) {
    return {
      ok: false,
      message: localize(
        shown(),
        '还没有章节蓝图。\n\n请先在「章节蓝图」点「AI 生成蓝图」，再回来写稿。',
        'No chapter blueprints have been generated.\n\nGenerate chapter blueprints first, then return to draft the chapter.',
      ),
      action: 'open-blueprint',
    }
  }

  // 检查角色卡是否存在（不变量 1 的反向约束：无角色卡则阻断写稿）
  const chars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
  if (chars.length === 0) {
    return {
      ok: false,
      message: localize(
        shown(),
        '角色卡不存在，AI 写稿要用角色状态。\n\n请先在架构里生成角色名单，或手动添加角色。',
        'No character cards exist, and AI drafting needs character state.\n\nGenerate the cast in the architecture, or add characters manually.',
      ),
    }
  }

  // 如果指定了且不是第一章，则必须保证前一章已经存在正文库（定稿状态）
  if (targetChapterNumber && targetChapterNumber > 1) {
    const prevChapter = targetChapterNumber - 1
    const prevDraftMeta = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-finalized', prevChapter, projectPath)
    if (!prevDraftMeta) {
      return {
        ok: false,
        message: localize(
          shown(),
          `第 ${prevChapter} 章尚未定稿，AI 读不到它的结尾和要点。\n\n请在「正文」打开第 ${prevChapter} 章定稿，再写这一章。`,
          `Chapter ${prevChapter} isn't finalized, so AI can't read its ending and notes.\n\nOpen Chapter ${prevChapter} in Manuscript and finalize it, then write this chapter.`,
        ),
      }
    }

    // 不变量 2 的反向约束：前一章定稿后处理必须全部通过
    const prevScope = getChapterFinalizeScope(prevChapter)
    const prevStatus = await readPostProcessStatus(projectPath, prevScope, projectSession)
    if (prevStatus && !prevStatus.allCriticalPassed) {
      // 关键步骤都没记失败、且还有运行占着上一章：只是还没跑完。批量运行一直占着本批各章，所以必须先看有没有记失败。
      const { useWorkflowStore, workflowResourceKey } = await import('../stores/workflow-store')
      const criticalFailed = Object.values(prevStatus.steps).some(step => step.critical && !step.ok && step.error)
      const stillRunning = !criticalFailed && useWorkflowStore.getState().activeRuns.some(run => sameProjectPathKey(run.projectPath, projectPath)
        && run.resourceKeys?.includes(workflowResourceKey('chapter', prevChapter)))
      if (stillRunning) {
        return {
          ok: false,
          pending: true,
          message: localize(
            shown(),
            `第 ${prevChapter} 章已定稿，后台还在整理这一章，很快就好，请稍后再试。`,
            `Chapter ${prevChapter} is finalized and is still being processed in the background. This won't take long; try again in a moment.`,
            `第${prevChapter}章は定稿済みで、バックグラウンドでまだ整理しています。まもなく終わるので、少し待ってからもう一度お試しください。`,
          ),
        }
      }
      const failedLabels = getFailedStepLabels(prevStatus)
      return {
        ok: false,
        message: localize(
          shown(),
          `第 ${prevChapter} 章定稿后处理未完成：\n${failedLabels.map(f => `• ${f}`).join('\n')}\n\n请在「正文」打开第 ${prevChapter} 章，处理「定稿后处理」里失败的步骤。`,
          `Chapter ${prevChapter} is finalized, but some steps after finalization failed:\n${failedLabels.map(f => `• ${f}`).join('\n')}\n\nOpen Chapter ${prevChapter} in Manuscript and fix the failed steps under After finalization.`,
        ),
      }
    }
    // 如果状态文件不存在（旧版定稿）→ 兼容放行
  }

  return { ok: true }
}

// ===== Guard 4：角色卡重新生成前 → 检查蓝图是否为空 =====

/**
 * 角色卡重新生成/补齐的前置校验：
 * 不变量 1：角色卡仅允许在蓝图目录为空时重新生成，
 * 否则会破坏已有蓝图/章节的角色状态链。
 */
export async function guardCharacterRegeneration(
  expectedProjectSession?: ProjectSessionContext,
): Promise<GuardResult> {
  const captured = captureGuardProject(undefined, expectedProjectSession)
  if (!captured) {
    return {
      ok: false,
      message: localize(useLocaleStore.getState().locale, '请先打开或新建一个项目。', 'Open or create a project first.'),
    }
  }

  const blueprints = await ipc.invokeWithProjectSession(
    captured.projectSession,
    'db:blueprint-get-all',
    captured.projectPath,
  )
  if (blueprints.length > 0) {
    return {
      ok: false,
      message: localize(
        useLocaleStore.getState().locale,
        '已有章节蓝图，不能重新生成角色卡，否则现有蓝图和已写章节都会失效。\n\n要改角色，请直接编辑角色卡。',
        'Character cards cannot be regenerated while chapter blueprints exist, because that would invalidate existing blueprints and drafted chapters.\n\nEdit the character cards directly instead.',
      ),
    }
  }

  return { ok: true }
}

// ===== Guard 5：修复定稿后处理前 → 检查这一章有没有要修的步骤 =====

export async function guardRepairPostProcess(
  chapterNumber: number,
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): Promise<GuardResult> {
  const text = (zhCNText: string, enUSText: string) => localize(useLocaleStore.getState().locale, zhCNText, enUSText)
  const captured = captureGuardProject(expectedProjectPath, expectedProjectSession)
  if (!captured) {
    return { ok: false, message: text('请先打开或新建一个项目。', 'Open or create a project first.') }
  }

  const maxFinalized = await ipc.invokeWithProjectSession(
    captured.projectSession,
    'db:draft-get-max-finalized-chapter',
    captured.projectPath,
  )
  if (maxFinalized === 0) {
    return { ok: false, message: text('尚无已定稿章节，无法执行修复操作。', 'No chapter has been finalized yet, so there is nothing to repair.') }
  }
  if (chapterNumber === maxFinalized) return { ok: true }

  const status = await readPostProcessStatus(captured.projectPath, getChapterFinalizeScope(chapterNumber), captured.projectSession)
  if (!status || Object.values(status.steps).some(step => !step.ok)) return { ok: true }
  return {
    ok: false,
    message: text(
      `第 ${chapterNumber} 章的定稿后处理已经全部完成，没有需要修复的步骤。`,
      `Post-processing for Chapter ${chapterNumber} has already finished, so there is no step to repair.`,
    ),
  }
}
