import type { MigrationImplementation, SchemaReader } from './registry'

/** 不改表。版本号让 11 及更早的书童拒开新版写入的 v2 审修证明（ADR-0031）。 */
export function createM11Migration(deps: { verifyKnownSchema(reader: SchemaReader): boolean }): MigrationImplementation {
  return { id: 'M11', from: 11, to: 12, owner: 'review-proof-v2',
    migrate: () => undefined, verify: reader => deps.verifyKnownSchema(reader) }
}
