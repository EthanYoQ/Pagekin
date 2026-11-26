import * as electron from 'electron'
import { handle } from '../../handle'

type Electron = typeof electron
type Registrar = { handle(channel: string, listener: (event: unknown) => unknown): void }

const ipcMainKey = 'ipcMain'

export const directRegistrations: Record<string, (channel: string) => void> = {
  'electron.ipcMain.handle': channel => electron.ipcMain.handle(channel, () => 1),
  "electron['ipcMain'].handle": channel => electron[ipcMainKey].handle(channel, () => 1),
  'registerAll(electron)': channel => {
    const registerAll = (api: Electron) => api.ipcMain.handle(channel, () => 1)
    registerAll(electron)
  },
  '注入的 ipc.handle': channel => {
    const registerController = ({ ipc }: { ipc: Registrar }) => ipc.handle(channel, () => 1)
    registerController({ ipc: electron.ipcMain })
  },
  'ipcMain.handleOnce': channel => electron.ipcMain.handleOnce(channel, () => 1),
}

export const throughHandle = (channel: string) => handle(channel, () => 1)
