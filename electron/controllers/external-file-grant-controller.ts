import path from 'node:path'
import { app } from 'electron'
import { wireNote } from '../../src/i18n/app-errors'
import type { FailureCode, WireFailure } from '../../src/shared/failure'
import { handle } from '../ipc/handle'
import { showOpenDialogInLastDirectory } from '../utils/remembered-dialog'
import {
  ExternalFileGrantService,
  type ResolvedExternalFileGrant,
  externalFileGrants,
} from '../services/external-file-grant-service'
import { mainText } from '../i18n'
import { externalFileReadFailure } from './external-file-read-failure'
import {
  atomicWriteFailureCommitState,
  windowsSafeFileSystem,
  type WindowsSafeFileSystem,
} from '../security/windows-safe-file-system'

const EXPORT_GRANT_TTL_MS = 10 * 60 * 1_000
const EXPORT_GRANT_MAX_USES = 4_096

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

type GrantFailure = readonly [code: FailureCode, key: Parameters<typeof wireNote>[0]]
const EXPIRED: GrantFailure = ['EXTERNAL_FILE_GRANT_EXPIRED', 'error.externalGrantExpired']
const DENIED: GrantFailure = ['EXTERNAL_FILE_GRANT_OPERATION_DENIED', 'error.externalGrantWrongWindow']
const INVALID_PATH: GrantFailure = ['EXTERNAL_FILE_GRANT_PATH_INVALID', 'error.externalGrantPathInvalid']
const UNAVAILABLE: GrantFailure = ['EXTERNAL_FILE_SERVICE_UNAVAILABLE', 'error.externalFileServiceUnavailable']

/** 授权服务与安全文件系统的错误码 → 码与目录说明；不把文件系统绝对路径或内部服务错误原样回传给渲染层。 */
const GRANT_FAILURES: Readonly<Record<string, GrantFailure>> = {
  EXTERNAL_FILE_GRANT_NOT_FOUND: EXPIRED,
  EXTERNAL_FILE_GRANT_EXPIRED: EXPIRED,
  EXTERNAL_FILE_GRANT_EXHAUSTED: EXPIRED,
  EXTERNAL_FILE_GRANT_WRONG_WINDOW: DENIED,
  EXTERNAL_FILE_GRANT_OPERATION_DENIED: DENIED,
  EXTERNAL_FILE_GRANT_PATH_ABSOLUTE: INVALID_PATH,
  EXTERNAL_FILE_GRANT_PATH_INVALID: INVALID_PATH,
  EXTERNAL_FILE_GRANT_PATH_TRAVERSAL: INVALID_PATH,
  EXTERNAL_FILE_GRANT_SUBPATH_REJECTED: INVALID_PATH,
  EXTERNAL_FILE_GRANT_SCOPE_MISMATCH: INVALID_PATH,
  EXTERNAL_FILE_GRANT_TARGET_CHANGED: INVALID_PATH,
  EXTERNAL_FILE_GRANT_TARGET_INVALID: INVALID_PATH,
  SECURE_FS_REPARSE_POINT: INVALID_PATH,
  SECURE_FS_INVALID_PATH: INVALID_PATH,
  SECURE_FS_NOT_FOUND: INVALID_PATH,
  SECURE_FS_UNSUPPORTED_PLATFORM: UNAVAILABLE,
  SECURE_FS_HELPER_UNAVAILABLE: UNAVAILABLE,
  SECURE_FS_HELPER_TIMEOUT: UNAVAILABLE,
  SECURE_FS_TARGET_IN_USE: ['SECURE_FS_TARGET_IN_USE', 'error.exportTargetInUse'],
}

function grantFailure(error: unknown): WireFailure {
  const code = error instanceof Error ? error.message : String(error)
  const [failure, key] = Object.hasOwn(GRANT_FAILURES, code)
    ? GRANT_FAILURES[code]
    : ['EXTERNAL_FILE_GRANT_FAILED', 'error.externalGrantFailed'] as const
  return { code: failure, note: wireNote(key) }
}

type GrantEvent = {
  sender: {
    id: number
    once: (event: 'destroyed', listener: () => void) => unknown
  }
}

function revokeWhenSenderIsDestroyed(event: GrantEvent, grants: ExternalFileGrantService): void {
  const webContentsId = event.sender.id
  event.sender.once('destroyed', () => grants.revokeWebContents(webContentsId))
}

function resolveGrantPath(
  grants: ExternalFileGrantService,
  event: GrantEvent,
  grantId: string,
  operation: 'read' | 'list' | 'write' | 'create',
  relativePath?: string,
  consumeUse = true,
): ResolvedExternalFileGrant {
  const resolver = consumeUse ? grants.resolve.bind(grants) : grants.revalidate.bind(grants)
  return resolver({
    grantId,
    webContentsId: event.sender.id,
    operation,
    relativePath,
  })
}

/**
 * 授权型外部文件入口。这里永远不接受渲染层提供的绝对路径；路径只来自
 * 主进程文件选择器，并被转换为绑定 webContents 的短期授权标识。
 */
export function registerExternalFileGrantController(
  grants: ExternalFileGrantService = externalFileGrants,
  fileSystem: WindowsSafeFileSystem = windowsSafeFileSystem,
): void {
  handle('dialog:select-export-directory', async (event: GrantEvent) => {
    const result = await showOpenDialogInLastDirectory('export-directory', {
      title: text('选择导出目录', 'Choose an export directory'),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directoryPath = result.filePaths[0]
    const grant = grants.issueDirectory({
      webContentsId: event.sender.id,
      directoryPath,
      operations: ['write', 'create'],
      ttlMs: EXPORT_GRANT_TTL_MS,
      maxUses: EXPORT_GRANT_MAX_USES,
    })
    revokeWhenSenderIsDestroyed(event, grants)
    return {
      grantId: grant.grantId,
      displayName: path.basename(directoryPath),
    }
  })

  handle(
    'fs:grant-read-file',
    async (event: GrantEvent, grantId: string, relativePath?: string) => {
      let target: ResolvedExternalFileGrant
      try {
        target = resolveGrantPath(grants, event, grantId, 'read', relativePath)
      } catch (error) {
        return { success: false, content: '', failure: grantFailure(error) }
      }
      try {
        return { success: true, content: await fileSystem.readText(target) }
      } catch (error) {
        return { success: false, content: '', failure: externalFileReadFailure(error) }
      }
    },
  )

  handle(
    'fs:grant-write-file',
    async (event: GrantEvent, grantId: string, relativePath: string, content: string) => {
      try {
        const target = resolveGrantPath(grants, event, grantId, 'write', relativePath)
        resolveGrantPath(grants, event, grantId, 'create', relativePath, false)
        await fileSystem.writeTextAtomically(target, content, () => {
          resolveGrantPath(grants, event, grantId, 'write', relativePath, false)
          resolveGrantPath(grants, event, grantId, 'create', relativePath, false)
        })
        return { success: true }
      } catch (error) {
        return {
          success: false,
          commitState: atomicWriteFailureCommitState(error) ?? 'not_committed',
          failure: grantFailure(error),
        }
      }
    },
  )

  handle(
    'fs:grant-mkdir',
    async (event: GrantEvent, grantId: string, relativePath: string) => {
      try {
        const target = resolveGrantPath(grants, event, grantId, 'create', relativePath)
        await fileSystem.mkdir(target)
        return { success: true }
      } catch (error) {
        return { success: false, failure: grantFailure(error) }
      }
    },
  )
}
