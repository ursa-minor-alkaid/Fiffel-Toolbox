import type { PluginContext, PluginMainModule } from '../../src/shared/types'
import type { ApiEntry, PromptEntry, VaultData, ExportResult } from './types'

interface StoredVault {
  apis: ApiEntry[]
  prompts: PromptEntry[]
}

type StoredApi = ApiEntry & { model?: string }

const EMPTY: StoredVault = { apis: [], prompts: [] }

const now = (): number => Date.now()

const newId = (prefix: string): string =>
  `${prefix}-${now()}-${Math.random().toString(36).slice(2, 8)}`

/** 读取仓库，补齐旧数据的模型数组与空 id，并在需要时写回 */
async function readVault(ctx: PluginContext): Promise<StoredVault> {
  const stored = await ctx.storage.get<{ apis?: StoredApi[]; prompts?: PromptEntry[] }>('vault', EMPTY)
  let migrated = false
  const apis = (stored.apis ?? []).map(({ model, ...rest }) => {
    const models = Array.isArray(rest.models) ? rest.models.map((value) => String(value)) : []
    if (!models.length && model) models.push(model)
    const id = typeof rest.id === 'string' && rest.id ? rest.id : newId('api')
    if (id !== rest.id) migrated = true
    return { ...rest, id, models }
  })
  const vault: StoredVault = { apis, prompts: stored.prompts ?? [] }
  if (migrated) await ctx.storage.set('vault', vault)
  return vault
}

function maskKey(secret: string): string {
  if (!secret) return ''
  if (secret.length <= 8) return '*'.repeat(secret.length)
  return `${secret.slice(0, 4)}${'*'.repeat(Math.min(secret.length - 8, 12))}${secret.slice(-4)}`
}

function buildMarkdown(vault: StoredVault, includeSecrets: boolean, decrypt: (c: string) => string): string {
  const lines: string[] = ['# API 与提示词备份', '', `导出时间：${new Date().toISOString()}`, '']

  lines.push(`## API 配置（${vault.apis.length}）`, '')
  for (const api of vault.apis) {
    const plain = decrypt(api.keyCipher)
    lines.push(`### ${api.name || '(未命名)'}`, '')
    lines.push(`- 服务商：${api.provider || '-'}`)
    lines.push(`- Base URL：${api.baseUrl || '-'}`)
    lines.push(`- 模型：${api.models.filter(Boolean).join(' / ') || '-'}`)
    lines.push(`- API Key：${includeSecrets ? plain : maskKey(plain)}`)
    if (api.note) lines.push(`- 备注：${api.note}`)
    lines.push('')
  }

  lines.push(`## 提示词（${vault.prompts.length}）`, '')
  for (const prompt of vault.prompts) {
    lines.push(`### ${prompt.title || '(未命名)'}`, '')
    lines.push(`- 分类：${prompt.category || '-'}`)
    lines.push(`- 标签：${prompt.tags.join(', ') || '-'}`)
    if (prompt.role) lines.push(`- 角色：${prompt.role}`)
    lines.push('', '```text', prompt.content.trim(), '```', '')
  }

  return lines.join('\n')
}

const mod: PluginMainModule = {
  manifest: {
    id: 'vault',
    name: 'API 与提示词',
    icon: 'key-round',
    description: '集中保存 API 配置、密钥和提示词，支持一键导出',
    version: '0.2.0'
  },

  handlers: {
    async load(_args, ctx): Promise<VaultData> {
      const vault = await readVault(ctx)
      return { ...vault, encryptionAvailable: ctx.secrets.available() }
    },

    async saveApi(args, ctx): Promise<VaultData> {
      const payload = (args ?? {}) as Partial<ApiEntry> & { plainKey?: string }
      const vault = await readVault(ctx)
      const id = typeof payload.id === 'string' && payload.id ? payload.id : newId('api')
      const existing = vault.apis.find((item) => item.id === id)
      const models = Array.isArray(payload.models)
        ? payload.models.map((value) => String(value).trim())
        : (existing?.models ?? [])

      const entry: ApiEntry = {
        id,
        name: payload.name ?? existing?.name ?? '',
        provider: payload.provider ?? existing?.provider ?? '',
        baseUrl: payload.baseUrl ?? existing?.baseUrl ?? '',
        models,
        note: payload.note ?? existing?.note ?? '',
        keyCipher:
          payload.plainKey !== undefined && payload.plainKey !== ''
            ? ctx.secrets.encrypt(payload.plainKey)
            : (existing?.keyCipher ?? ''),
        updatedAt: now()
      }

      vault.apis = existing ? vault.apis.map((item) => (item.id === id ? entry : item)) : [entry, ...vault.apis]
      await ctx.storage.set('vault', vault)
      return { ...vault, encryptionAvailable: ctx.secrets.available() }
    },

    async deleteApi(args, ctx): Promise<VaultData> {
      const { id } = (args ?? {}) as { id: string }
      const vault = await readVault(ctx)
      vault.apis = vault.apis.filter((item) => item.id !== id)
      await ctx.storage.set('vault', vault)
      return { ...vault, encryptionAvailable: ctx.secrets.available() }
    },

    async revealApiKey(args, ctx): Promise<{ ok: boolean; value: string }> {
      const { id } = (args ?? {}) as { id: string }
      const vault = await readVault(ctx)
      const entry = vault.apis.find((item) => item.id === id)
      if (!entry || !entry.keyCipher) return { ok: false, value: '' }
      const value = ctx.secrets.decrypt(entry.keyCipher)
      return { ok: Boolean(value), value }
    },

    async savePrompt(args, ctx): Promise<VaultData> {
      const payload = (args ?? {}) as Partial<PromptEntry>
      const vault = await readVault(ctx)
      const id = typeof payload.id === 'string' && payload.id ? payload.id : newId('prompt')

      const entry: PromptEntry = {
        id,
        title: payload.title ?? '',
        category: payload.category ?? '',
        tags: payload.tags ?? [],
        role: payload.role ?? '',
        content: payload.content ?? '',
        updatedAt: now()
      }

      const exists = vault.prompts.some((item) => item.id === id)
      vault.prompts = exists
        ? vault.prompts.map((item) => (item.id === id ? entry : item))
        : [entry, ...vault.prompts]
      await ctx.storage.set('vault', vault)
      return { ...vault, encryptionAvailable: ctx.secrets.available() }
    },

    async deletePrompt(args, ctx): Promise<VaultData> {
      const { id } = (args ?? {}) as { id: string }
      const vault = await readVault(ctx)
      vault.prompts = vault.prompts.filter((item) => item.id !== id)
      await ctx.storage.set('vault', vault)
      return { ...vault, encryptionAvailable: ctx.secrets.available() }
    },

    async exportAll(args, ctx): Promise<ExportResult> {
      const { format = 'md', includeSecrets = false } = (args ?? {}) as {
        format?: 'md' | 'json'
        includeSecrets?: boolean
      }
      const vault = await readVault(ctx)
      const stamp = new Date().toISOString().slice(0, 10)

      if (format === 'json') {
        const payload = {
          exportedAt: new Date().toISOString(),
          apis: vault.apis.map(({ keyCipher, ...rest }) => ({
            ...rest,
            models: rest.models.filter(Boolean),
            key: includeSecrets ? ctx.secrets.decrypt(keyCipher) : maskKey(ctx.secrets.decrypt(keyCipher))
          })),
          prompts: vault.prompts
        }
        const saved = await ctx.saveFile(`fiffel-vault-${stamp}.json`, JSON.stringify(payload, null, 2), [
          { name: 'JSON', extensions: ['json'] }
        ])
        return { savedTo: saved, apiCount: vault.apis.length, promptCount: vault.prompts.length }
      }

      const markdown = buildMarkdown(vault, includeSecrets, (cipher) => ctx.secrets.decrypt(cipher))
      const saved = await ctx.saveFile(`fiffel-vault-${stamp}.md`, markdown, [
        { name: 'Markdown', extensions: ['md'] }
      ])
      return { savedTo: saved, apiCount: vault.apis.length, promptCount: vault.prompts.length }
    }
  }
}

export default mod
