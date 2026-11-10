import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { displayedErrorMessage, errorCodeOf } from '../../../i18n/app-errors'
import {
  readLatestContinuityReport, runContinuityCheck, type ContinuityReport,
} from '../../../services/blueprint-continuity-check'
import { exemptionChapter, saveFindingExemption, type ExemptionScope } from '../../../services/consistency-preflight'
import { ipc } from '../../../services/ipc-client'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import { continuityFindingKey, isChapterAsChecked, selectContinuityCheckScope, type ContinuityCheckNode } from '../../../shared/blueprint-continuity-check'
import type { ContinuityNode } from '../../../shared/character-continuity'
import { exemptedFactKeys, type ConsistencyExemption } from '../../../shared/consistency-preflight'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
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
  issue: string
  suggestion: string
  basis: ContinuityCheckNode[]
}

interface Exempted { session: ProjectSessionContext; finding: AiFinding; scope: ExemptionScope }

export function useBlueprintAiCheck(projectKey: string, blueprints: readonly ChapterBlueprint[]) {
  const sessionLease = useProjectStore(s => s.currentProject?.sessionLease)
  const [status, setStatus] = useState<CheckStatus>({ kind: 'idle' })
  const [report, setReport] = useState<ContinuityReport | null>(null)
  const [exemptions, setExemptions] = useState<ConsistencyExemption[]>([])
  const [hasTimeline, setHasTimeline] = useState(true)
  const [timeline, setTimeline] = useState<ContinuityNode[] | null>(null)
  const [exempted, setExempted] = useState<Exempted | null>(null)
  const [busy, setBusy] = useState(false)
  const checked = useRef(false)

  const currentSession = useCallback(() => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    return session && isProjectSessionPath(session, projectKey) ? session : null
  }, [projectKey])

  const readExemptions = useCallback(async (session: ProjectSessionContext) => {
    const list = await ipc.invokeWithProjectSession(session, 'db:consistency-exemption-list', session.projectPath)
    if (isProjectSessionCurrent(session)) setExemptions(list)
  }, [])

  useEffect(() => {
    const session = currentSession()
    if (!session) return
    let active = true
    const applies = () => active && isProjectSessionCurrent(session)
    void ipc.invokeWithProjectSession(session, 'db:character-continuity-preflight-nodes', session.projectPath)
      .then(nodes => { if (applies()) { setHasTimeline(nodes.length > 0); setTimeline(nodes) } }).catch(() => {})
    void ipc.invokeWithProjectSession(session, 'db:consistency-exemption-list', session.projectPath)
      .then(list => { if (applies()) setExemptions(list) }).catch(() => {})
    void readLatestContinuityReport(session)
      .then(latest => { if (applies() && !checked.current) setReport(latest) }).catch(() => {})
    return () => { active = false }
  }, [currentSession, sessionLease])

  const run = async () => {
    const session = currentSession()
    const { text, locale } = useLocaleStore.getState()
    if (!session) return
    const modelId = routeStageModel('planning', useLLMStore.getState()).modelId
    if (!modelId) {
      setStatus({ kind: 'failed', message: text('蓝图没有改动。还没有能用的模型，到“分工模型”选一个，再点“AI 检查”。', 'Your blueprints are unchanged. No model is available. Pick one in Model roles, then choose AI check again.') })
      return
    }
    checked.current = true
    setStatus({ kind: 'running' })
    try {
      const outcome = await runContinuityCheck(session, modelId)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'checked') {
        await readExemptions(session).catch(() => {})
        setReport(outcome.report)
        setStatus({ kind: 'done' })
      } else {
        setReport(null)
        setStatus({ kind: outcome.status })
      }
    } catch (error) {
      if (!isProjectSessionCurrent(session)) return
      const code = errorCodeOf(error)
      if (code === 'GENERATION_GRAPH_CONTINUITY_TIMELINE_REQUIRED') { setHasTimeline(false); setStatus({ kind: 'idle' }); return }
      setStatus({ kind: 'failed', message: code === 'GENERATION_GRAPH_BLUEPRINT_REQUIRED'
        ? text('没有还没定稿的章节要检查。', 'Every chapter is finalized, so there is nothing to check.')
        : displayedErrorMessage(locale, error, text('蓝图没有改动。这次没查成，再点一次“AI 检查”。', 'Your blueprints are unchanged. The check did not finish. Choose AI check again.')) })
    }
  }

  const unchanged = useMemo(() => {
    const current = new Map(blueprints.map(blueprint => [blueprint.chapterNumber, blueprint]))
    return (chapter: number) => report !== null && isChapterAsChecked(report.chapters.get(chapter)!, current.get(chapter))
  }, [report, blueprints])

  const findings = useMemo<AiFinding[]>(() => {
    if (!report) return []
    if (report.sourceStatus === 'conflict') {
      // 来源对不上时，只有确认时间线没变、确实是某几章蓝图改了，没改的章才保留结论。
      const checkedChapters = [...report.chapters.values()].map(chapter => ({ ...chapter, notesUpdatedAt: '' }))
      const sameTimeline = timeline !== null
        && JSON.stringify(selectContinuityCheckScope(checkedChapters, timeline, Infinity).nodes) === JSON.stringify([...report.nodes.values()])
      if (!sameTimeline || [...report.chapters.keys()].every(unchanged)) return []
    }
    return report.result.findings.flatMap(finding => {
      const stableFactKey = continuityFindingKey(finding.eventIds)
      if (!unchanged(finding.chapterNumber) || exemptedFactKeys(exemptions, finding.chapterNumber).has(stableFactKey)) return []
      return [{ stableFactKey, chapterNumber: finding.chapterNumber, issue: finding.issue, suggestion: finding.suggestion,
        basis: finding.eventIds.map(id => report.nodes.get(id)!) }]
    })
  }, [report, unchanged, exemptions, timeline])

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
    clean: status.kind === 'done' && report !== null && [...report.chapters.keys()].every(unchanged) && report.result.findings.every(finding =>
      exemptedFactKeys(exemptions, finding.chapterNumber).has(continuityFindingKey(finding.eventIds))),
    exempted: (chapterNumber: number | undefined) => exempted && exempted.finding.chapterNumber === chapterNumber && isProjectSessionCurrent(exempted.session) ? exempted : null,
    clearExempted: useCallback(() => setExempted(null), []),
    run,
  }
}

export type BlueprintAiCheck = ReturnType<typeof useBlueprintAiCheck>
