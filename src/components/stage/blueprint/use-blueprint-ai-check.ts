import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { displayedErrorMessage, errorCodeOf } from '../../../i18n/app-errors'
import {
  releaseShownContinuityCheck, pendingContinuityCheck, readLatestContinuityReport, runContinuityCheck,
  type ContinuityCheckOutcome, type ContinuityReport,
} from '../../../services/blueprint-continuity-check'
import { exemptionChapter, saveFindingExemption, type ExemptionScope } from '../../../services/consistency-preflight'
import { ipc } from '../../../services/ipc-client'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import {
  continuityFindingKey, isChapterAsChecked, selectContinuityCheckScope, type ContinuityCheckNode, type ContinuityCheckPoint,
} from '../../../shared/blueprint-continuity-check'
import type { ContinuityNode } from '../../../shared/character-continuity'
import { exemptedFactKeys, type ConsistencyExemption } from '../../../shared/consistency-preflight'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { globalEventBus } from '../../../shared/event-bus'
import { routeStageModel } from '../../../shared/model-stage-routing'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { toast } from '../../ui/Toast'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

/** 作者这次点按钮后的结果；重开页面取回的旧结果只显示到章，不出总结。 */
type CheckStatus =
  | { kind: 'idle' | 'running' | 'done' | 'changed' | 'unreadable' | 'no-timeline' }
  | { kind: 'failed'; message: string }

export interface AiFinding {
  stableFactKey: string
  chapterNumber: number
  points: ContinuityCheckPoint[]
  basis: ContinuityCheckNode[]
}

interface Exempted { session: ProjectSessionContext; finding: AiFinding; scope: ExemptionScope }

const reportContent = (report: ContinuityReport) => JSON.stringify([report.result, [...report.chapters.values()], [...report.nodes.values()]])

function sessionFor(projectKey: string) {
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  return session && isProjectSessionPath(session, projectKey) ? session : null
}

export function useBlueprintAiCheck(projectKey: string, blueprints: readonly ChapterBlueprint[]) {
  const sessionLease = useProjectStore(s => s.currentProject?.sessionLease)
  const [status, setStatus] = useState<CheckStatus>(() => {
    const session = sessionFor(projectKey)
    return session && pendingContinuityCheck(session) ? { kind: 'running' } : { kind: 'idle' }
  })
  const [report, setReport] = useState<ContinuityReport | null>(null)
  const [exemptions, setExemptions] = useState<ConsistencyExemption[]>([])
  const [hasTimeline, setHasTimeline] = useState(true)
  const [timeline, setTimeline] = useState<ContinuityNode[] | null>(null)
  const [exempted, setExempted] = useState<Exempted | null>(null)
  const [busy, setBusy] = useState(false)
  const checked = useRef(false)
  const rejected = useRef(false)
  const recovery = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const currentSession = useCallback(() => sessionFor(projectKey), [projectKey])

  const readTimeline = useCallback(async (session: ProjectSessionContext) => {
    const nodes = await ipc.invokeWithProjectSession(session, 'db:character-continuity-preflight-nodes', session.projectPath)
    if (isProjectSessionCurrent(session)) { setHasTimeline(nodes.length > 0); setTimeline(nodes) }
  }, [])

  /** 结论记的是读取当时的来源状态；蓝图保存后重读，章改回原样时才不会让整份结论一直判作过期。 */
  const recoverLatest = useCallback((session: ProjectSessionContext, applies: () => boolean) => {
    const request = ++recovery.current
    void readLatestContinuityReport(session)
      .then(latest => {
        if (applies() && request === recovery.current && !checked.current)
          setReport(shown => shown && rejected.current && reportContent(shown) !== (latest && reportContent(latest)) ? shown : latest)
      }).catch(() => {})
  }, [])

  useEffect(() => globalEventBus.on('REFRESH_RESOURCE', ({ projectSession, resources }) => {
    const session = currentSession()
    if (!session || !isProjectSessionCurrent(projectSession)) return
    if (resources.some(kind => kind === 'drafts' || kind === 'characterCards' || kind === 'all'))
      void readTimeline(session).catch(() => {})
    if (!checked.current && resources.some(kind => kind === 'blueprints' || kind === 'all'))
      recoverLatest(session, () => mounted.current && isProjectSessionCurrent(session))
  }), [currentSession, readTimeline, recoverLatest])

  const readExemptions = useCallback(async (session: ProjectSessionContext) => {
    const list = await ipc.invokeWithProjectSession(session, 'db:consistency-exemption-list', session.projectPath)
    if (isProjectSessionCurrent(session)) setExemptions(list)
  }, [])

  const follow = useCallback((session: ProjectSessionContext, pending: Promise<ContinuityCheckOutcome>) => {
    const { text, locale } = useLocaleStore.getState()
    const shown = () => {
      if (!mounted.current || !isProjectSessionCurrent(session)) return false
      releaseShownContinuityCheck(session, pending)
      return true
    }
    return pending.then(async outcome => {
      if (outcome.status === 'checked' && mounted.current)
        await Promise.all([readExemptions(session), readTimeline(session)]).catch(() => {})
      if (!shown()) return
      if (outcome.status === 'checked') {
        checked.current = true
        setReport(outcome.report)
        setStatus({ kind: 'done' })
      } else {
        rejected.current ||= outcome.status === 'changed'
        setStatus({ kind: outcome.status })
      }
    }, (error: unknown) => {
      if (!shown()) return
      const code = errorCodeOf(error)
      if (code === 'GENERATION_GRAPH_CONTINUITY_TIMELINE_REQUIRED') { setHasTimeline(false); setStatus({ kind: 'idle' }); return }
      setStatus({ kind: 'failed', message: code === 'GENERATION_GRAPH_BLUEPRINT_REQUIRED'
        ? text('没有还没定稿的章节要检查。', 'Every chapter is finalized, so there is nothing to check.')
        : displayedErrorMessage(locale, error, text('蓝图没有改动。这次没查成，再点一次“AI 检查”。', 'Your blueprints are unchanged. The check did not finish. Choose AI check again.')) })
    })
  }, [readExemptions, readTimeline])

  useEffect(() => {
    const session = currentSession()
    if (!session) return
    let active = true
    rejected.current = false
    const applies = () => active && isProjectSessionCurrent(session)
    void ipc.invokeWithProjectSession(session, 'db:character-continuity-preflight-nodes', session.projectPath)
      .then(nodes => { if (applies()) { setHasTimeline(nodes.length > 0); setTimeline(nodes) } }).catch(() => {})
    void ipc.invokeWithProjectSession(session, 'db:consistency-exemption-list', session.projectPath)
      .then(list => { if (applies()) setExemptions(list) }).catch(() => {})
    const pending = pendingContinuityCheck(session)
    if (pending) void follow(session, pending)
    recoverLatest(session, applies)
    return () => { active = false }
  }, [currentSession, sessionLease, follow, recoverLatest])

  const run = async () => {
    const session = currentSession()
    const { text } = useLocaleStore.getState()
    if (!session) return
    const modelId = routeStageModel('planning', useLLMStore.getState()).modelId
    if (!modelId) {
      setStatus({ kind: 'failed', message: text('蓝图没有改动。还没有能用的模型，到“分工模型”选一个，再点“AI 检查”。', 'Your blueprints are unchanged. No model is available. Pick one in Model roles, then choose AI check again.') })
      return
    }
    setStatus({ kind: 'running' })
    await follow(session, runContinuityCheck(session, modelId))
  }

  const unchanged = useMemo(() => {
    const current = new Map(blueprints.map(blueprint => [blueprint.chapterNumber, blueprint]))
    return (chapter: number) => report !== null && isChapterAsChecked(report.chapters.get(chapter)!, current.get(chapter))
  }, [report, blueprints])

  const stale = useMemo(() => {
    if (!report) return true
    const checkedChapters = [...report.chapters.values()].map(chapter => ({ ...chapter, notesUpdatedAt: '' }))
    const timelineUnchanged = timeline === null ? null
      : JSON.stringify(selectContinuityCheckScope(checkedChapters, timeline, Infinity).nodes) === JSON.stringify([...report.nodes.values()])
    if (timelineUnchanged === false) return true
    return report.sourceStatus === 'conflict' && (timelineUnchanged === null || [...report.chapters.keys()].every(unchanged))
  }, [report, timeline, unchanged])

  const findings = useMemo<AiFinding[]>(() => {
    if (!report || stale) return []
    return report.result.findings.flatMap(finding => {
      const stableFactKey = continuityFindingKey(finding.eventIds)
      if (!unchanged(finding.chapterNumber) || exemptedFactKeys(exemptions, finding.chapterNumber).has(stableFactKey)) return []
      return [{ stableFactKey, chapterNumber: finding.chapterNumber, points: finding.points,
        basis: finding.eventIds.map(id => report.nodes.get(id)!) }]
    })
  }, [report, stale, unchanged, exemptions])

  const exempt = async (finding: AiFinding, scope: ExemptionScope) => {
    const session = currentSession()
    if (!session || busy) return
    const { text } = useLocaleStore.getState()
    setBusy(true)
    try {
      const saved = await saveFindingExemption(session, finding, scope, text).catch(() => null)
      if (!saved?.success) { toast.error(text('没记下，提示还在。再点一次试试。', 'Not saved. The reminder stays. Try again.')); return }
      setExempted({ session, finding, scope })
      await readExemptions(session).catch(() => {})
    } finally { setBusy(false) }
  }

  const undo = async () => {
    if (!exempted || busy) return
    const { session, finding, scope } = exempted
    setBusy(true)
    try {
      const revoked = await ipc.invokeWithProjectSession(session, 'db:consistency-exemption-revoke', finding.stableFactKey,
        exemptionChapter(finding, scope), session.projectPath).catch(() => null)
      if (!revoked?.success) {
        toast.error(useLocaleStore.getState().text('没撤销，这条还是不提示。再点一次试试。', 'Not undone. This stays dismissed. Try again.'))
        return
      }
      setExempted(null)
      await readExemptions(session).catch(() => {})
    } finally { setBusy(false) }
  }

  const chapterFindings = (chapterNumber: number) => findings.filter(finding => finding.chapterNumber === chapterNumber)

  return {
    status, hasTimeline, busy, findings, chapterFindings, exempt, undo,
    checkedThroughChapter: report?.result.checkedThroughChapter ?? null,
    /** 按章隐藏掉的结论不算「没发现」，只有模型确实没报（或都被豁免）才说没问题。 */
    clean: status.kind === 'done' && report !== null && !stale && [...report.chapters.keys()].every(unchanged) && report.result.findings.every(finding =>
      exemptedFactKeys(exemptions, finding.chapterNumber).has(continuityFindingKey(finding.eventIds))),
    exempted: (chapterNumber: number | undefined) => exempted && exempted.finding.chapterNumber === chapterNumber && isProjectSessionCurrent(exempted.session) ? exempted : null,
    clearExempted: useCallback(() => setExempted(null), []),
    run,
  }
}

export type BlueprintAiCheck = ReturnType<typeof useBlueprintAiCheck>
