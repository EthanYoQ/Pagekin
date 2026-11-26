import type { EditorTab } from './editor-store'
import { parseJsonOrUndefined } from '../shared/ignore-failure'

const LEDGER_TYPE_BY_KEY: Record<string, EditorTab['type']> = {
  'character-editor-drafts': 'character',
  config: 'config',
  'chapter-card-editor': 'chapter-card',
}
const BACKGROUND_LEDGER_TYPES = new Set(Object.values(LEDGER_TYPE_BY_KEY))

export function countUnsavedEditorItems(
  tabs: readonly EditorTab[],
  draftLedgers: Readonly<Record<string, string>>,
): number {
  const dirtyItems = new Set<string>()
  for (const tab of tabs) {
    if (!tab.dirty) continue
    dirtyItems.add(
      tab.projectKey && BACKGROUND_LEDGER_TYPES.has(tab.type)
        ? `${tab.type}:${tab.projectKey}`
        : `tab:${tab.id}`,
    )
  }

  for (const [ledgerKey, content] of Object.entries(draftLedgers)) {
    const type = LEDGER_TYPE_BY_KEY[ledgerKey]
    if (!type || !content) continue
    try {
      const parsed = JSON.parse(content) as { projects?: Array<{ projectKey?: unknown }> }
      if (!Array.isArray(parsed.projects)) continue
      for (const project of parsed.projects) {
        if (typeof project.projectKey === 'string') {
          dirtyItems.add(`${type}:${project.projectKey}`)
        }
      }
    } catch {
      // 损坏账本不能被当作可安全更新；保留一个阻断项。
      dirtyItems.add(`ledger:${ledgerKey}`)
    }
  }
  return dirtyItems.size
}

export function countUnsavedEditorItemsForProject(
  tabs: readonly EditorTab[],
  draftLedgers: Readonly<Record<string, string>>,
  projectKey: string,
): number {
  const dirtyItems = new Set<string>()
  for (const tab of tabs) {
    if (!tab.dirty || tab.projectKey !== projectKey) continue
    dirtyItems.add(
      BACKGROUND_LEDGER_TYPES.has(tab.type)
        ? `${tab.type}:${projectKey}`
        : `tab:${tab.id}`,
    )
  }

  for (const [ledgerKey, content] of Object.entries(draftLedgers)) {
    const type = LEDGER_TYPE_BY_KEY[ledgerKey]
    if (!type || !content) continue
    if (ledgerProjectKeys(parseJsonOrUndefined(content, `unreadable draft ledger: ${ledgerKey}`))?.includes(projectKey)) {
      dirtyItems.add(`${type}:${projectKey}`)
    }
  }
  return dirtyItems.size
}

export function ledgerProjectKeys(ledger: unknown): unknown[] | undefined {
  const projects = (ledger as { projects?: unknown } | null | undefined)?.projects
  if (!Array.isArray(projects) || projects.some(project => project === null || project === undefined)) return undefined
  return projects.map(project => (project as { projectKey?: unknown }).projectKey)
}
