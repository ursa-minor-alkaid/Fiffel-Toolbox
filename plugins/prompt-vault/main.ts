import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PluginContext, PluginMainModule } from '../../src/shared/types'
import type { PromptEntry, PromptVaultData, ExportResult } from './types'

interface StoredPromptState {
  prompts: PromptEntry[]
  /** 拆分前的合并数据只导入一次，避免清空后再次被旧文件覆盖 */
  legacyImported?: boolean
}

/** 拆分前由 vault 插件保存的提示词结构 */
interface LegacyPrompt {
  id?: string
  title?: string
  /** 旧版分类字段，拆分后不再使用 */
  category?: string
  emoji?: string
  tags?: unknown[]
  role?: string
  content?: string
  updatedAt?: number
}

interface LegacyVault {
  prompts?: LegacyPrompt[]
}

const STORE_KEY = 'prompts'

const now = (): number => Date.now()

const newId = (prefix: string): string =>
  `${prefix}-${now()}-${Math.random().toString(36).slice(2, 8)}`

function normalize(entry: LegacyPrompt): PromptEntry {
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : newId('prompt'),
    title: entry.title ?? '',
    emoji: entry.emoji ?? '',
    tags: Array.isArray(entry.tags)
      ? entry.tags.map((value) => String(value)).filter(Boolean)
      : [],
    role: entry.role ?? '',
    content: entry.content ?? '',
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
  }
}

/** 读取拆分前 vault.vault.json 里的提示词列表，文件不存在时返回空数组 */
async function readLegacyPrompts(ctx: PluginContext): Promise<PromptEntry[]> {
  try {
    const raw = await fs.readFile(
      path.join(ctx.userDataPath, 'data', 'vault.vault.json'),
      'utf-8'
    )
    const parsed = JSON.parse(raw) as LegacyVault
    return Array.isArray(parsed.prompts) ? parsed.prompts.map(normalize) : []
  } catch {
    return []
  }
}

async function readPrompts(ctx: PluginContext): Promise<PromptEntry[]> {
  const stored = await ctx.storage.get<StoredPromptState>(STORE_KEY, { prompts: [] })
  const prompts = Array.isArray(stored.prompts) ? stored.prompts.map(normalize) : []
  if (stored.legacyImported) return prompts

  // 首次运行：优先保留自身已有数据，否则导入旧合并仓库里的提示词
  const merged = prompts.length ? prompts : await readLegacyPrompts(ctx)
  await ctx.storage.set(STORE_KEY, { prompts: merged, legacyImported: true })
  return merged
}

async function writePrompts(ctx: PluginContext, prompts: PromptEntry[]): Promise<void> {
  await ctx.storage.set(STORE_KEY, { prompts, legacyImported: true })
}

function buildMarkdown(prompts: PromptEntry[]): string {
  const lines: string[] = ['# 提示词备份', '', `导出时间：${new Date().toISOString()}`, '']
  lines.push(`## 提示词（${prompts.length}）`, '')

  for (const prompt of prompts) {
    lines.push(`### ${prompt.emoji ? `${prompt.emoji} ` : ''}${prompt.title || '(未命名)'}`, '')
    lines.push(`- 标签：${prompt.tags.join(', ') || '-'}`)
    if (prompt.role) lines.push(`- 角色：${prompt.role}`)
    lines.push('', '```text', prompt.content.trim(), '```', '')
  }

  return lines.join('\n')
}

const mod: PluginMainModule = {
  manifest: {
    id: 'prompt-vault',
    name: '提示词',
    icon: 'file-text',
    description: '集中保存提示词，支持搜索、复制与导出',
    version: '0.2.0'
  },

  handlers: {
    async load(_args, ctx): Promise<PromptVaultData> {
      const prompts = await readPrompts(ctx)
      return { prompts }
    },

    async savePrompt(args, ctx): Promise<PromptVaultData> {
      const payload = (args ?? {}) as Partial<PromptEntry>
      const prompts = await readPrompts(ctx)
      const id = typeof payload.id === 'string' && payload.id ? payload.id : newId('prompt')

      const entry: PromptEntry = {
        id,
        title: payload.title ?? '',
        emoji: payload.emoji ?? '',
        tags: payload.tags ?? [],
        role: payload.role ?? '',
        content: payload.content ?? '',
        updatedAt: now()
      }

      const exists = prompts.some((item) => item.id === id)
      const next = exists
        ? prompts.map((item) => (item.id === id ? entry : item))
        : [entry, ...prompts]
      await writePrompts(ctx, next)
      return { prompts: next }
    },

    async deletePrompt(args, ctx): Promise<PromptVaultData> {
      const { id } = (args ?? {}) as { id: string }
      const prompts = await readPrompts(ctx)
      const next = prompts.filter((item) => item.id !== id)
      await writePrompts(ctx, next)
      return { prompts: next }
    },

    async exportAll(args, ctx): Promise<ExportResult> {
      const { format = 'md' } = (args ?? {}) as { format?: 'md' | 'json' }
      const prompts = await readPrompts(ctx)
      const stamp = new Date().toISOString().slice(0, 10)

      if (format === 'json') {
        const payload = {
          exportedAt: new Date().toISOString(),
          prompts
        }
        const saved = await ctx.saveFile(
          `fiffel-prompts-${stamp}.json`,
          JSON.stringify(payload, null, 2),
          [{ name: 'JSON', extensions: ['json'] }]
        )
        return { savedTo: saved, promptCount: prompts.length }
      }

      const markdown = buildMarkdown(prompts)
      const saved = await ctx.saveFile(`fiffel-prompts-${stamp}.md`, markdown, [
        { name: 'Markdown', extensions: ['md'] }
      ])
      return { savedTo: saved, promptCount: prompts.length }
    }
  }
}

export default mod
