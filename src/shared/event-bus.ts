import type { ProjectSessionContext } from './ipc-channels'

export type GlobalEventType =
  | 'REFRESH_RESOURCE'
  | 'WORKFLOW_COMPLETE'
  | 'WORKFLOW_ERROR'
  | 'ARCH_POSTPROCESS_UPDATED'
  | 'CHARACTER_EXTRACT_FAILED'
  | 'ARCH_FILE_UPDATED'
  | 'FINALIZE_COMPLETE'
  | 'CHAPTER_DELETION_UPDATED'
  | 'PLANNING_RECOVERY_CHANGED'
  | 'EDITOR_RECOVERY_DELIVERED'
  | 'PROJECT_CHANGED'
  | 'SYSTEM_NOTICE'

export interface EventPayloadMap {
  'REFRESH_RESOURCE': {
    resources: Array<'fileTree' | 'characterCards' | 'drafts' | 'blueprints' | 'all'>
    projectPath: string
    projectSession: ProjectSessionContext
  }
  'WORKFLOW_COMPLETE': {
    type: string
    projectPath: string
    projectSession: ProjectSessionContext
    runId: string
  }
  'WORKFLOW_ERROR': {
    title: string
    error: string
    stack?: string
  }
  'ARCH_POSTPROCESS_UPDATED': {
    projectPath: string
    projectSession: ProjectSessionContext
    runId: string
  }
  'CHARACTER_EXTRACT_FAILED': {
    projectPath: string
    projectSession: ProjectSessionContext
    runId: string
    error?: string
  }
  'ARCH_FILE_UPDATED': {
    fileName: string
    projectPath: string
    projectSession: ProjectSessionContext
    runId: string
  }
  'FINALIZE_COMPLETE': {
    tabId: string
    chapterNumber: number
    chapterTitle: string
    projectPath: string
    projectSession: ProjectSessionContext
    draftId: number
    finalizationId: string
    contentHash: string
    contentRevision: number
    snapshotContent: string
    publicationStatus: 'pending' | 'published'
    source?: 'manual' | 'batch'
  }
  'CHAPTER_DELETION_UPDATED': {
    projectPath: string
    projectSession: ProjectSessionContext
  }
  'PLANNING_RECOVERY_CHANGED': {
    projectSession: ProjectSessionContext
  }
  'EDITOR_RECOVERY_DELIVERED': {
    projectSession: ProjectSessionContext
  }
  'PROJECT_CHANGED': {
    projectPath: string
    projectSession: ProjectSessionContext
  }
  'SYSTEM_NOTICE': {
    level: 'info' | 'success' | 'warn' | 'error'
    message: string
  }
}

class EventBus {
  private target = new EventTarget()

  emit<K extends GlobalEventType>(type: K, payload: EventPayloadMap[K]) {
    this.target.dispatchEvent(new CustomEvent(type, { detail: payload }))
  }

  on<K extends GlobalEventType>(type: K, handler: (payload: EventPayloadMap[K]) => void): () => void {
    const listener = (event: Event) => {
      handler((event as CustomEvent).detail)
    }
    this.target.addEventListener(type, listener)
    return () => this.target.removeEventListener(type, listener)
  }
}

export const globalEventBus = new EventBus()

export const AppLogger = {
  info: (msg: string) => globalEventBus.emit('SYSTEM_NOTICE', { level: 'info', message: msg }),
  warn: (msg: string) => globalEventBus.emit('SYSTEM_NOTICE', { level: 'warn', message: msg }),
  error: (title: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error(`[AppLogger] ${title}:`, err)
    globalEventBus.emit('WORKFLOW_ERROR', { title, error: message, stack })
    globalEventBus.emit('SYSTEM_NOTICE', { level: 'error', message: `${title}: ${message}` })
  }
}
