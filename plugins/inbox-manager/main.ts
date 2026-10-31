import type { PluginMainModule, PluginContext } from '../../src/shared/types'
import type { InboxRow, InboxSettings, DiagnoseResult, SearchResult } from './types'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ES_CANDIDATES = [
  'C:\\Program Files\\Everything\\es.exe',
  'C:\\Program Files (x86)\\Everything\\es.exe',
  'C:\\Program Files\\Everything\\cli\\es.exe'
]

const DEFAULT_SETTINGS: InboxSettings = {
  esPath: '',
  exactMatch: true,
  extraRoots: []
}

type MetaMap = Record<string, { note: string; pinned: boolean }>

const normalizeKey = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()

async function resolveEs(ctx: PluginContext): Promise<string | null> {
  const settings = await ctx.storage.get<InboxSettings>('settings', DEFAULT_SETTINGS)
  const bundled = [
    path.join(ctx.appPath, 'bin', 'es.exe'),
    path.join(path.dirname(process.execPath), 'bin', 'es.exe')
  ]
  const candidates = [settings.esPath, 'es.exe', ...ES_CANDIDATES, ...bundled].filter(Boolean)
  for (const candidate of candidates) {
    const probe = await ctx.exec(candidate, ['-version'], 5000)
    if (probe.code === 0) return candidate
  }
  return null
}

function toRow(absolute: string, meta: MetaMap): InboxRow {
  const trimmed = absolute.replace(/[\\/]+$/, '')
  const m = meta[normalizeKey(trimmed)]
  return {
    path: trimmed,
    drive: trimmed.slice(0, 2).toUpperCase(),
    name: trimmed.split(/[\\/]/).pop() ?? trimmed,
    modified: 0,
    fileCount: null,
    totalSize: null,
    note: m?.note ?? '',
    pinned: m?.pinned ?? false
  }
}

/** 降级扫描：递归找指定名字的目录，跳过符号链接避免成环 */
async function deepScan(root: string, targetName: string, maxDepth = 12): Promise<string[]> {
  const found: string[] = []
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]

  while (stack.length) {
    const { dir, depth } = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = `${dir}\\${entry.name}`
      if (entry.name.toLowerCase() === targetName) {
        found.push(full)
        continue
      }
      if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 })
    }
  }
  return found
}

/** 统计文件数与总字节，单条权限错误只跳过该文件 */
async function folderStats(target: string, maxEntries = 200_000): Promise<{ count: number; size: number }> {
  let count = 0
  let size = 0
  const stack = [target]

  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (count >= maxEntries) return { count, size }
      if (entry.isSymbolicLink()) continue
      const full = `${dir}\\${entry.name}`
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        count += 1
        try {
          size += (await fs.stat(full)).size
        } catch {
          /* 无权访问，忽略大小 */
        }
      }
    }
  }
  return { count, size }
}

const mod: PluginMainModule = {
  manifest: {
    id: 'inbox-manager',
    name: 'Inbox 管理',
    icon: 'inbox',
    description: '搜索本机所有名为 inbox 的文件夹',
    version: '0.1.0'
  },

  handlers: {
    async diagnose(_args, ctx): Promise<DiagnoseResult> {
      const esPath = await resolveEs(ctx)
      if (!esPath) {
        return {
          ok: false,
          esPath: '',
          version: '',
          message:
            '未找到 es.exe。Everything 已安装但命令行工具需单独下载，下载后放入 PATH 或在下方指定完整路径。'
        }
      }
      const probe = await ctx.exec(esPath, ['-version'], 5000)
      return { ok: true, esPath, version: probe.stdout.trim(), message: 'es.exe 可用' }
    },

    async getSettings(_args, ctx): Promise<InboxSettings> {
      return ctx.storage.get<InboxSettings>('settings', DEFAULT_SETTINGS)
    },

    async setSettings(args, ctx): Promise<InboxSettings> {
      const merged = { ...DEFAULT_SETTINGS, ...((args ?? {}) as Partial<InboxSettings>) }
      await ctx.storage.set('settings', merged)
      return merged
    },

    async search(args, ctx): Promise<SearchResult> {
      const { exact = true } = (args ?? {}) as { exact?: boolean }
      const meta = await ctx.storage.get<MetaMap>('meta', {})
      const settings = await ctx.storage.get<InboxSettings>('settings', DEFAULT_SETTINGS)
      const seen = new Set<string>()
      const rows: InboxRow[] = []

      const push = (absolute: string): void => {
        const key = normalizeKey(absolute)
        if (seen.has(key)) return
        seen.add(key)
        rows.push(toRow(absolute, meta))
      }

      let source: 'everything' | 'fallback' = 'everything'
      let message = ''
      const esPath = await resolveEs(ctx)

      if (esPath) {
        const query = exact ? ['folder:', 'wfn:inbox'] : ['folder:', 'inbox']
        const result = await ctx.exec(esPath, query, 30000)
        if (result.code === 0) {
          for (const line of result.stdout.split(/\r?\n/)) {
            if (line.trim()) push(line.trim())
          }
        } else {
          source = 'fallback'
          message = 'Everything 搜索失败，已改用目录遍历。'
        }
      } else {
        source = 'fallback'
        message = '未找到 es.exe，已改用目录遍历。'
      }

      if (source === 'fallback') {
        if (!settings.extraRoots.length) {
          message += ' 未配置扫描根目录，请在设置中填写。'
        }
        for (const root of settings.extraRoots) {
          for (const hit of await deepScan(root, 'inbox')) push(hit)
        }
      }

      await Promise.all(
        rows.map(async (row) => {
          try {
            row.modified = (await fs.stat(row.path)).mtimeMs
          } catch {
            row.modified = 0
          }
        })
      )

      rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modified - a.modified)
      return { rows, source, message, esPath: esPath ?? '' }
    },

    async statFolder(args) {
      const { path: target } = (args ?? {}) as { path: string }
      if (!target) throw new Error('缺少路径')
      return folderStats(target)
    },

    async listEntries(args) {
      const { path: target, limit = 50 } = (args ?? {}) as { path: string; limit?: number }
      const entries = await fs.readdir(target, { withFileTypes: true })
      const picked = entries.slice(0, limit)
      const items = await Promise.all(
        picked.map(async (entry) => {
          const full = `${target}\\${entry.name}`
          const isDir = entry.isDirectory()
          try {
            const st = await fs.stat(full)
            return { name: entry.name, isDir, size: isDir ? 0 : st.size, modified: st.mtimeMs }
          } catch {
            return { name: entry.name, isDir, size: 0, modified: 0 }
          }
        })
      )
      return { items, total: entries.length }
    },

    async openFolder(args, ctx) {
      const { path: target } = (args ?? {}) as { path: string }
      const error = await ctx.openPath(target)
      if (error) throw new Error(error)
      return true
    },

    async setNote(args, ctx) {
      const { path: target, note } = (args ?? {}) as { path: string; note: string }
      const meta = await ctx.storage.get<MetaMap>('meta', {})
      const key = normalizeKey(target)
      meta[key] = { note, pinned: meta[key]?.pinned ?? false }
      await ctx.storage.set('meta', meta)
      return true
    },

    async setPinned(args, ctx) {
      const { path: target, pinned } = (args ?? {}) as { path: string; pinned: boolean }
      const meta = await ctx.storage.get<MetaMap>('meta', {})
      const key = normalizeKey(target)
      meta[key] = { note: meta[key]?.note ?? '', pinned }
      await ctx.storage.set('meta', meta)
      return true
    }
  }
}

export default mod
