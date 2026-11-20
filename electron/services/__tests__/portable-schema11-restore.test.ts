import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { inspectM03ReviewCycles } from '../../migrations/m03-review-cycle'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'
import { textHash } from '../../repositories/generation-run-repository'
import { readReviewProof } from '../../../src/shared/review-proof'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'

/** 从 26cb66a26（库版本 11）导出的真实便携包，带一条已保存的审稿与修稿循环（v1 证明）。 */
const SCHEMA11_REVIEW_ARCHIVE = path.resolve('test/fixtures/portable/schema11-review-cycle.ainovel')
const roots: string[] = []

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) await removeDirectoryWithWindowsRetry(root)
})

function workspace(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'schema11-restore-'))
  roots.push(base)
  return base
}

function proofVersions(): unknown[] {
  return (getProjectDb()!.prepare('SELECT binding_json FROM generation_runs ORDER BY run_id').pluck().all() as string[]).map(json => {
    const proof = readReviewProof(JSON.parse(json).sourceManifest, textHash)
    return proof.kind === 'recomputable' ? proof.context.version : proof.kind
  })
}

describe('恢复库版本 11 导出的便携包', { timeout: 60_000 }, () => {
  it('升到 12，旧审修证明原样是 v1，从严校验通过；再导出再恢复照样通过', async () => {
    const base = workspace(), target = path.join(base, '恢复')
    const receipt = await restorePortableProject({ archivePath: SCHEMA11_REVIEW_ARCHIVE, targetProjectRoot: target })
    initProjectDatabase(target)
    expect(getProjectDb()!.pragma('user_version', { simple: true })).toBe(12)
    expect(proofVersions()).toEqual([1, 1])
    expect(inspectM03ReviewCycles(getProjectDb()!)).toEqual({ structureOk: true, unprovable: [] })
    closeProjectDatabase()

    const archive = path.join(base, 'again.ainovel'), attempts = path.join(base, 'attempts')
    fs.mkdirSync(attempts)
    await exportPortableProject({ sourceProjectRoot: target,
      projectSession: { projectId: receipt.targetProjectId, projectPath: target, leaseId: 'lease-again' },
      targetArchivePath: archive, attemptParentPath: attempts, assertCurrentContext: () => undefined,
      assets: { snapshot: () => ({ files: [] }) }, snapshotGeneration: 'after-schema11' })
    const second = path.join(base, '再恢复')
    await restorePortableProject({ archivePath: archive, targetProjectRoot: second })
    initProjectDatabase(second)
    expect(proofVersions()).toEqual([1, 1])
    expect(inspectM03ReviewCycles(getProjectDb()!)).toEqual({ structureOk: true, unprovable: [] })
  })
})
