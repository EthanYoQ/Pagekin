interface RelationshipFact {
  from: string
  to: string
  relation: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function relationshipFacts(hints: unknown): RelationshipFact[] {
  if (!Array.isArray(hints)) return []
  return hints.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const rawFrom = candidate.from ?? candidate.source
    const rawTo = candidate.to ?? candidate.target
    if (
      typeof rawFrom !== 'string'
      || !rawFrom.trim()
      || typeof rawTo !== 'string'
      || !rawTo.trim()
    ) return []
    const relation = typeof candidate.relation === 'string' && candidate.relation.trim()
      ? candidate.relation.trim()
      : '相关'
    return [{ from: rawFrom.trim(), to: rawTo.trim(), relation }]
  })
}

