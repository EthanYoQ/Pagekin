export interface FrontmatterResult {
  frontmatter: string
  body: string
}

export function extractFrontmatter(content: string): FrontmatterResult {
  const match = content.match(
    /^(---\r?\n[\s\S]*?\r?\n---(?:(?:\r?\n){1,2}|$))/
  )
  if (!match) {
    return { frontmatter: '', body: content }
  }
  return {
    frontmatter: match[1],
    body: content.slice(match[1].length),
  }
}

export function mergeFrontmatterBody(frontmatter: string, body: string): string {
  if (!frontmatter) return body
  const fm = frontmatter.endsWith('\n') ? frontmatter : frontmatter + '\n'
  return fm + body
}
