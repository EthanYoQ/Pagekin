import fsPromises from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const RETRY_DELAYS_MS = [100, 200, 300, 400, 500]
const RETRYABLE_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'])

// Windows 关库后目录项可能短暂残留，故自己重试。不用 fs.rm 的 maxRetries：它逐层各重试一遍，被占用时等待随目录深度成倍增长。
export async function removeDirectoryWithWindowsRetry(directoryPath: string): Promise<void> {
  for (const waitMs of [...RETRY_DELAYS_MS, undefined]) {
    try {
      await fsPromises.rm(directoryPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (waitMs === undefined || !RETRYABLE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      await delay(waitMs)
    }
  }
}
