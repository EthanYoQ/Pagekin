/**
 * Git 同步凭据：每个项目一份（按 projectId 索引），token 用系统钥匙串
 * （Electron safeStorage）加密后落盘；系统不给加密能力时只放内存，重启即失效。
 * 文件里永远不出现明文 token。
 */

import path from 'node:path'
import fs from 'node:fs'

import { getGlobalDataRoot } from './app-data-locator'
import type { SafeStorageLike } from './cloud-credential-store'

const STORE_FILE_NAME = 'git-sync-credentials.json'
const STORE_VERSION = 1
const MAX_ENTRIES = 64
const MAX_SECRET_BYTES = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export interface GitSyncCredentialMetadata {
  projectId: string
  username: string
  persistence: 'os-backed' | 'session-only'
}

export interface GitSyncCredentialSaveInput {
  projectId: string
  username: string
  token: string
}

export interface GitSyncResolvedCredential {
  metadata: GitSyncCredentialMetadata
  token: string | null
}

interface StoredEntry {
  projectId: string
  username: string
  encryptedTokenBase64: string
}

interface CredentialDocument {
  version: typeof STORE_VERSION
  entries: StoredEntry[]
}

interface SessionEntry {
  metadata: GitSyncCredentialMetadata
  token: string
}

export interface GitSyncCredentialStoreOptions {
  safeStorage: SafeStorageLike
  rootPath?: string
  platform?: NodeJS.Platform
}

function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function validUsername(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 1024) return false
  for (const character of trimmed) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return false
  }
  return true
}

function validToken(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) return false
  // token 不能跨行：git 的 askpass 是一次读一行。
  return !value.includes('\n') && !value.includes('\r') && !value.includes('\u0000')
}

function validBase64(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  try { return Buffer.from(value, 'base64').toString('base64') === value } catch { return false }
}

export class GitSyncCredentialStore {
  private readonly filePath: string
  private readonly safeStorage: SafeStorageLike
  private readonly platform: NodeJS.Platform
  private readonly session = new Map<string, SessionEntry>()

  constructor(options: GitSyncCredentialStoreOptions) {
    this.safeStorage = options.safeStorage
    this.platform = options.platform ?? process.platform
    this.filePath = path.join(options.rootPath ?? getGlobalDataRoot(), STORE_FILE_NAME)
  }

  save(input: GitSyncCredentialSaveInput): GitSyncCredentialMetadata {
    if (!validProjectId(input.projectId) || !validUsername(input.username) || !validToken(input.token)) {
      throw new Error('GIT_SYNC_INPUT_INVALID')
    }
    if (!this.persistentEncryptionAvailable()) {
      const metadata: GitSyncCredentialMetadata = {
        projectId: input.projectId, username: input.username, persistence: 'session-only',
      }
      this.session.set(input.projectId, { metadata, token: input.token })
      return metadata
    }
    let encryptedTokenBase64: string
    try {
      encryptedTokenBase64 = this.safeStorage.encryptString(input.token).toString('base64')
      if (!validBase64(encryptedTokenBase64)) throw new Error('encrypted token invalid')
    } catch {
      const metadata: GitSyncCredentialMetadata = {
        projectId: input.projectId, username: input.username, persistence: 'session-only',
      }
      this.session.set(input.projectId, { metadata, token: input.token })
      return metadata
    }
    const document = this.loadDocument()
    const entries = document.entries.filter(entry => entry.projectId !== input.projectId)
    entries.push({ projectId: input.projectId, username: input.username, encryptedTokenBase64 })
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
    this.write({ version: STORE_VERSION, entries })
    this.session.delete(input.projectId)
    return { projectId: input.projectId, username: input.username, persistence: 'os-backed' }
  }

  resolve(projectId: string): GitSyncResolvedCredential | null {
    if (!validProjectId(projectId)) return null
    const sessionEntry = this.session.get(projectId)
    if (sessionEntry) return { metadata: sessionEntry.metadata, token: sessionEntry.token }
    const stored = this.loadDocument().entries.find(entry => entry.projectId === projectId)
    if (!stored) return null
    const metadata: GitSyncCredentialMetadata = {
      projectId: stored.projectId, username: stored.username, persistence: 'os-backed',
    }
    if (!this.persistentEncryptionAvailable()) return { metadata, token: null }
    try {
      const token = this.safeStorage.decryptString(Buffer.from(stored.encryptedTokenBase64, 'base64'))
      return { metadata, token: validToken(token) ? token : null }
    } catch {
      return { metadata, token: null }
    }
  }

  forget(projectId: string): boolean {
    if (!validProjectId(projectId)) return false
    const removedSession = this.session.delete(projectId)
    const document = this.loadDocument()
    const entries = document.entries.filter(entry => entry.projectId !== projectId)
    if (entries.length === document.entries.length) return removedSession
    this.write({ version: STORE_VERSION, entries })
    return true
  }

  private loadDocument(): CredentialDocument {
    if (!fs.existsSync(this.filePath)) return { version: STORE_VERSION, entries: [] }
    let parsed: unknown
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) } catch { return { version: STORE_VERSION, entries: [] } }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: STORE_VERSION, entries: [] }
    const record = parsed as Record<string, unknown>
    if (record.version !== STORE_VERSION || !Array.isArray(record.entries)) return { version: STORE_VERSION, entries: [] }
    const seen = new Set<string>()
    const entries: StoredEntry[] = []
    for (const item of record.entries) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const entry = item as Record<string, unknown>
      if (!validProjectId(entry.projectId) || seen.has(entry.projectId)) continue
      if (!validUsername(entry.username) || !validBase64(entry.encryptedTokenBase64)) continue
      seen.add(entry.projectId)
      entries.push({
        projectId: entry.projectId,
        username: entry.username,
        encryptedTokenBase64: entry.encryptedTokenBase64,
      })
    }
    return { version: STORE_VERSION, entries }
  }

  private write(document: CredentialDocument): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    try { fs.chmodSync(this.filePath, 0o600) } catch { /* Windows 无 POSIX 模式 */ }
  }

  private persistentEncryptionAvailable(): boolean {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return false
      if (this.platform !== 'linux') return true
      const backend = this.safeStorage.getSelectedStorageBackend?.()
      return backend === 'gnome_libsecret' || backend === 'kwallet' || backend === 'kwallet5' || backend === 'kwallet6'
    } catch {
      return false
    }
  }
}
