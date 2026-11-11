import type { ContinuityCheckNode } from '../../../shared/blueprint-continuity-check'
import { CHARACTER_STATE_FIELDS } from '../../editor/character-state-fields'

export function basisLine(node: ContinuityCheckNode, text: (zh: string, en: string) => string): string {
  const { zhCN, enUS } = node.since
  const since = enUS.charAt(0).toUpperCase() + enUS.slice(1)
  if (node.aspect === 'relation') return text(`${zhCN}，${node.subjectName}和${node.targetName}是「${node.value}」`, `${since}, ${node.subjectName}’s relation to ${node.targetName} is “${node.value}”`)
  const [, zh, en] = CHARACTER_STATE_FIELDS.find(([field]) => field === node.aspect)!
  const label = (value: string) => value.replace(/\s*[（(].*$/u, '')
  return text(`${zhCN}，${node.subjectName}的${label(zh)}是「${node.value}」`, `${since}, ${node.subjectName}’s ${label(en).toLowerCase()} is “${node.value}”`)
}
