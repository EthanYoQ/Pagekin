import { app } from 'electron'
import { handle } from '../ipc/handle'
import { showOpenDialogInLastDirectory } from '../utils/remembered-dialog'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type {
  CharacterAvatarBatchReadResponse,
  CharacterAvatarChooseResponse,
  CharacterAvatarCommitResponse,
  CharacterAvatarRemoveResponse,
  CharacterAvatarView,
} from '../../src/shared/character-avatar'
import { mainText } from '../i18n'
import type { CharacterAssetService } from '../services/character-asset-service'

interface AvatarEvent {
  sender?: { id?: number; isDestroyed?: () => boolean }
}

export interface CharacterAvatarControllerDependencies {
  /** Must validate event + projectId + leaseId + canonical root before returning. */
  resolveService(event: AvatarEvent, context: ProjectSessionContext): CharacterAssetService | null
}

function text(zh: string, en: string): string { return mainText(app.getLocale(), zh, en) }

/** 资产服务抛的码换成头像专用的已登记码：同名通用码在别处另有说法。 */
const FAILURES = {
  INVALID_SENDER: 'CHARACTER_AVATAR_SENDER_INVALID',
  INVALID_CHARACTER_ID: 'CHARACTER_AVATAR_ID_INVALID',
  PROJECT_NOT_OPEN: 'CHARACTER_AVATAR_PROJECT_NOT_OPEN',
  CHARACTER_NOT_FOUND: 'CHARACTER_AVATAR_CHARACTER_NOT_FOUND',
  IMAGE_READ_FAILED: 'CHARACTER_AVATAR_IMAGE_READ_FAILED',
  IMAGE_FORMAT_INVALID: 'CHARACTER_AVATAR_IMAGE_FORMAT_INVALID',
  IMAGE_TOO_LARGE: 'CHARACTER_AVATAR_IMAGE_TOO_LARGE',
  AVATAR_SAVE_FAILED: 'CHARACTER_AVATAR_SAVE_FAILED',
} as const
type AvatarFailure = keyof typeof FAILURES

function failure(reason: AvatarFailure) {
  return { code: FAILURES[reason] }
}

function validSender(event: AvatarEvent): boolean {
  return Boolean(event.sender && Number.isSafeInteger(event.sender.id) && (event.sender.id ?? 0) > 0
    && typeof event.sender.isDestroyed === 'function' && !event.sender.isDestroyed())
}

function errorCode(error: unknown): AvatarFailure {
  if (error instanceof Error && [
    'INVALID_CHARACTER_ID', 'CHARACTER_NOT_FOUND', 'IMAGE_READ_FAILED', 'IMAGE_FORMAT_INVALID', 'IMAGE_TOO_LARGE',
  ].includes(error.message)) return error.message as AvatarFailure
  return 'AVATAR_SAVE_FAILED'
}
const CHARACTER_ID = /^[a-zA-Z0-9_-]{1,128}$/u

function serviceFor(deps: CharacterAvatarControllerDependencies, event: AvatarEvent, context: ProjectSessionContext): CharacterAssetService | null {
  if (!validSender(event) || !isProjectSessionContext(context)) return null
  return deps.resolveService(event, context)
}

export function registerCharacterAvatarController(deps: CharacterAvatarControllerDependencies): void {
  let mutationTail: Promise<void> = Promise.resolve()
  const cache = new Map<string, CharacterAvatarView>()
  let activeScope = ''
  const serialize = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const scheduled = mutationTail.then(operation, operation)
    mutationTail = scheduled.then(() => undefined, () => undefined)
    return scheduled
  }
  const scopePrefix = (context: ProjectSessionContext) => `${context.projectId}\u0000${context.leaseId}\u0000`
  const enterScope = (context: ProjectSessionContext) => {
    const next = scopePrefix(context)
    if (activeScope && activeScope !== next) cache.clear()
    activeScope = next
  }
  const invalidate = (context: ProjectSessionContext, characterId: string) => {
    const prefix = `${scopePrefix(context)}${characterId}\u0000`
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
  }

  handle('character-avatar:choose', (event: AvatarEvent, characterId: string, context: ProjectSessionContext): Promise<CharacterAvatarChooseResponse> => serialize(async () => {
    if (!validSender(event)) return { success: false, failure: failure('INVALID_SENDER') }
    const service = serviceFor(deps, event, context)
    if (!service) return { success: false, failure: failure('PROJECT_NOT_OPEN') }
    enterScope(context)
    if (!service.hasCharacter(characterId)) return { success: false, failure: failure('CHARACTER_NOT_FOUND') }
    let selection: Awaited<ReturnType<typeof showOpenDialogInLastDirectory>>
    try { selection = await showOpenDialogInLastDirectory('character-avatar', { title: text('选择角色头像', 'Choose a character avatar'),
      properties: ['openFile'], filters: [{ name: 'PNG / JPEG / WebP', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }) }
    catch { return { success: false, failure: failure('IMAGE_READ_FAILED') } }
    if (selection.canceled || selection.filePaths.length === 0) return { success: true, cancelled: true }
    if (selection.filePaths.length !== 1) return { success: false, failure: failure('IMAGE_READ_FAILED') }
    try { return { success: true, cancelled: false, image: await service.previewFile(characterId, selection.filePaths[0]!) } }
    catch (error) { return { success: false, failure: failure(errorCode(error)) } }
  }))

  handle('character-avatar:commit', (event: AvatarEvent, characterId: string, base64: string, context: ProjectSessionContext): Promise<CharacterAvatarCommitResponse> => serialize(async () => {
    if (!validSender(event)) return { success: false, failure: failure('INVALID_SENDER') }
    const service = serviceFor(deps, event, context)
    if (!service) return { success: false, failure: failure('PROJECT_NOT_OPEN') }
    enterScope(context)
    try {
      const avatar = service.commit(characterId, base64)
      invalidate(context, characterId)
      return { success: true, avatar }
    } catch (error) { return { success: false, failure: failure(errorCode(error)) } }
  }))

  handle('character-avatar:read-batch', async (event: AvatarEvent, characterIds: string[], context: ProjectSessionContext): Promise<CharacterAvatarBatchReadResponse> => {
    if (!validSender(event)) return { success: false, failure: failure('INVALID_SENDER') }
    const service = serviceFor(deps, event, context)
    if (!service) return { success: false, failure: failure('PROJECT_NOT_OPEN') }
    enterScope(context)
    try {
      if (!Array.isArray(characterIds) || characterIds.length > 256
        || characterIds.some(id => typeof id !== 'string' || !CHARACTER_ID.test(id))) throw new Error('INVALID_CHARACTER_ID')
      const records = service.repository.readMany([...new Set(characterIds)])
      const result: CharacterAvatarView[] = []
      const missing: string[] = []
      for (const record of records) {
        const key = `${scopePrefix(context)}${record.characterId}\u0000${record.assetRevision}`
        const cached = cache.get(key)
        if (cached) result.push(cached)
        else missing.push(record.characterId)
      }
      for (const avatar of missing.length ? service.readMany(missing) : []) {
        cache.set(`${scopePrefix(context)}${avatar.characterId}\u0000${avatar.assetRevision}`, avatar)
        if (cache.size > 512) cache.delete(cache.keys().next().value!)
        result.push(avatar)
      }
      return { success: true, avatars: result }
    } catch (error) { return { success: false, failure: failure(errorCode(error)) } }
  })

  handle('character-avatar:remove', (event: AvatarEvent, characterId: string, context: ProjectSessionContext): Promise<CharacterAvatarRemoveResponse> => serialize(async () => {
    if (!validSender(event)) return { success: false, failure: failure('INVALID_SENDER') }
    const service = serviceFor(deps, event, context)
    if (!service) return { success: false, failure: failure('PROJECT_NOT_OPEN') }
    enterScope(context)
    try { service.remove(characterId); invalidate(context, characterId); return { success: true } }
    catch (error) { return { success: false, failure: failure(errorCode(error)) } }
  }))
}
