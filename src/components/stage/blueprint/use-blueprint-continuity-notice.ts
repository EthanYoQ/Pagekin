import { useCallback, useState } from 'react'
import {
  exemptionChapter,
  readConsistencyPreflight,
  saveFindingExemption,
  type ExemptionScope,
  type PreflightFinding,
} from '../../../services/consistency-preflight'
import { ipc } from '../../../services/ipc-client'
import type { BlueprintForPreflight } from '../../../shared/consistency-preflight'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { isProjectSessionCurrent } from '../../project-session-gate'

interface Recheck { session: ProjectSessionContext; blueprint: BlueprintForPreflight }
interface Exempted extends Recheck { finding: PreflightFinding; scope: ExemptionScope }
interface Notices { session: ProjectSessionContext; byChapter: ReadonlyMap<number, { recheck: Recheck; findings: PreflightFinding[] }> }

/** 保存蓝图之后的提示。这里的失败一律不出声：提示读不出来，保存已经成功了。 */
export function useBlueprintContinuityNotice() {
  const [notices, setNotices] = useState<Notices | null>(null)
  const [exempted, setExempted] = useState<Exempted | null>(null)
  const [busy, setBusy] = useState(false)

  const check = useCallback(async (session: ProjectSessionContext, blueprints: readonly BlueprintForPreflight[]) => {
    try {
      const { findings } = await readConsistencyPreflight(session, blueprints)
      if (!isProjectSessionCurrent(session)) return
      setNotices(current => {
        const byChapter = new Map(current && sameProjectSessionContext(current.session, session) ? current.byChapter : [])
        for (const blueprint of blueprints) {
          byChapter.set(blueprint.chapterNumber, {
            recheck: { session, blueprint },
            findings: findings.filter(finding => finding.chapterNumber === blueprint.chapterNumber),
          })
        }
        return { session, byChapter }
      })
    } catch { return }
  }, [])

  const notice = (chapterNumber: number | undefined) => {
    if (chapterNumber === undefined || !notices || !isProjectSessionCurrent(notices.session)) return null
    return notices.byChapter.get(chapterNumber) ?? null
  }

  const exempt = async (chapterNumber: number, finding: PreflightFinding, scope: ExemptionScope) => {
    const entry = notice(chapterNumber)
    if (!entry || busy) return
    setBusy(true)
    try {
      const saved = await saveFindingExemption(entry.recheck.session, finding, scope, useLocaleStore.getState().text).catch(() => null)
      if (!saved?.success) return
      setExempted({ ...entry.recheck, finding, scope })
      await check(entry.recheck.session, [entry.recheck.blueprint])
    } finally {
      setBusy(false)
    }
  }

  const undo = async () => {
    if (!exempted || busy) return
    setBusy(true)
    try {
      const { session, blueprint, finding, scope } = exempted
      const revoked = await ipc.invokeWithProjectSession(session, 'db:consistency-exemption-revoke', finding.stableFactKey,
        exemptionChapter(finding, scope), session.projectPath).catch(() => null)
      if (!revoked?.success) return
      setExempted(null)
      await check(session, [blueprint])
    } finally {
      setBusy(false)
    }
  }

  const clearExempted = useCallback(() => setExempted(null), [])

  return { busy, check, clearExempted, findings: (chapterNumber: number | undefined) => notice(chapterNumber)?.findings ?? [],
    exempted: (chapterNumber: number | undefined) => exempted && exempted.blueprint.chapterNumber === chapterNumber && isProjectSessionCurrent(exempted.session) ? exempted : null, exempt, undo }
}

export type BlueprintContinuityNotice = ReturnType<typeof useBlueprintContinuityNotice>
