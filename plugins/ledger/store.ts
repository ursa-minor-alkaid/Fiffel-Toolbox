import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PluginContext } from '../../src/shared/types'
import type { Category, LedgerData, Meta, StoredTxns, Txn } from './types'
import {
  defaultMeta,
  isMetaShape,
  isStoredTxnsShape,
  normalizeMeta,
  normalizeStoredTxns
} from './normalize'

const SCHEMA_VERSION = 1
const TXN_BASE = 'ledger.txns'
const TXN_FILE = `${TXN_BASE}.json`
const LARGE_TXN_BASE = 'ledger.large-txns'
const LARGE_TXN_FILE = `${LARGE_TXN_BASE}.json`
const META_FILE = 'ledger.meta.json'
const KEEP_SNAPSHOTS = 7
/** 早期版本经 ctx.storage 写入的文件名，仅作为最后兜底 */
const LEGACY_TXN_FILE = 'ledger.ledger.txns.json'
const LEGACY_META_FILE = 'ledger.ledger.meta.json'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 本地日期，用于每日快照命名 */
function localDate(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

type ReadOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'invalid' }

type LedgerState = { txns: Txn[]; largeTxns: Txn[]; meta: Meta }

export class LedgerStore {
  private state: LedgerState | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private recovered = false
  private migratedTxns = false
  private migratedMeta = false
  private migratedLargeCategories = false
  private metaMissing = false
  private txnsMissing = false
  private warnings: string[] = []

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

  /** 只有文件不存在才视为缺失，其余读取错误向上抛出，避免把空账本写回 */
  private async readJson<T>(target: string): Promise<ReadOutcome<T>> {
    let raw: string
    try {
      raw = await fs.readFile(target, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      throw err
    }
    try {
      return { kind: 'ok', value: JSON.parse(raw) as T }
    } catch {
      return { kind: 'invalid' }
    }
  }

  /** 快照文件名以流水文件基名为前缀，常规与大额互不影响 */
  private async snapshotFiles(base: string): Promise<string[]> {
    try {
      const names = await fs.readdir(this.dir())
      const prefix = `${base}.`
      return names
        .filter((name) => name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.json$/.test(name.slice(prefix.length)))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /** 记录被规范化时丢弃的条数 */
  private acceptTxns(value: StoredTxns | Txn[], label: string): Txn[] {
    const { txns, dropped } = normalizeStoredTxns(value)
    if (dropped > 0) this.warnings.push(`${label}有 ${dropped} 条流水结构异常，已跳过`)
    return txns
  }

  /** 读取一份流水集合：主文件、备份、当日快照，旧版文件仅作最后兜底 */
  private async readTxnCollection(
    base: string,
    label: string,
    legacyName?: string
  ): Promise<Txn[]> {
    const file = `${base}.json`
    let corrupt = false

    const current = await this.readJson<unknown>(this.file(file))
    if (current.kind === 'ok' && isStoredTxnsShape(current.value)) {
      return this.acceptTxns(current.value, label)
    }
    if (current.kind !== 'missing') corrupt = true

    const backup = await this.readJson<unknown>(`${this.file(file)}.bak`)
    if (backup.kind === 'ok' && isStoredTxnsShape(backup.value)) {
      const txns = this.acceptTxns(backup.value, label)
      this.recovered = true
      return txns
    }
    if (backup.kind !== 'missing') corrupt = true

    for (const name of await this.snapshotFiles(base)) {
      const snapshot = await this.readJson<unknown>(this.file(name))
      if (snapshot.kind === 'ok' && isStoredTxnsShape(snapshot.value)) {
        const txns = this.acceptTxns(snapshot.value, label)
        this.recovered = true
        return txns
      }
      if (snapshot.kind !== 'missing') corrupt = true
    }

    if (legacyName) {
      // 旧版文件只作最后兜底，避免它压过更新的备份
      const legacy = await this.readJson<unknown>(this.file(legacyName))
      if (legacy.kind === 'ok' && isStoredTxnsShape(legacy.value)) {
        const txns = this.acceptTxns(legacy.value, label)
        this.migratedTxns = true
        this.recovered = true
        return txns
      }
      if (legacy.kind !== 'missing') corrupt = true
    }

    if (corrupt) {
      throw new Error(
        label === '大额支出'
          ? '大额支出文件损坏且没有可用备份，已停止加载以避免覆盖数据'
          : '流水文件损坏且没有可用备份，已停止加载以避免覆盖数据'
      )
    }
    if (label !== '大额支出') this.txnsMissing = true
    return []
  }

  private async readTxns(): Promise<Txn[]> {
    return this.readTxnCollection(TXN_BASE, '', LEGACY_TXN_FILE)
  }

  private async readLargeTxns(): Promise<Txn[]> {
    return this.readTxnCollection(LARGE_TXN_BASE, '大额支出')
  }

  private async readMeta(): Promise<Meta> {
    let corrupt = false

    const current = await this.readJson<unknown>(this.file(META_FILE))
    if (current.kind === 'ok' && isMetaShape(current.value)) {
      return normalizeMeta(current.value, defaultMeta())
    }
    if (current.kind !== 'missing') corrupt = true

    const backup = await this.readJson<unknown>(`${this.file(META_FILE)}.bak`)
    if (backup.kind === 'ok' && isMetaShape(backup.value)) {
      this.recovered = true
      return normalizeMeta(backup.value, defaultMeta())
    }
    if (backup.kind !== 'missing') corrupt = true

    // 旧版文件只作最后兜底，避免它压过更新的备份
    const legacy = await this.readJson<unknown>(this.file(LEGACY_META_FILE))
    if (legacy.kind === 'ok' && isMetaShape(legacy.value)) {
      this.migratedMeta = true
      this.recovered = true
      return normalizeMeta(legacy.value, defaultMeta())
    }
    if (legacy.kind !== 'missing') corrupt = true

    if (corrupt) throw new Error('账本元数据损坏且没有可用备份，已停止加载以避免覆盖数据')
    this.metaMissing = true
    return defaultMeta()
  }

  /**
   * 早期大额记录沿用支出分类，改为独立标签集合后按名称迁移到对应大额分类，
   * 找不到同名分类时落到「其他」。
   */
  private migrateLargeCategoryRefs(meta: Meta, largeTxns: Txn[]): void {
    if (!largeTxns.length) return
    const byId = new Map(meta.categories.map((item) => [item.id, item]))
    const largeCategories = meta.categories.filter((item) => item.type === 'large')
    if (!largeCategories.length) return

    const labelOf = (category: Category): string => {
      if (!category.parentId) return category.name
      const parent = byId.get(category.parentId)
      return parent ? `${parent.name}/${category.name}` : category.name
    }
    const byLabel = new Map(largeCategories.map((item) => [labelOf(item), item]))
    const fallback =
      largeCategories.find((item) => !item.parentId && item.name === '其他') ??
      largeCategories.find((item) => !item.parentId) ??
      largeCategories[0]

    let changed = false
    for (const txn of largeTxns) {
      if (!txn.categoryId) continue
      const current = byId.get(txn.categoryId)
      if (current && current.type === 'large') continue
      const target = current ? byLabel.get(labelOf(current)) : undefined
      txn.categoryId = target?.id ?? fallback.id
      changed = true
    }
    if (changed) this.migratedLargeCategories = true
  }

  private async ensureState(): Promise<LedgerState> {
    if (!this.state) {
      await fs.mkdir(this.dir(), { recursive: true })
      const txns = await this.readTxns()
      const largeTxns = await this.readLargeTxns()
      const meta = await this.readMeta()
      this.migrateLargeCategoryRefs(meta, largeTxns)
      if (this.metaMissing && txns.length) {
        this.warnings.push('账户与分类的元数据缺失，已使用默认值，请先导出核对')
      }
      if (this.txnsMissing && !this.metaMissing) {
        this.warnings.push('流水文件缺失，已按空账本显示，请先从数据目录核对或恢复')
      }
      this.metaMissing = false
      this.txnsMissing = false
      this.state = { txns, largeTxns, meta }
    }
    return this.state
  }

  private async repairMainFiles(state: LedgerState): Promise<void> {
    try {
      await this.writeJson(TXN_FILE, { schemaVersion: SCHEMA_VERSION, txns: state.txns } satisfies StoredTxns)
    } catch {
      /* 修复失败时保持只读结果，用户仍可导出 */
    }
    try {
      await this.writeJson(LARGE_TXN_FILE, {
        schemaVersion: SCHEMA_VERSION,
        txns: state.largeTxns
      } satisfies StoredTxns)
    } catch {
      /* 同上 */
    }
    try {
      await this.writeJson(META_FILE, state.meta)
    } catch {
      /* 同上 */
    }
  }

  /** 迁移成功后把旧版文件改名，防止它在下次损坏恢复时再次抢先命中 */
  private async retireLegacy(name: string): Promise<void> {
    try {
      await fs.rename(this.file(name), `${this.file(name)}.${Date.now()}.migrated`)
    } catch {
      /* 旧文件不存在或无法改名时忽略 */
    }
  }

  async load(): Promise<LedgerData> {
    return this.enqueue(async () => {
      const state = await this.ensureState()
      const recovered = this.recovered
      const warning = this.warnings.length ? this.warnings.join('；') : undefined
      this.recovered = false
      this.warnings = []
      if (recovered || this.migratedTxns || this.migratedMeta || this.migratedLargeCategories) {
        // 修复写入也走队列，避免与并发保存共用临时文件
        await this.repairMainFiles(state)
        if (this.migratedTxns) await this.retireLegacy(LEGACY_TXN_FILE)
        if (this.migratedMeta) await this.retireLegacy(LEGACY_META_FILE)
        this.migratedTxns = false
        this.migratedMeta = false
        this.migratedLargeCategories = false
      }
      return { txns: state.txns, largeTxns: state.largeTxns, meta: state.meta, recovered, warning }
    })
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

  private async pruneSnapshots(base: string): Promise<void> {
    const names = await this.snapshotFiles(base)
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
    const base = name.replace(/\.json$/, '')
    const target = `${base}.${stamp}.json`
    try {
      await fs.access(this.file(target))
      return
    } catch {
      /* 当天还没有快照 */
    }
    try {
      await fs.copyFile(this.file(name), this.file(target))
      await this.pruneSnapshots(base)
    } catch {
      /* 快照失败不阻断写入 */
    }
  }

  /** 每次写入使用独立临时文件，避免并发写入互相覆盖 */
  private tempPath(target: string): string {
    const stamp = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return `${target}.${stamp}.tmp`
  }

  private async writeAttempt(target: string, text: string): Promise<void> {
    const temp = this.tempPath(target)
    try {
      await fs.writeFile(temp, text, 'utf-8')
      await fs.rename(temp, target)
    } catch (err) {
      try {
        await fs.unlink(temp)
      } catch {
        /* 临时文件可能已被移走 */
      }
      throw err
    }
  }

  /** 原子写入：先写临时文件再改名，避免中途崩溃留下半截 JSON */
  private async writeJson(name: string, payload: unknown): Promise<void> {
    const target = this.file(name)
    const text = JSON.stringify(payload, null, 2)
    await fs.mkdir(this.dir(), { recursive: true })
    try {
      await this.writeAttempt(target, text)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
    }
    // 杀软或索引服务短暂占用句柄时延迟重试一次
    await delay(200)
    await this.writeAttempt(target, text)
  }

  private async persistTxns(txns: Txn[]): Promise<void> {
    await this.backupFile(TXN_FILE)
    await this.snapshotToday(TXN_FILE, localDate())
    await this.writeJson(TXN_FILE, { schemaVersion: SCHEMA_VERSION, txns } satisfies StoredTxns)
  }

  private async persistLargeTxns(largeTxns: Txn[]): Promise<void> {
    await this.backupFile(LARGE_TXN_FILE)
    await this.snapshotToday(LARGE_TXN_FILE, localDate())
    await this.writeJson(LARGE_TXN_FILE, {
      schemaVersion: SCHEMA_VERSION,
      txns: largeTxns
    } satisfies StoredTxns)
  }

  private async persistMeta(meta: Meta): Promise<void> {
    await this.backupFile(META_FILE)
    await this.writeJson(META_FILE, meta)
  }

  /** 两文件同时失败时把流水回滚到上一份备份，避免出现新流水配旧元数据 */
  private async restoreFileFromBackup(name: string): Promise<void> {
    try {
      const backup = `${this.file(name)}.bak`
      await fs.access(backup)
      await fs.copyFile(backup, this.file(name))
    } catch {
      /* 回滚失败时保持原状，由上层提示 */
    }
  }

  mutateTxns<T>(work: (txns: Txn[], state: LedgerState) => T): Promise<T> {
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

  mutateLargeTxns<T>(work: (largeTxns: Txn[], state: LedgerState) => T): Promise<T> {
    return this.enqueue(async () => {
      const state = await this.ensureState()
      const result = work(state.largeTxns, state)
      try {
        await this.persistLargeTxns(state.largeTxns)
      } catch (err) {
        this.state = null
        throw err
      }
      return result
    })
  }

  mutateMeta<T>(work: (meta: Meta, state: LedgerState) => T): Promise<T> {
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

  /** 同时修改流水与元数据，写入失败时回滚流水，保证两文件口径一致 */
  mutateState<T>(work: (state: LedgerState) => T): Promise<T> {
    return this.enqueue(async () => {
      const state = await this.ensureState()
      const result = work(state)
      try {
        await this.persistTxns(state.txns)
        await this.persistLargeTxns(state.largeTxns)
        await this.persistMeta(state.meta)
      } catch (err) {
        await this.restoreFileFromBackup(TXN_FILE)
        await this.restoreFileFromBackup(LARGE_TXN_FILE)
        this.state = null
        throw err
      }
      return result
    })
  }

  /** 只读访问当前状态，用于导出与统计 */
  async snapshotState(): Promise<LedgerState> {
    return this.enqueue(() => this.ensureState())
  }

  /** 整库替换，用于导入恢复；写入前沿用备份与当日快照机制 */
  replaceAll(txns: Txn[], largeTxns: Txn[], meta: Meta): Promise<void> {
    return this.enqueue(async () => {
      // 旧备份中的大额记录可能仍引用支出分类，导入时一并迁移
      this.migrateLargeCategoryRefs(meta, largeTxns)
      this.migratedLargeCategories = false
      this.state = { txns, largeTxns, meta }
      try {
        await this.persistTxns(txns)
        await this.persistLargeTxns(largeTxns)
        await this.persistMeta(meta)
      } catch (err) {
        await this.restoreFileFromBackup(TXN_FILE)
        await this.restoreFileFromBackup(LARGE_TXN_FILE)
        this.state = null
        throw err
      }
    })
  }
}
