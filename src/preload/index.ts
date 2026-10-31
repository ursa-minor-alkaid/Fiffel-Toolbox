import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PluginManifest } from '../shared/types'

contextBridge.exposeInMainWorld('fiffel', {
  listPlugins: (): Promise<PluginManifest[]> => ipcRenderer.invoke('fiffel:list-plugins'),
  invoke: <T>(pluginId: string, method: string, args?: unknown): Promise<T> =>
    ipcRenderer.invoke('fiffel:invoke', pluginId, method, args),
  windowAction: (action: 'minimize' | 'maximize' | 'close'): Promise<void> =>
    ipcRenderer.invoke('fiffel:window', action),
  setWindowBg: (color: string): Promise<void> => ipcRenderer.invoke('fiffel:set-window-bg', color),
  windowState: (): Promise<{ maximized: boolean; fullscreen: boolean }> =>
    ipcRenderer.invoke('fiffel:window-state'),
  onWindowState: (listener: (state: { maximized: boolean }) => void): (() => void) => {
    const handler = (_event: unknown, state: { maximized: boolean }): void => listener(state)
    ipcRenderer.on('fiffel:window-state-changed', handler)
    return () => ipcRenderer.removeListener('fiffel:window-state-changed', handler)
  },
  platform: process.platform,
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
})
