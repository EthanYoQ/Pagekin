import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../..')
const READ_POINT = 'src/shared/review-proof.ts'
const capturedBindingInput = (file: string, before: string) => file === 'electron/services/generation-source-binding.ts' && before.endsWith('input')
const MANIFEST_READ = /(?:\?\.|\.)reviewRevisionContext(?:Hash)?\b|\$\.sourceManifest\.reviewRevisionContext|\[\s*['"]reviewRevisionContext/gu

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(relative)
    return /\.tsx?$/u.test(entry.name) && !/\.(test|browser)\.tsx?$/u.test(entry.name) ? [relative] : []
  })
}

describe('审修证明只在 readReviewProof 一处解析（#702 不变式 1）', () => {
  it('非测试代码不直接读 sourceManifest 里的审修上下文', () => {
    const reads = ['electron', 'src'].flatMap(sourceFiles).filter(file => file !== READ_POINT).flatMap(file =>
      fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').flatMap((line, index) =>
        [...line.matchAll(MANIFEST_READ)]
          .filter(match => !capturedBindingInput(file, line.slice(0, match.index)))
          .map(() => `${file}:${index + 1}`)))

    expect(reads).toEqual([])
  })
})
