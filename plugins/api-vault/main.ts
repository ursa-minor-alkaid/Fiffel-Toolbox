import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PluginContext, PluginMainModule } from '../../src/shared/types'
import type { ApiEntry, ApiVaultData, ExportResult } from './types'

interface StoredApiState {
  apis: ApiEntry[]
  /** 拆分前的合并数据只导入一次，避免清空后再次被旧文件覆盖 */
  legacyImported?: boolean
}

/** 拆分前由 vault 插件保存的 API 结构，模型可能还是单个 model 字段 */
interface LegacyApi {
  id?: string
  name?: string
  provider?: string
  baseUrl?: string
  models?: unknown[]
  model?: string
  keyCipher?: string
  note?: string
  updatedAt?: number
}

interface LegacyVault {
  apis?: LegacyApi[]
}

const STORE_KEY = 'apis'

const now = (): number => Date.now()

const newId = (prefix: string): string =>
  `${prefix}-${now()}-${Math.random().toString(36).slice(2, 8)}`

function normalize(entry: LegacyApi): ApiEntry {
  const models = Array.isArray(entry.models) ? entry.models.map((value) => String(value)) : []
  if (!models.length && entry.model) models.push(entry.model)
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : newId('api'),
    name: entry.name ?? '',
    provider: entry.provider ?? '',
    baseUrl: entry.baseUrl ?? '',
    models,
    keyCipher: entry.keyCipher ?? '',
    note: entry.note ?? '',
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
  }
}

/** 读取拆分前 vault.vault.json 里的 API 列表，文件不存在时返回空数组 */
async function readLegacyApis(ctx: PluginContext): Promise<ApiEntry[]> {
  try {
    const raw = await fs.readFile(
      path.join(ctx.userDataPath, 'data', 'vault.vault.json'),
      'utf-8'
    )
    const parsed = JSON.parse(raw) as LegacyVault
    return Array.isArray(parsed.apis) ? parsed.apis.map(normalize) : []
  } catch {
    return []
  }
}

async function readApis(ctx: PluginContext): Promise<ApiEntry[]> {
  const stored = await ctx.storage.get<StoredApiState>(STORE_KEY, { apis: [] })
  const apis = Array.isArray(stored.apis) ? stored.apis.map(normalize) : []
  if (stored.legacyImported) return apis

  // 首次运行：优先保留自身已有数据，否则导入旧合并仓库里的 API
  const merged = apis.length ? apis : await readLegacyApis(ctx)
  await ctx.storage.set(STORE_KEY, { apis: merged, legacyImported: true })
  return merged
}

async function writeApis(ctx: PluginContext, apis: ApiEntry[]): Promise<void> {
  await ctx.storage.set(STORE_KEY, { apis, legacyImported: true })
}

function maskKey(secret: string): string {
  if (!secret) return ''
  if (secret.length <= 8) return '*'.repeat(secret.length)
  return `${secret.slice(0, 4)}${'*'.repeat(Math.min(secret.length - 8, 12))}${secret.slice(-4)}`
}

function buildMarkdown(
  apis: ApiEntry[],
  includeSecrets: boolean,
  decrypt: (cipher: string) => string
): string {
  const lines: string[] = ['# API 配置备份', '', `导出时间：${new Date().toISOString()}`, '']
  lines.push(`## API 配置（${apis.length}）`, '')

  for (const api of apis) {
    const plain = decrypt(api.keyCipher)
    lines.push(`### ${api.name || '(未命名)'}`, '')
    lines.push(`- 服务商：${api.provider || '-'}`)
    lines.push(`- Base URL：${api.baseUrl || '-'}`)
    lines.push(`- 模型：${api.models.filter(Boolean).join(' / ') || '-'}`)
    lines.push(`- API Key：${includeSecrets ? plain : maskKey(plain)}`)
    if (api.note) lines.push(`- 备注：${api.note}`)
    lines.push('')
  }

  return lines.join('\n')
}

const mod: PluginMainModule = {
  manifest: {
    id: 'api-vault',
    name: 'API 配置',
    icon: 'key-round',
    description: '保存 API 配置与密钥，支持一键导出',
    version: '0.2.0'
  },

  handlers: {
    async load(_args, ctx): Promise<ApiVaultData> {
      const apis = await readApis(ctx)
      return { apis, encryptionAvailable: ctx.secrets.available() }
    },

    async saveApi(args, ctx): Promise<ApiVaultData> {
      const payload = (args ?? {}) as Partial<ApiEntry> & { plainKey?: string }
      const apis = await readApis(ctx)
      const id = typeof payload.id === 'string' && payload.id ? payload.id : newId('api')
      const existing = apis.find((item) => item.id === id)
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

      const next = existing
        ? apis.map((item) => (item.id === id ? entry : item))
        : [entry, ...apis]
      await writeApis(ctx, next)
      return { apis: next, encryptionAvailable: ctx.secrets.available() }
    },

    async deleteApi(args, ctx): Promise<ApiVaultData> {
      const { id } = (args ?? {}) as { id: string }
      const apis = await readApis(ctx)
      const next = apis.filter((item) => item.id !== id)
      await writeApis(ctx, next)
      return { apis: next, encryptionAvailable: ctx.secrets.available() }
    },

    async revealApiKey(args, ctx): Promise<{ ok: boolean; value: string }> {
      const { id } = (args ?? {}) as { id: string }
      const apis = await readApis(ctx)
      const entry = apis.find((item) => item.id === id)
      if (!entry || !entry.keyCipher) return { ok: false, value: '' }
      const value = ctx.secrets.decrypt(entry.keyCipher)
      return { ok: Boolean(value), value }
    },

    async exportAll(args, ctx): Promise<ExportResult> {
      const { format = 'md', includeSecrets = false } = (args ?? {}) as {
        format?: 'md' | 'json'
        includeSecrets?: boolean
      }
      const apis = await readApis(ctx)
      const stamp = new Date().toISOString().slice(0, 10)

      if (format === 'json') {
        const payload = {
          exportedAt: new Date().toISOString(),
          apis: apis.map(({ keyCipher, ...rest }) => ({
            ...rest,
            models: rest.models.filter(Boolean),
            key: includeSecrets ? ctx.secrets.decrypt(keyCipher) : maskKey(ctx.secrets.decrypt(keyCipher))
          }))
        }
        const saved = await ctx.saveFile(`fiffel-apis-${stamp}.json`, JSON.stringify(payload, null, 2), [
          { name: 'JSON', extensions: ['json'] }
        ])
        return { savedTo: saved, apiCount: apis.length }
      }

      const markdown = buildMarkdown(apis, includeSecrets, (cipher) => ctx.secrets.decrypt(cipher))
      const saved = await ctx.saveFile(`fiffel-apis-${stamp}.md`, markdown, [
        { name: 'Markdown', extensions: ['md'] }
      ])
      return { savedTo: saved, apiCount: apis.length }
    }
  }
}

export default mod
