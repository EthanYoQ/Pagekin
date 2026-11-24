import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, repoSourceFiles } from '../../test/helpers/repo-source-files'

const productionStyleSources = () => repoSourceFiles('src').filter(file => !file.includes('/__tests__/') && /\.(?:tsx|css)$/.test(file))

describe('semantic status text source contract', () => {
  it('does not encode information or category text with fixed Tailwind palette classes', () => {
    const violations = productionStyleSources().flatMap((path) => {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8')
      return [...source.matchAll(/text-(?:red|green|yellow|amber|orange|blue|purple|violet|indigo|emerald|teal|cyan|sky|lime|rose|pink|fuchsia)-\d+(?:\/\d+)?/g)]
        .map((match) => `${path}:${match[0]}`)
    })

    expect(violations).toEqual([])
  })

  it('limits decoration-only status colors to an explicit reviewed allowlist', () => {
    const allowed = new Set([
      'src/styles/agent-tools.css:.tool-call-status.completed',
      'src/styles/agent-tools.css:.tool-call-status.failed',
      'src/styles/agent-tools.css:.tool-call-status.waiting_confirm',
      'src/styles/agent-tools.css:.confirm-card-btn.approve',
    ])
    const violations = productionStyleSources().flatMap((path) => {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8')
      if (path.endsWith('index.css') || path.endsWith('agent-tools.css')) {
        return [...source.matchAll(/([^{}]+)\{[^{}]*color:\s*var\(--color-(?:success|error|warning)\);[^{}]*\}/g)]
          .map((match) => `${path}:${match[1].trim()}`)
          .filter((entry) => !allowed.has(entry))
      }
      return []
    })

    expect(violations).toEqual([])
  })
})
