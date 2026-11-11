const MAX_TERMS = 48
const K1 = 1.2
const B = 0.75

/** 中文没有空格分词，连续汉字拆成相邻二元组；其他文字和数字按整词。 */
export function fullTextTerms(query: string): string[] {
  const words = query.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}-])+/gu) ?? []
  const terms = words.flatMap(word => {
    const chars = Array.from(word)
    return /\p{Script=Han}/u.test(word) && chars.length > 2 ? chars.slice(1).map((char, index) => chars[index] + char) : [word]
  })
  const meaningful = terms.filter(term => Array.from(term).length >= 2)
  return [...new Set(meaningful.length ? meaningful : terms)].slice(0, MAX_TERMS)
}

export function fullTextFilter(terms: readonly string[]): string {
  return terms.length ? `(${terms.map(term => `text LIKE '%${term.replace(/'/g, "''")}%'`).join(' OR ')})` : "text LIKE '%%'"
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function occurrences(text: string, term: string): number {
  let count = 0
  for (let index = text.indexOf(term); index >= 0; index = text.indexOf(term, index + term.length)) count++
  return count
}

/**
 * 区分大小写计数，与 LIKE 筛行一致，没命中的行不进统计，所以传全部段落和只传筛出的行排序相同。
 * 排序结果只由分数、正文、文件名决定，与行 id 和导入顺序无关。
 */
export function rankFullText<T extends { text: string; fileName: string }>(rows: readonly T[], terms: readonly string[], totalRows: number): { row: T; score: number }[] {
  const counted = rows.map(row => ({ row, length: Array.from(row.text).length, counts: terms.map(term => occurrences(row.text, term)) }))
  const matched = counted.filter(item => item.counts.some(count => count > 0))
  const averageLength = matched.reduce((sum, item) => sum + item.length, 0) / matched.length
  const idf = terms.map((_, index) => {
    const df = matched.filter(item => item.counts[index] > 0).length
    return Math.log(1 + (totalRows - df + 0.5) / (df + 0.5))
  })
  return counted
    .map(({ row, length, counts }) => ({
      row,
      score: counts.reduce((sum, count, index) => count
        ? sum + idf[index] * count * (K1 + 1) / (count + K1 * (1 - B + B * length / averageLength))
        : sum, 0),
    }))
    .sort((left, right) => right.score - left.score || compare(left.row.text, right.row.text) || compare(left.row.fileName, right.row.fileName))
}

export function firstOfEach<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const value = key(item)
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}
