import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../database'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { createCanonicalProjectManifest } from '../../src/shared/project-format'
import { aiSourceOf, recordAiSources } from '../../src/shared/novel-config-ai-sources'
import { isAgentDomainToolCurrent } from '../services/agent-domain-tool-effect'
import { textHash } from '../repositories/generation-run-repository'

const roots: string[] = []

/** origin/master（M10 之前）rowToData 的键与顺序。 */
const PRE_M10_CORE_KEYS = ['projectName', 'genre', 'subGenre', 'targetAudience', 'totalChapters', 'wordsPerChapter', 'writingLanguage',
  'creativeStrategy', 'narrativeThreadDormantChapterThreshold', 'plotStructure', 'narrativePov', 'writingStyle', 'referenceWorks',
  'globalGuidance', 'goldenFinger', 'coreOutline', 'worldSetting', 'protagonistProfile', 'premise', 'worldbuilding', 'charactersArch',
  'synopsis', 'characterStates']
const MARKS = JSON.stringify({ worldSetting: { kind: 'filled', hash: '0000abcd' } })

function project(): string {
  const base = path.resolve('.runtime/.cache/setup-ai-sources')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, '作品-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, '.ai-novel'))
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId: randomUUID(), createdAt: new Date().toISOString(),
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  return root
}

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('设定细则的 AI 来源标记随作品保存', () => {
  it('新作品没有标记；AI 写入后关掉重开，标记还在且与内容对得上', () => {
    const root = project()
    initProjectDatabase(root)
    ProjectCoreRepository.init('雾城记')
    const before = ProjectCoreRepository.get()!
    expect(before.aiSources).toEqual({})
    const written = { worldSetting: '雾城', goldenFinger: '回溯' }
    ProjectCoreRepository.update({ ...written, aiSources: recordAiSources(before, written) })
    closeProjectDatabase()

    initProjectDatabase(root)
    const reopened = ProjectCoreRepository.get()!
    expect(aiSourceOf(reopened, 'worldSetting')).toBe('filled')
    expect(aiSourceOf(reopened, 'goldenFinger')).toBe('filled')
  })

  it('库里的标记坏了也能打开，全部按作者内容显示', () => {
    const root = project()
    initProjectDatabase(root)
    ProjectCoreRepository.init('雾城记')
    ProjectCoreRepository.update({ worldSetting: '雾城' })
    getProjectDb()!.prepare("UPDATE project_core SET ai_sources='{坏' WHERE id='main'").run()
    closeProjectDatabase()

    initProjectDatabase(root)
    const reopened = ProjectCoreRepository.get()!
    expect(reopened.aiSources).toEqual({})
    expect(reopened.worldSetting).toBe('雾城')
  })

  it('有标记的作品，ProjectCoreRepository.get 读出的设定与 M10 前逐字相同', () => {
    initProjectDatabase(project())
    ProjectCoreRepository.init('雾城记')
    getProjectDb()!.prepare("UPDATE project_core SET world_setting='雾城', ai_sources=? WHERE id='main'").run(MARKS)
    expect(Object.keys(ProjectCoreRepository.get()!)).toEqual(PRE_M10_CORE_KEYS)
  })

  it('M10 前记下的 Agent 设定回执，升级后重放仍判为当前', () => {
    initProjectDatabase(project())
    ProjectCoreRepository.init('雾城记')
    ProjectCoreRepository.update({ worldSetting: '雾城' })
    const core = ProjectCoreRepository.get() as unknown as Record<string, unknown>
    const preM10 = Object.fromEntries(PRE_M10_CORE_KEYS.map(key => [key, core[key]]))
    getProjectDb()!.prepare("UPDATE project_core SET ai_sources=? WHERE id='main'").run(MARKS)
    const receipt = { kind: 'config' as const, toolCallId: 'tool-1', changes: { worldSetting: '雾城' }, beforeHash: '', afterHash: textHash(JSON.stringify(preM10)) }
    expect(isAgentDomainToolCurrent(getProjectDb()!, receipt)).toBe(true)
  })
})
