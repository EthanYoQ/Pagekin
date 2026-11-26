import path from 'node:path'
import type { IpcFailure } from '../../src/shared/failure'
import { wireNote } from '../../src/i18n/app-errors'
import { CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE } from '../../src/shared/project-format'

export const PROJECT_STORAGE_PATH_UNSUPPORTED = 'PROJECT_STORAGE_PATH_UNSUPPORTED' as const

const WINDOWS_NATIVE_PATH_LIMIT = 259
const LANCE_DATA_FILE_PLACEHOLDER = `${'0'.repeat(56)}.lance`
const CHARACTER_AVATAR_FILE_PLACEHOLDER = `${'0'.repeat(20)}-${'0'.repeat(64)}.jpeg`
const PROJECT_CORE_STORAGE_RELATIVE_PATHS = [
  path.win32.join('.vela', 'vela.db-wal'),
  path.win32.join(CANONICAL_PROJECT_DIRECTORY, `${CANONICAL_PROJECT_DATABASE}-wal`),
] as const
const PROJECT_CHARACTER_ASSET_RELATIVE_PATHS = [
  path.win32.join(CANONICAL_PROJECT_DIRECTORY, 'avatars', '0'.repeat(64), CHARACTER_AVATAR_FILE_PLACEHOLDER),
] as const
const PROJECT_KNOWLEDGE_STORAGE_RELATIVE_PATHS = [
  path.win32.join(CANONICAL_PROJECT_DIRECTORY, `embedding-spaces.json.${'0'.repeat(36)}.tmp`),
  path.win32.join(
    CANONICAL_PROJECT_DIRECTORY,
    'lancedb',
    'chunks__space_2147483647.lance',
    'data',
    LANCE_DATA_FILE_PLACEHOLDER,
  ),
] as const

export interface ProjectStoragePreflightOptions {
  platform?: NodeJS.Platform
  maxNativePathCharacters?: number
}

export class ProjectStoragePreflightError extends Error {
  readonly code = PROJECT_STORAGE_PATH_UNSUPPORTED

  constructor(
    readonly projectRootLength: number,
    readonly maxProjectRootLength: number,
    readonly storage: 'project' | 'knowledge-base',
  ) {
    super(
      storage === 'project'
        ? `项目路径过深，打不开项目数据库。请把项目文件夹移到靠近磁盘根目录处（例如 D:\\Novels），路径不超过 ${maxProjectRootLength} 个字符。`
        : `项目路径过深，知识库不可用，项目内容仍可打开和导出。请把项目文件夹移到靠近磁盘根目录处（例如 D:\\Novels），路径不超过 ${maxProjectRootLength} 个字符。`,
    )
    this.name = 'ProjectStoragePreflightError'
  }
}

type ProjectStorageFailure = IpcFailure & {
  errorCode: typeof PROJECT_STORAGE_PATH_UNSUPPORTED
  error: string
}

/** Accept the local class and Errors crossing a module/realm seam, never plain objects. */
export function isProjectStoragePreflightError(
  error: unknown,
): error is Error & { code: typeof PROJECT_STORAGE_PATH_UNSUPPORTED } {
  return error instanceof Error
    && 'code' in error
    && error.code === PROJECT_STORAGE_PATH_UNSUPPORTED
}

export function projectStoragePreflightFailure(
  error: unknown,
): ProjectStorageFailure | undefined {
  if (!isProjectStoragePreflightError(error)) return undefined
  const note = error instanceof ProjectStoragePreflightError
    ? wireNote(error.storage === 'project' ? 'error.projectPathTooDeepForDatabase' : 'error.projectPathTooDeepForKnowledgeBase', { max: error.maxProjectRootLength })
    : undefined
  return {
    success: false,
    errorCode: PROJECT_STORAGE_PATH_UNSUPPORTED,
    error: error.message,
    failure: { code: PROJECT_STORAGE_PATH_UNSUPPORTED, ...(note ? { note } : {}) },
  }
}

/**
 * Validate every fixed native-storage leaf before any project write occurs.
 * LanceDB currently has the longest derived path, but keeping the full list
 * here prevents SQLite or registry changes from silently weakening the gate.
 */
function assertDerivedStoragePathsSupported(
  projectRoot: string,
  relativePaths: readonly string[],
  storage: 'project' | 'knowledge-base',
  options: ProjectStoragePreflightOptions = {},
): void {
  if ((options.platform ?? process.platform) !== 'win32') return

  const maxNativePathCharacters = options.maxNativePathCharacters ?? WINDOWS_NATIVE_PATH_LIMIT
  const longestRelativePathLength = Math.max(...relativePaths.map(candidate => candidate.length))
  const maxProjectRootLength = maxNativePathCharacters - 1 - longestRelativePathLength
  const longestDerivedPathLength = projectRoot.length + 1 + longestRelativePathLength
  if (longestDerivedPathLength <= maxNativePathCharacters) return

  throw new ProjectStoragePreflightError(projectRoot.length, maxProjectRootLength, storage)
}

export function assertProjectStoragePathSupported(
  projectRoot: string,
  options: ProjectStoragePreflightOptions = {},
): void {
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_CORE_STORAGE_RELATIVE_PATHS, 'project', options)
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_CHARACTER_ASSET_RELATIVE_PATHS, 'project', options)
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_KNOWLEDGE_STORAGE_RELATIVE_PATHS, 'knowledge-base', options)
}

/** Temporary and isolated roots can exceed the final layout length on Windows. */
export function assertProjectMigrationPathsSupported(projectRoot: string, options: ProjectStoragePreflightOptions = {}): void {
  const migrationRoot = path.win32.join('.ai-novel-migration', `${'0'.repeat(36)}.vector-snapshot`)
  assertDerivedStoragePathsSupported(projectRoot, [
    path.win32.join('.ai-novel', 'project.db-wal'),
    path.win32.join('.ai-novel-migration', `${'0'.repeat(36)}.staging`, 'avatars', '0'.repeat(64), CHARACTER_AVATAR_FILE_PLACEHOLDER),
    path.win32.join(migrationRoot, 'lancedb', 'chunks__space_2147483647.lance', 'data', LANCE_DATA_FILE_PLACEHOLDER),
  ], 'project', options)
}

export function assertProjectCoreStoragePathSupported(
  projectRoot: string,
  options: ProjectStoragePreflightOptions = {},
): void {
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_CORE_STORAGE_RELATIVE_PATHS, 'project', options)
}

export function assertKnowledgeBaseStoragePathSupported(
  projectRoot: string,
  options: ProjectStoragePreflightOptions = {},
): void {
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_KNOWLEDGE_STORAGE_RELATIVE_PATHS, 'knowledge-base', options)
}
