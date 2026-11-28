import type { ImportGlobalFactsCore } from './import-global-facts'

export type ImportFillField = keyof ImportGlobalFactsCore | 'writingStyle'
export type ImportFillValues = ImportGlobalFactsCore & { writingStyle: string }

export interface ImportFillSuggestion {
  field: ImportFillField
  current: string | number
  inferred: string | number
}

export interface ImportFillPlan<Field extends ImportFillField> {
  patch: Partial<Pick<ImportFillValues, Field>>
  suggestions: ImportFillSuggestion[]
}

type FillKind = 'text' | 'count'

/** projectDefault 是建库时 project_core 的列默认值：项目里仍是它，就当作者没设过。 */
const FILL_RULES: Record<ImportFillField, { kind: FillKind; suggest: boolean; projectDefault?: string | number }> = {
  genre: { kind: 'text', suggest: true },
  subGenre: { kind: 'text', suggest: true },
  targetAudience: { kind: 'text', suggest: true },
  totalChapters: { kind: 'count', suggest: false, projectDefault: 100 },
  wordsPerChapter: { kind: 'count', suggest: true, projectDefault: 3000 },
  plotStructure: { kind: 'text', suggest: true, projectDefault: 'three_act' },
  narrativePov: { kind: 'text', suggest: true, projectDefault: 'third_limited' },
  goldenFinger: { kind: 'text', suggest: true },
  globalGuidance: { kind: 'text', suggest: true },
  coreOutline: { kind: 'text', suggest: true },
  worldSetting: { kind: 'text', suggest: true },
  protagonistProfile: { kind: 'text', suggest: true },
  premise: { kind: 'text', suggest: true },
  worldbuilding: { kind: 'text', suggest: true },
  synopsis: { kind: 'text', suggest: true },
  writingStyle: { kind: 'text', suggest: true },
}

export const IMPORT_FILL_FIELDS = Object.keys(FILL_RULES) as ImportFillField[]

export function isImportFillValueEmpty(field: ImportFillField, value: unknown): boolean {
  if (FILL_RULES[field].kind === 'count') return !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  return typeof value !== 'string' || value.trim() === ''
}

function isProjectValueBlank(field: ImportFillField, value: unknown): boolean {
  return isImportFillValueEmpty(field, value) || value === FILL_RULES[field].projectDefault
}

function normalized(value: string | number): string | number {
  return typeof value === 'string' ? value.trim() : value
}

export function planImportFill<Field extends ImportFillField>(
  fields: readonly Field[],
  current: Partial<Record<Field, unknown>>,
  inferred: Pick<ImportFillValues, Field>,
): ImportFillPlan<Field> {
  const patch: Partial<Pick<ImportFillValues, Field>> = {}
  const suggestions: ImportFillSuggestion[] = []
  for (const field of fields) {
    const next = normalized(inferred[field])
    if (isImportFillValueEmpty(field, next)) continue
    const existing = current[field]
    if (isProjectValueBlank(field, existing)) {
      patch[field] = next as ImportFillValues[Field]
      continue
    }
    const kept = normalized(existing as string | number)
    if (FILL_RULES[field].suggest && kept !== next) suggestions.push({ field, current: kept, inferred: next })
  }
  return { patch, suggestions }
}
