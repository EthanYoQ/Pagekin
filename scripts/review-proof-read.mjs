import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = buildSync({ entryPoints: [path.join(ROOT, 'src/shared/review-proof.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { readReviewProof } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`)
const sha256 = text => createHash('sha256').update(text).digest('hex')

export const reviewProof = sourceManifest => readReviewProof(sourceManifest, sha256)

export function frozenReviewContext(sourceManifest) {
  const proof = reviewProof(sourceManifest)
  if (proof.kind !== 'recomputable') throw new Error('AI_REVIEW_CONTEXT_UNPROVEN')
  return proof.context
}
