import fsPromises from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const RETRY_DELAYS_MS = [100, 200, 300, 400, 500]
const RETRYABLE_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'])

/**
 * Windows 关库后可能短暂留着数据库目录项，所以整棵树删不掉时稍等再删，共等 1.5 秒。
 * 不用 fs.rm 的 maxRetries：它在每层目录各重试一遍，文件被别的程序开着时等待随层数乘 11，
 * 两层深就要十几分钟。
 */
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
