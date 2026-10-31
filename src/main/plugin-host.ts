import { ipcMain, shell, dialog, app, protocol } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JsonStore } from './store'
import { secrets } from './secrets'
import { decodeOutput } from './text-decode'
import type {
  PluginContext,
  PluginMainModule,
  PluginManifest,
  ProtocolHandler
} from '../shared/types'

const store = new JsonStore()
const registry = new Map<string, PluginMainModule>()

function execSafe(file: string, args: string[], timeoutMs = 15000) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const raw = (err as NodeJS.ErrnoException | null)?.code
        const code = typeof raw === 'number' ? raw : err ? 1 : 0
        const stderrText = decodeOutput(stderr)
        resolve({
          stdout: decodeOutput(stdout),
          stderr: stderrText || (err?.message ?? ''),
          code
        })
      }
    )
  })
}

function makeContext(pluginId: string): PluginContext {
  return {
    storage: {
      get: <T>(key: string, fallback: T) => store.read<T>(`${pluginId}.${key}`, fallback),
      set: (key: string, value: unknown) => store.write(`${pluginId}.${key}`, value)
    },
    secrets,
    exec: (file, args, timeoutMs) => execSafe(file, args, timeoutMs),
    openPath: (target) => shell.openPath(target),
    saveFile: async (defaultName, content, filters) => {
      const result = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: filters ?? [{ name: 'All Files', extensions: ['*'] }]
      })
      if (result.canceled || !result.filePath) return null
      await fs.writeFile(result.filePath, content, 'utf-8')
      return result.filePath
    },
    pickFile: async (filters) => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: filters ?? [{ name: 'All Files', extensions: ['*'] }]
      })
      if (result.canceled || !result.filePaths.length) return null
      return result.filePaths[0]
    },
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths.length) return null
      return result.filePaths[0]
    },
    userDataPath: app.getPath('userData'),
    appPath: app.getAppPath()
  }
}

const contexts = new Map<string, PluginContext>()

export function contextFor(pluginId: string): PluginContext {
  const cached = contexts.get(pluginId)
  if (cached) return cached
  const created = makeContext(pluginId)
  contexts.set(pluginId, created)
  return created
}

export function registerPlugin(mod: PluginMainModule | { default?: PluginMainModule }): void {
  const plugin = (mod as { default?: PluginMainModule }).default ?? (mod as PluginMainModule)
  if (!plugin || typeof plugin.handlers !== 'object') {
    throw new Error('插件必须导出 handlers')
  }
  if (!plugin.manifest?.id) {
    throw new Error('插件缺少 manifest.id')
  }
  registry.set(plugin.manifest.id, plugin)
}

export function listManifests(): PluginManifest[] {
  return [...registry.values()].map((plugin) => plugin.manifest)
}

/** 必须在 app ready 之前调用 */
export function registerSchemePrivileges(): void {
  const seen = new Set<string>()
  const privileged: Electron.CustomScheme[] = []
  for (const plugin of registry.values()) {
    for (const item of plugin.manifest.protocols ?? []) {
      if (seen.has(item.scheme)) continue
      seen.add(item.scheme)
      privileged.push({
        scheme: item.scheme,
        privileges: {
          standard: item.standard ?? true,
          secure: item.secure ?? true,
          supportFetchAPI: item.supportFetchAPI ?? true,
          corsEnabled: item.corsEnabled ?? true,
          stream: item.stream ?? true,
          bypassCSP: item.bypassCSP ?? false
        }
      })
    }
  }
  if (privileged.length) protocol.registerSchemesAsPrivileged(privileged)
}

function collectProtocolHandlers(): Map<string, { pluginId: string; handler: ProtocolHandler }> {
  const map = new Map<string, { pluginId: string; handler: ProtocolHandler }>()
  for (const [pluginId, plugin] of registry) {
    for (const [scheme, handler] of Object.entries(plugin.protocolHandlers ?? {})) {
      map.set(scheme, { pluginId, handler })
    }
  }
  return map
}

export function attachProtocols(): void {
  for (const [scheme, entry] of collectProtocolHandlers()) {
    try {
      protocol.handle(scheme, (request) => entry.handler(request, contextFor(entry.pluginId)))
    } catch (err) {
      console.error(`注册协议失败: ${scheme}`, err)
    }
  }
}

export function attachIpc(): void {
  ipcMain.handle('fiffel:list-plugins', () => listManifests())

  ipcMain.handle('fiffel:invoke', async (_event, pluginId: string, method: string, args: unknown) => {
    const plugin = registry.get(pluginId)
    if (!plugin) throw new Error(`插件未加载: ${pluginId}`)
    const handler = plugin.handlers[method]
    if (!handler) throw new Error(`插件 ${pluginId} 没有方法 ${method}`)
    return handler(args, contextFor(pluginId))
  })
}
