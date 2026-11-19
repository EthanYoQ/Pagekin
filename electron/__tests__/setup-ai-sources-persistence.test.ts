import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../database'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { createCanonicalProjectManifest } from '../../src/shared/project-format'
import { aiSourceOf, recordAiSources } from '../../src/shared/novel-config-ai-sources'

const roots: string[] = []

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
})
