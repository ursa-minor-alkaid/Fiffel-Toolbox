import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PluginContext } from '../../src/shared/types'
import type { Account, Category, LedgerData, Meta, StoredTxns, Txn } from './types'

const SCHEMA_VERSION = 1
const TXN_FILE = 'ledger.txns.json'
const META_FILE = 'ledger.meta.json'
const KEEP_SNAPSHOTS = 7
/** 早期版本经 ctx.storage 写入的文件名，读取时做一次性迁移 */
const LEGACY_TXN_FILE = 'ledger.ledger.txns.json'
const LEGACY_META_FILE = 'ledger.ledger.meta.json'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 本地日期，用于每日快照命名 */
function localDate(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function defaultCategories(): Category[] {
  const expense: Array<[string, string, Array<[string, string]>]> = [
    ['food', '餐饮', [['breakfast', '早餐'], ['lunch', '午餐'], ['dinner', '晚餐'], ['coffee', '咖啡'], ['dining', '外食']]],
    ['transport', '交通', [['metro', '公共交通'], ['taxi', '打车'], ['rail', '火车'], ['flight', '机票']]],
    ['home', '居住', [['rent', '房租'], ['utilities', '水电'], ['internet', '网络']]],
    ['daily', '日用', [['grocery', '生鲜'], ['supplies', '杂货']]],
    ['shopping', '购物', [['clothes', '衣物'], ['device', '数码']]],
    ['health', '医疗', [['clinic', '就诊'], ['pharmacy', '药品']]],
    ['study', '学习', [['books', '书籍'], ['course', '课程']]],
    ['fun', '娱乐', [['movie', '影音'], ['game', '游戏']]],
    ['sub', '订阅', [['stream', '流媒体'], ['software', '软件']]],
    ['travel', '旅行', [['hotel', '住宿'], ['sight', '门票']]],
    ['other', '其他', []]
  ]
  const income: Array<[string, string, Array<[string, string]>]> = [
    ['salary', '工资', []],
    ['grant', '奖学金', []],
    ['refund', '报销', []],
    ['interest', '利息', []],
    ['other-income', '其他', []]
  ]

  const list: Category[] = []
  let order = 0
  for (const [id, name, children] of expense) {
    list.push({ id, name, parentId: null, type: 'expense', order: order++, archived: false })
    for (const [childId, childName] of children) {
      list.push({ id: childId, name: childName, parentId: id, type: 'expense', order: order++, archived: false })
    }
  }
  order = 0
  for (const [id, name, children] of income) {
    list.push({ id, name, parentId: null, type: 'income', order: order++, archived: false })
    for (const [childId, childName] of children) {
      list.push({ id: childId, name: childName, parentId: id, type: 'income', order: order++, archived: false })
    }
  }
  return list
}

function defaultAccounts(): Account[] {
  const base = (id: string, name: string, type: Account['type'], order: number, initial = 0): Account => ({
    id,
    name,
    type,
    initial: initial ? { CNY: initial } : {},
    archived: false,
    order
  })
  return [
    base('cash', '现金', 'cash', 0),
    base('alipay', '支付宝', 'ewallet', 1),
    base('bank-card', '银行卡', 'bank', 2),
    base('eur-cash', '欧元现金', 'cash', 3),
    base('n26', 'N26', 'bank', 4),
    base('usd-bank', '美元账户', 'bank', 5)
  ]
}

export function defaultMeta(): Meta {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      baseCurrency: 'CNY',
      defaultAccountId: 'alipay',
      lastCategoryId: 'lunch',
      lastCurrency: 'CNY',
      rateUpdatedAt: null
    },
    accounts: defaultAccounts(),
    categories: defaultCategories(),
    rates: [],
    ratesFetchedAt: null
  }
}

type RawMeta = Partial<Meta> & { schemaVersion?: number }

function migrateMeta(raw: RawMeta | Meta | null): Meta {
  const base = defaultMeta()
  if (!raw || typeof raw !== 'object') return base
  const stored = raw as RawMeta
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...base.settings, ...(stored.settings ?? {}) },
    accounts: Array.isArray(stored.accounts) ? stored.accounts : base.accounts,
    categories: Array.isArray(stored.categories) ? stored.categories : base.categories,
    rates: Array.isArray(stored.rates) ? stored.rates : [],
    ratesFetchedAt: typeof stored.ratesFetchedAt === 'number' ? stored.ratesFetchedAt : null
  }
}

function migrateTxns(raw: StoredTxns | Txn[] | null): Txn[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw.txns)) return raw.txns
  return []
}

export class LedgerStore {
  private state: { txns: Txn[]; meta: Meta } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private recovered = false
  private migrated = false

  constructor(private readonly ctx: PluginContext) {}

  private dir(): string {
    return path.join(this.ctx.userDataPath, 'data')
  }

  private file(name: string): string {
    return path.join(this.dir(), name)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async readJson<T>(target: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(target, 'utf-8')
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  private async snapshotFiles(): Promise<string[]> {
    try {
      const names = await fs.readdir(this.dir())
      return names
        .filter((name) => /^ledger\.txns\.\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  private async readTxns(): Promise<Txn[]> {
    const current = await this.readJson<StoredTxns | Txn[]>(this.file(TXN_FILE))
    if (current) return migrateTxns(current)

    const legacy = await this.readJson<StoredTxns | Txn[]>(this.file(LEGACY_TXN_FILE))
    if (legacy) {
      this.migrated = true
      return migrateTxns(legacy)
    }

    const backup = await this.readJson<StoredTxns | Txn[]>(`${this.file(TXN_FILE)}.bak`)
    if (backup) {
      this.recovered = true
      return migrateTxns(backup)
    }

    for (const name of await this.snapshotFiles()) {
      const snapshot = await this.readJson<StoredTxns | Txn[]>(this.file(name))
      if (snapshot) {
        this.recovered = true
        return migrateTxns(snapshot)
      }
    }
    return []
  }

  private async readMeta(): Promise<Meta> {
    const current = await this.readJson<RawMeta>(this.file(META_FILE))
    if (current) return migrateMeta(current)

    const legacy = await this.readJson<RawMeta>(this.file(LEGACY_META_FILE))
    if (legacy) {
      this.migrated = true
      return migrateMeta(legacy)
    }

    const backup = await this.readJson<RawMeta>(`${this.file(META_FILE)}.bak`)
    if (backup) {
      this.recovered = true
      return migrateMeta(backup)
    }
    return defaultMeta()
  }

  private async ensureState(): Promise<{ txns: Txn[]; meta: Meta }> {
    if (!this.state) {
      await fs.mkdir(this.dir(), { recursive: true })
      this.state = { txns: await this.readTxns(), meta: await this.readMeta() }
    }
    return this.state
  }

  private async repairMainFiles(state: { txns: Txn[]; meta: Meta }): Promise<void> {
    try {
      await this.writeJson(TXN_FILE, { schemaVersion: SCHEMA_VERSION, txns: state.txns } satisfies StoredTxns)
    } catch {
      /* 修复失败时保持只读结果，用户仍可导出 */
    }
    try {
      await this.writeJson(META_FILE, state.meta)
    } catch {
      /* 同上 */
    }
  }

  async load(): Promise<LedgerData> {
    const state = await this.enqueue(() => this.ensureState())
    const recovered = this.recovered
    this.recovered = false
    if (recovered || this.migrated) {
      await this.repairMainFiles(state)
      this.migrated = false
    }
    return { txns: state.txns, meta: state.meta, recovered }
  }

  private async backupFile(name: string): Promise<void> {
    try {
      await fs.access(this.file(name))
    } catch {
      return
    }
    try {
      await fs.copyFile(this.file(name), `${this.file(name)}.bak`)
    } catch {
      /* 备份失败不阻断写入 */
    }
  }

  private async pruneSnapshots(): Promise<void> {
    const names = await this.snapshotFiles()
    for (const name of names.slice(KEEP_SNAPSHOTS)) {
      try {
        await fs.unlink(this.file(name))
      } catch {
        /* 忽略清理失败 */
      }
    }
  }

  private async snapshotToday(name: string, stamp: string): Promise<void> {
    try {
      await fs.access(this.file(name))
    } catch {
      return
    }
    const target = `ledger.txns.${stamp}.json`
    try {
      await fs.access(this.file(target))
      return
    } catch {
      /* 当天还没有快照 */
    }
    try {
      await fs.copyFile(this.file(name), this.file(target))
      await this.pruneSnapshots()
    } catch {
      /* 快照失败不阻断写入 */
    }
  }

  /** 原子写入：先写临时文件再改名，避免中途崩溃留下半截 JSON */
  private async writeJson(name: string, payload: unknown): Promise<void> {
    const target = this.file(name)
    const temp = `${target}.tmp`
    const text = JSON.stringify(payload, null, 2)
    await fs.mkdir(this.dir(), { recursive: true })
    try {
      await fs.writeFile(temp, text, 'utf-8')
      await fs.rename(temp, target)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
    }
    // 杀软或索引服务短暂占用句柄时延迟重试一次
    await delay(200)
    await fs.writeFile(temp, text, 'utf-8')
    await fs.rename(temp, target)
  }

  private async persistTxns(txns: Txn[]): Promise<void> {
    await this.backupFile(TXN_FILE)
    await this.snapshotToday(TXN_FILE, localDate())
    await this.writeJson(TXN_FILE, { schemaVersion: SCHEMA_VERSION, txns } satisfies StoredTxns)
  }

  private async persistMeta(meta: Meta): Promise<void> {
    await this.backupFile(META_FILE)
    await this.writeJson(META_FILE, meta)
  }

  mutateTxns<T>(work: (txns: Txn[], state: { txns: Txn[]; meta: Meta }) => T): Promise<T> {
    return this.enqueue(async () => {
      const state = await this.ensureState()
      const result = work(state.txns, state)
      try {
        await this.persistTxns(state.txns)
      } catch (err) {
        // 写入失败时丢弃内存副本，下次访问重新从磁盘读取，避免界面显示未落盘的改动
        this.state = null
        throw err
      }
      return result
    })
  }

  mutateMeta<T>(work: (meta: Meta, state: { txns: Txn[]; meta: Meta }) => T): Promise<T> {
    return this.enqueue(async () => {
      const state = await this.ensureState()
      const result = work(state.meta, state)
      try {
        await this.persistMeta(state.meta)
      } catch (err) {
        this.state = null
        throw err
      }
      return result
    })
  }

  /** 只读访问当前状态，用于导出与统计 */
  async snapshotState(): Promise<{ txns: Txn[]; meta: Meta }> {
    return this.enqueue(() => this.ensureState())
  }
}
