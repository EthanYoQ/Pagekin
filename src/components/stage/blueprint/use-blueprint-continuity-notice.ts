import { useCallback, useRef, useState } from 'react'
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
import { toast } from '../../ui/Toast'
import { isProjectSessionCurrent } from '../../project-session-gate'

interface Exempted { session: ProjectSessionContext; chapterNumber: number; finding: PreflightFinding; scope: ExemptionScope }
interface LatestCheck { session: ProjectSessionContext; blueprint: BlueprintForPreflight }
interface Notices { session: ProjectSessionContext; byChapter: ReadonlyMap<number, { findings: PreflightFinding[] }> }

/** 保存蓝图之后的提示。自动预检失败不出声：提示读不出来，保存已经成功了。 */
export function useBlueprintContinuityNotice() {
  const [notices, setNotices] = useState<Notices | null>(null)
  const [exempted, setExempted] = useState<Exempted | null>(null)
  const [busy, setBusy] = useState(false)
  const latestChecks = useRef(new Map<number, LatestCheck>())

  const check = useCallback(async (session: ProjectSessionContext, blueprints: readonly BlueprintForPreflight[]) => {
    const requests = blueprints.map((blueprint): LatestCheck => ({ session, blueprint }))
    for (const request of requests) latestChecks.current.set(request.blueprint.chapterNumber, request)
    try {
      const { findings } = await readConsistencyPreflight(session, blueprints)
      if (!isProjectSessionCurrent(session)) return
      const fresh = requests.filter(request => latestChecks.current.get(request.blueprint.chapterNumber) === request)
      if (fresh.length === 0) return
      setNotices(current => {
        const byChapter = new Map(current && sameProjectSessionContext(current.session, session) ? current.byChapter : [])
        for (const { blueprint } of fresh) {
          byChapter.set(blueprint.chapterNumber, {
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
    if (!notice(chapterNumber) || !notices || busy) return
    const { session } = notices
    const { text } = useLocaleStore.getState()
    setBusy(true)
    try {
      const saved = await saveFindingExemption(session, finding, scope, text).catch(() => null)
      if (!saved?.success) {
        toast.error(text('没记下，提示还在。再点一次试试。', 'Not saved. The reminder stays. Try again.'))
        return
      }
      for (const [number, entry] of latestChecks.current) {
        if (scope === 'book' || number === chapterNumber) latestChecks.current.set(number, { ...entry })
      }
      setExempted({ session, chapterNumber, finding, scope })
      setNotices(current => current && { ...current, byChapter: new Map([...current.byChapter].map(([number, entry]) => [number,
        scope === 'book' || number === chapterNumber
          ? { ...entry, findings: entry.findings.filter(item => item.stableFactKey !== finding.stableFactKey) }
          : entry])) })
    } finally {
      setBusy(false)
    }
  }

  const undo = async () => {
    if (!exempted || busy) return
    setBusy(true)
    try {
      const { session, chapterNumber, finding, scope } = exempted
      const revoked = await ipc.invokeWithProjectSession(session, 'db:consistency-exemption-revoke', finding.stableFactKey,
        exemptionChapter(finding, scope), session.projectPath).catch(() => null)
      if (!revoked?.success) {
        const { text } = useLocaleStore.getState()
        toast.error(text('没撤销，这条还是不提示。再点一次试试。', 'Not undone. This stays dismissed. Try again.'))
        return
      }
      setExempted(null)
      const latest = [...latestChecks.current.values()].filter(entry => sameProjectSessionContext(entry.session, session))
      await check(session, latest.map(entry => entry.blueprint).filter(blueprint => scope === 'book' || blueprint.chapterNumber === chapterNumber))
    } finally {
      setBusy(false)
    }
  }

  const clearExempted = useCallback(() => setExempted(null), [])
  const clear = useCallback(() => { latestChecks.current.clear(); setNotices(null); setExempted(null) }, [])

  return { busy, check, clear, clearExempted, findings: (chapterNumber: number | undefined) => notice(chapterNumber)?.findings ?? [],
    exempted: (chapterNumber: number | undefined) => exempted && exempted.chapterNumber === chapterNumber && isProjectSessionCurrent(exempted.session) ? exempted : null, exempt, undo }
}

export type BlueprintContinuityNotice = ReturnType<typeof useBlueprintContinuityNotice>
