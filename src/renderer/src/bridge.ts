import type { PluginManifest } from '../../shared/types'

declare global {
  interface Window {
    fiffel: {
      listPlugins(): Promise<PluginManifest[]>
      invoke<T = unknown>(pluginId: string, method: string, args?: unknown): Promise<T>
      windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>
      setWindowBg(color: string): Promise<void>
      windowState(): Promise<{ maximized: boolean; fullscreen: boolean }>
      onWindowState(listener: (state: { maximized: boolean }) => void): () => void
      platform: NodeJS.Platform
      getPathForFile(file: File): string
    }
  }
}

/** 取拖拽文件的绝对路径，用于登记本地 HTML */
export function filePathOf(file: File): string {
  return window.fiffel.getPathForFile(file)
}

export const api = {
  invoke<T = unknown>(pluginId: string, method: string, args?: unknown): Promise<T> {
    return window.fiffel.invoke<T>(pluginId, method, args)
  },
  listPlugins(): Promise<PluginManifest[]> {
    return window.fiffel.listPlugins()
  }
}
