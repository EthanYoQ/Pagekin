import {
  readJsonFile,
  updateGlobalConfig,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import { GlobalConfig } from '../../src/shared/ipc-channels'
import { handle } from '../ipc/handle'
import { applyNetworkProxy } from '../network-proxy'

export function registerConfigController() {
  /** 读取全局配置 */
  handle('config:get', async () => {
    return readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  })

  /** 保存全局配置 */
  handle('config:set', async (_event, config: Partial<GlobalConfig>) => {
    let undoProxy: (() => void) | undefined
    try {
      undoProxy = config.proxy && applyNetworkProxy(config.proxy)
      if (updateGlobalConfig(existing => ({ ...existing, ...config, stageModelIds: existing.stageModelIds }))) return { success: true }
      undoProxy?.()
      return { success: false, failure: { code: 'CONFIG_FILE_DAMAGED' } }
    } catch (error) {
      undoProxy?.()
      if (error instanceof Error && error.message === 'NETWORK_PROXY_INVALID') return { success: false, failure: { code: 'NETWORK_PROXY_INVALID' } }
      console.error('[Config] 全局配置写入失败:', error)
      return { success: false, failure: { code: 'CONFIG_WRITE_FAILED' } }
    }
  })
}
