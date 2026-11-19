import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

/** 设定细则的 AI 来源标记（src/shared/novel-config-ai-sources.ts）。旧作品得到空标记，全部按作者内容显示。 */
export const M10_AI_SOURCES_SQL = `ALTER TABLE project_core ADD COLUMN ai_sources TEXT NOT NULL DEFAULT '{}';`
export const M10_PROJECT_CORE_COLUMNS = ['ai_sources'] as const

export function applyM10AiSources(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('M10_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M10_AI_SOURCES_SQL)
}

export function createM10Migration(deps: { database(reader: SchemaReader): Database.Database; verifyKnownSchema(reader: SchemaReader): boolean }): MigrationImplementation {
  return { id: 'M10', from: 10, to: 11, owner: 'setup-ai-sources',
    migrate: reader => applyM10AiSources(deps.database(reader)), verify: reader => deps.verifyKnownSchema(reader) }
}
