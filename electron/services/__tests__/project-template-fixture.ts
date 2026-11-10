import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { createProjectDatabase } from '../../database'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY, createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'

let templateDatabase: string | null = null

function writeManifest(root: string, projectId: string): void {
  fs.mkdirSync(path.join(root, CANONICAL_PROJECT_DIRECTORY), { recursive: true })
  fs.writeFileSync(path.join(root, CANONICAL_PROJECT_DIRECTORY, 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-01T00:00:00.000Z',
  })))
}

export function buildProjectTemplate(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-template-'))
  writeManifest(root, randomUUID())
  createProjectDatabase(root, Buffer.alloc(32, 7))
  templateDatabase = path.join(root, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE)
}

export async function removeProjectTemplate(): Promise<void> {
  if (!templateDatabase) return
  const root = path.dirname(path.dirname(templateDatabase))
  templateDatabase = null
  await removeDirectoryWithWindowsRetry(root)
}

export function createProjectFromTemplate(prefix: string, projectId: string): string {
  if (!templateDatabase) throw new Error('buildProjectTemplate must run in beforeAll')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  writeManifest(root, projectId)
  fs.copyFileSync(templateDatabase, path.join(root, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE), fs.constants.COPYFILE_EXCL)
  return root
}
