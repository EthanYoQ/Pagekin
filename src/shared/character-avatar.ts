import type { Failure } from './failure'

export const MAX_CHARACTER_AVATAR_INPUT_BYTES = 4 * 1024 * 1024

export interface CharacterAvatarView {
  characterId: string
  assetRevision: number
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  base64: string
}

export type CharacterAvatarAssetMime = CharacterAvatarView['mime'] | 'application/octet-stream'

export type CharacterAvatarChooseResponse =
  | { success: true; cancelled: true }
  | { success: true; cancelled: false; image: Omit<CharacterAvatarView, 'assetRevision'> }
  | { success: false; failure?: Failure }

export type CharacterAvatarCommitResponse =
  | { success: true; avatar: CharacterAvatarView }
  | { success: false; failure?: Failure }

export type CharacterAvatarBatchReadResponse =
  | { success: true; avatars: CharacterAvatarView[] }
  | { success: false; failure?: Failure }

export type CharacterAvatarRemoveResponse =
  | { success: true }
  | { success: false; failure?: Failure }

export interface CharacterAvatarChannels {
  'character-avatar:choose': {
    args: [characterId: string]
    return: CharacterAvatarChooseResponse
  }
  'character-avatar:commit': {
    args: [characterId: string, base64: string]
    return: CharacterAvatarCommitResponse
  }
  'character-avatar:read-batch': {
    args: [characterIds: string[]]
    return: CharacterAvatarBatchReadResponse
  }
  'character-avatar:remove': {
    args: [characterId: string]
    return: CharacterAvatarRemoveResponse
  }
}

export type PortableCharacterAvatarRow =
  | {
    kind: 'bound'
    characterId: string
    assetRevision: number
    relativePath: string
    contentHash: string
    mime: CharacterAvatarAssetMime
    byteSize: number
  }
  | {
    kind: 'unresolved'
    recordId: string
    disposition: 'orphan' | 'ambiguous' | 'unknown-fork'
    sourceReference: string
    sourceRelativePath: string
    relativePath: string
    contentHash: string
    mime: CharacterAvatarAssetMime
    byteSize: number
    candidateCharacterIds: string[]
  }
  | {
    kind: 'unresolved-reference'
    recordId: string
    disposition: 'reference-only'
    sourceReference: string
    sourceRelativePath: string
    candidateCharacterIds: string[]
  }
