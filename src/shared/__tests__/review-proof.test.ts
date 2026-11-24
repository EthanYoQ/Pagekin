import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, repoSourceFiles } from '../../../test/helpers/repo-source-files'

const READ_POINT = 'src/shared/review-proof.ts'
const capturedBindingInput = (file: string, before: string) => file === 'electron/services/generation-source-binding.ts' && before.endsWith('input')
const MANIFEST_READ = /(?:\?\.|\.)reviewRevisionContext(?:Hash)?\b|\$\.sourceManifest\.reviewRevisionContext|\[\s*['"]reviewRevisionContext|\{[^}]*\breviewRevisionContext(?:Hash)?\b[^}]*\}\s*=(?!=)/gu

const sourceFiles = (dir: string) => repoSourceFiles(dir)
  .filter(file => !file.includes('/__tests__/') && /\.(?:tsx?|mjs)$/u.test(file) && !/\.(test|browser)\.(?:tsx?|mjs)$/u.test(file))

function directReads(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, index) => [...line.matchAll(MANIFEST_READ)]
    .filter(match => !capturedBindingInput(file, line.slice(0, match.index)))
    .map(() => `${file}:${index + 1}`))
}

describe('审修证明只在 readReviewProof 一处解析（#702 不变式 1）', () => {
  it('非测试代码不直接读 sourceManifest 里的审修上下文', () => {
    const reads = ['electron', 'src', 'scripts'].flatMap(dir => sourceFiles(dir)).filter(file => file !== READ_POINT)
      .flatMap(file => directReads(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')))

    expect(reads).toEqual([])
  })

  it('解构读取也算直接读', () => {
    expect(directReads('a.ts', 'const { reviewRevisionContext } = manifest')).toEqual(['a.ts:1'])
    expect(directReads('a.ts', 'const { operation, reviewRevisionContextHash: hash } = binding.sourceManifest')).toEqual(['a.ts:1'])
    expect(directReads('a.ts', 'if ({ reviewRevisionContext: x } === y) return')).toEqual([])
  })
})
