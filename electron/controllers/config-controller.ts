import { app, ipcMain } from 'electron'
import {
  readJsonFile,
  updateGlobalConfig,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import { GlobalConfig } from '../../src/shared/ipc-channels'
import { mainText } from '../i18n'
import { applyNetworkProxy } from '../network-proxy'

const text = (zhCNText: string, enUSText: string) => mainText(app.getLocale(), zhCNText, enUSText)

export function registerConfigController() {
  /** 读取全局配置 */
  ipcMain.handle('config:get', async () => {
    return readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  })

  /** 保存全局配置 */
  ipcMain.handle('config:set', async (_event, config: Partial<GlobalConfig>) => {
    let undoProxy: (() => void) | undefined
    try {
      undoProxy = config.proxy && applyNetworkProxy(config.proxy)
      if (updateGlobalConfig(existing => ({ ...existing, ...config, stageModelIds: existing.stageModelIds }))) return { success: true }
      undoProxy?.()
      return {
        success: false,
        error: text(
          '全局配置文件已损坏，已拒绝覆盖。请修复或删除应用数据目录里的 config.json 后重试。',
          'The global config file is damaged, so it was not overwritten. Repair or delete config.json in the app data folder, then try again.',
        ),
      }
    } catch (error) {
      undoProxy?.()
      if (error instanceof Error && error.message === 'NETWORK_PROXY_INVALID') return { success: false, error: error.message }
      console.error('[Config] 全局配置写入失败:', error)
      return {
        success: false,
        error: text(
          '设置没能写进配置文件。请确认磁盘还有空间、应用数据目录可写，再重试。',
          'The setting could not be written to the config file. Make sure the disk has space and the app data folder is writable, then try again.',
        ),
      }
    }
  })
}
