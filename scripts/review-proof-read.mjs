import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = buildSync({ entryPoints: [path.join(ROOT, 'src/shared/review-proof.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { readReviewProof } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`)
const sha256 = text => createHash('sha256').update(text).digest('hex')

/** 三态读取（absent / unproven / recomputable），与生产同一实现。 */
export const reviewProof = sourceManifest => readReviewProof(sourceManifest, sha256)

/** 脚本读运行里冻结的审修证明，与生产同走 readReviewProof；v1、v2 都认。 */
export function frozenReviewContext(sourceManifest) {
  const proof = reviewProof(sourceManifest)
  if (proof.kind !== 'recomputable') throw new Error('AI_REVIEW_CONTEXT_UNPROVEN')
  return proof.context
}
