import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import type { PluginContext, PluginMainModule } from '../../src/shared/types'
import { LedgerStore, defaultMeta } from './store'
import {
  CURRENCY_META,
  CURRENCIES,
  ACCOUNT_TYPES,
  categoryLabel,
  filterTxns,
  rateToBase,
  toBaseCents,
  accountBalance,
  accountTotal,
  latestRates,
  today
} from './calc'
import type {
  Account,
  Category,
  Currency,
  ExportRequest,
  Meta,
  RatePoint,
  Settings,
  Txn,
  TxnType,
  LedgerData
} from './types'

let store: LedgerStore | null = null

function db(ctx: PluginContext): LedgerStore {
  if (!store) store = new LedgerStore(ctx)
  return store
}

const newId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const round = (value: number): number => Math.round(value)

interface TxnDraft {
  id?: string
  type: TxnType
  date: string
  createdAt?: number
  amount: number
  currency: Currency
  accountId: string
  categoryId: string | null
  note?: string
  tags?: string[]
  toAccountId?: string
  toCurrency?: Currency
  toAmount?: number
  /** 撤销删除时回传原快照，避免按当前汇率重算 */
  rateToBase?: number
  reimbursable?: boolean
  excludeFromStats?: boolean
}

interface AccountDraft {
  id?: string
  name: string
  type: Account['type']
  initial?: Partial<Record<Currency, number>>
  archived?: boolean
}

interface CategoryDraft {
  id?: string
  name: string
  parentId: string | null
  type: Category['type']
}

interface ExportArgs extends ExportRequest {
  fileBase: string
}

interface RateResponse {
  amount: number
  base: string
  date: string
  rates: Record<string, number>
}

/** 现汇按央行中间价的 100.5% 折算 */
const RATE_UPLIFT = 1.005

async function fetchCnyRates(): Promise<{ date: string; map: Partial<Record<Currency, number>> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=CNY&to=EUR,USD,GBP', {
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`汇率接口返回 ${response.status}`)
    const payload = (await response.json()) as RateResponse
    const map: Partial<Record<Currency, number>> = { CNY: 1 }
    for (const currency of ['EUR', 'USD', 'GBP'] as Currency[]) {
      const quoted = payload.rates?.[currency]
      if (typeof quoted === 'number' && quoted > 0) {
        map[currency] = Number(((1 / quoted) * RATE_UPLIFT).toFixed(6))
      }
    }
    return { date: payload.date ?? today(), map }
  } finally {
    clearTimeout(timer)
  }
}

function upsertRate(meta: Meta, date: string, map: Partial<Record<Currency, number>>): void {
  const existing = meta.rates.find((item) => item.date === date)
  if (existing) {
    existing.map = { ...existing.map, ...map }
  } else {
    meta.rates.push({ date, map: { ...map } } satisfies RatePoint)
  }
  meta.rates = [...meta.rates].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 30)
  meta.ratesFetchedAt = Date.now()
  meta.settings.rateUpdatedAt = Date.now()
}

function accountName(accounts: Account[], id?: string): string {
  if (!id) return ''
  return accounts.find((item) => item.id === id)?.name ?? id
}

function txnTypeLabel(type: TxnType): string {
  if (type === 'income') return '收入'
  if (type === 'transfer') return '转账'
  return '支出'
}

interface ExportRow {
  date: string
  type: string
  amount: number
  currency: Currency
  rate: number
  baseAmount: number
  baseCurrency: Currency
  parent: string
  child: string
  account: string
  toAccount: string
  toCurrency: string
  toAmount: string
  note: string
  tags: string
  reimbursable: string
  counted: string
  id: string
}

function buildRows(txns: Txn[], args: ExportArgs, meta: Meta): ExportRow[] {
  const list = filterTxns(
    txns,
    {
      from: args.from,
      to: args.to,
      accountId: args.accountId,
      currency: args.currency || undefined,
      keyword: args.keyword
    },
    meta.categories
  ).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt))

  return list.map((txn) => {
    const label = categoryLabel(meta.categories, txn.categoryId)
    const rate = txn.rateToBase || rateToBase(meta, txn.currency)
    return {
      date: txn.date,
      type: txnTypeLabel(txn.type),
      amount: txn.amount / 100,
      currency: txn.currency,
      rate: Number(rate.toFixed(6)),
      baseAmount: (txn.baseAmount || toBaseCents(txn.amount, txn.currency, meta)) / 100,
      baseCurrency: meta.settings.baseCurrency,
      parent: label?.parent ?? '',
      child: label?.child ?? '',
      account: accountName(meta.accounts, txn.accountId),
      toAccount: accountName(meta.accounts, txn.toAccountId),
      toCurrency: txn.toCurrency ?? '',
      toAmount: txn.toAmount ? (txn.toAmount / 100).toFixed(2) : '',
      note: txn.note,
      tags: txn.tags.join(' '),
      reimbursable: txn.reimbursable ? '是' : '否',
      counted: txn.excludeFromStats ? '否' : '是',
      id: txn.id
    }
  })
}

const CSV_HEADER = [
  '日期',
  '类型',
  '金额',
  '币种',
  '汇率',
  '折算金额',
  '本位币',
  '一级分类',
  '二级分类',
  '账户',
  '目标账户',
  '目标币种',
  '目标金额',
  '备注',
  '标签',
  '报销',
  '计入统计',
  '记录ID'
]

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function buildCsv(rows: ExportRow[]): string {
  const lines = [CSV_HEADER.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.date,
        row.type,
        row.amount.toFixed(2),
        row.currency,
        row.rate.toFixed(6),
        row.baseAmount.toFixed(2),
        row.baseCurrency,
        row.parent,
        row.child,
        row.account,
        row.toAccount,
        row.toCurrency,
        row.toAmount,
        row.note,
        row.tags,
        row.reimbursable,
        row.counted,
        row.id
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return `\uFEFF${lines.join('\n')}`
}

function markdownHeader(args: ExportArgs): string {
  const title = args.label?.trim() || `${args.from} 至 ${args.to}`
  return `# 记账导出\n\n期间：${title}\n`
}

/** Markdown 表格单元格转义：竖线会破坏列结构，换行会破坏行结构 */
function mdCell(value: string | number): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function buildMarkdown(rows: ExportRow[], args: ExportArgs, meta: Meta): string {
  const symbol = CURRENCY_META[meta.settings.baseCurrency].symbol
  const expense = rows.filter((row) => row.type === '支出').reduce((sum, row) => sum + row.baseAmount, 0)
  const income = rows.filter((row) => row.type === '收入').reduce((sum, row) => sum + row.baseAmount, 0)

  const lines = [
    markdownHeader(args),
    `支出合计 ${symbol}${expense.toFixed(2)}　收入合计 ${symbol}${income.toFixed(2)}`,
    '',
    '| 日期 | 类型 | 分类 | 账户 | 金额 | 折算 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ]

  for (const row of rows) {
    const category = row.child ? `${row.parent} / ${row.child}` : row.parent || '转账'
    const amount = `${CURRENCY_META[row.currency].symbol}${row.amount.toFixed(2)}`
    lines.push(
      `| ${mdCell(row.date)} | ${mdCell(row.type)} | ${mdCell(category)} | ${mdCell(row.account)} | ${mdCell(amount)} | ${mdCell(`${symbol}${row.baseAmount.toFixed(2)}`)} | ${mdCell(row.note)} |`
    )
  }

  return lines.join('\n')
}

function monthOf(date: string): string {
  return date.slice(0, 7)
}

function buildWorkbook(rows: ExportRow[], meta: Meta): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new()
  const symbol = CURRENCY_META[meta.settings.baseCurrency].symbol

  const detail = [
    CSV_HEADER,
    ...rows.map((row) => [
      row.date,
      row.type,
      row.amount,
      row.currency,
      row.rate,
      row.baseAmount,
      row.baseCurrency,
      row.parent,
      row.child,
      row.account,
      row.toAccount,
      row.toCurrency,
      row.toAmount,
      row.note,
      row.tags,
      row.reimbursable,
      row.counted,
      row.id
    ])
  ]
  const detailSheet = XLSX.utils.aoa_to_sheet(detail)
  detailSheet['!cols'] = [
    { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 11 },
    { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 9 },
    { wch: 11 }, { wch: 24 }, { wch: 14 }, { wch: 7 }, { wch: 9 }, { wch: 24 }
  ]
  XLSX.utils.book_append_sheet(workbook, detailSheet, '交易明细')

  const periodMap = new Map<string, { expense: number; income: number; count: number }>()
  for (const row of rows) {
    if (row.type === '转账') continue
    const key = monthOf(row.date)
    const bucket = periodMap.get(key) ?? { expense: 0, income: 0, count: 0 }
    if (row.type === '支出') bucket.expense += row.baseAmount
    else bucket.income += row.baseAmount
    bucket.count += 1
    periodMap.set(key, bucket)
  }
  const periodRows: Array<Array<string | number>> = [['月份', `支出（${symbol}）`, `收入（${symbol}）`, `净额（${symbol}）`, '笔数']]
  for (const [month, bucket] of [...periodMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    periodRows.push([
      month,
      Number(bucket.expense.toFixed(2)),
      Number(bucket.income.toFixed(2)),
      Number((bucket.income - bucket.expense).toFixed(2)),
      bucket.count
    ])
  }
  const totalExpense = [...periodMap.values()].reduce((sum, item) => sum + item.expense, 0)
  const totalIncome = [...periodMap.values()].reduce((sum, item) => sum + item.income, 0)
  const totalCount = [...periodMap.values()].reduce((sum, item) => sum + item.count, 0)
  periodRows.push(['合计', Number(totalExpense.toFixed(2)), Number(totalIncome.toFixed(2)), Number((totalIncome - totalExpense).toFixed(2)), totalCount])
  const periodSheet = XLSX.utils.aoa_to_sheet(periodRows)
  periodSheet['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 8 }]
  XLSX.utils.book_append_sheet(workbook, periodSheet, '期间汇总')

  const categoryMap = new Map<string, { parent: string; child: string; amount: number }>()
  for (const row of rows) {
    if (row.type !== '支出') continue
    const key = `${row.parent}|${row.child}`
    const bucket = categoryMap.get(key) ?? { parent: row.parent || '未分类', child: row.child, amount: 0 }
    bucket.amount += row.baseAmount
    categoryMap.set(key, bucket)
  }
  const categoryRows: Array<Array<string | number>> = [['一级分类', '二级分类', `支出（${symbol}）`, '占比']]
  for (const [, bucket] of [...categoryMap.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
    const ratio = totalExpense ? bucket.amount / totalExpense : 0
    categoryRows.push([bucket.parent, bucket.child, Number(bucket.amount.toFixed(2)), `${(ratio * 100).toFixed(1)}%`])
  }
  const categorySheet = XLSX.utils.aoa_to_sheet(categoryRows)
  categorySheet['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 15 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(workbook, categorySheet, '分类汇总')

  return workbook
}

function buildBalanceSheet(
  txns: Txn[],
  meta: Meta
): Array<Array<string | number>> {
  const symbol = CURRENCY_META[meta.settings.baseCurrency].symbol
  const ratePoint = latestRates(meta)
  const rows: Array<Array<string | number>> = [
    ['账户', '类型', '币种', '余额', `折算（${symbol}）`, '汇率日期']
  ]
  for (const account of [...meta.accounts].sort((a, b) => a.order - b.order)) {
    for (const currency of CURRENCIES) {
      const balance = accountBalance(txns, account, currency)
      if (!balance) continue
      rows.push([
        account.name,
        ACCOUNT_TYPES[account.type],
        currency,
        Number((balance / 100).toFixed(2)),
        Number((toBaseCents(balance, currency, meta) / 100).toFixed(2)),
        ratePoint?.date ?? '未获取'
      ])
    }
    const total = accountTotal(txns, account, meta)
    rows.push([account.name, ACCOUNT_TYPES[account.type], '合计', '', Number((total / 100).toFixed(2)), ratePoint?.date ?? '未获取'])
  }
  return rows
}

interface ImportPreview {
  path: string
  exportedAt: string
  txnCount: number
  accountCount: number
  categoryCount: number
}

interface ImportResult {
  txnCount: number
  safetyPath: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as string[]).includes(value)

const ACCOUNT_TYPE_NAMES: string[] = ['cash', 'bank', 'ewallet', 'credit']

const isAccountType = (value: unknown): value is Account['type'] =>
  typeof value === 'string' && ACCOUNT_TYPE_NAMES.includes(value)

const isTxnType = (value: unknown): value is TxnType =>
  value === 'expense' || value === 'income' || value === 'transfer'

function uniqueById<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function normalizeInitial(raw: unknown): Partial<Record<Currency, number>> {
  const initial: Partial<Record<Currency, number>> = {}
  if (!isRecord(raw)) return initial
  for (const currency of CURRENCIES) {
    const value = raw[currency]
    if (isNumber(value)) initial[currency] = Math.round(value)
  }
  return initial
}

function normalizeAccounts(raw: unknown): Account[] {
  if (!Array.isArray(raw)) return []
  const list: Account[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!id || !name) continue
    list.push({
      id,
      name,
      type: isAccountType(item.type) ? item.type : 'cash',
      initial: normalizeInitial(item.initial),
      archived: Boolean(item.archived),
      order: isNumber(item.order) ? item.order : list.length,
      deleted: Boolean(item.deleted)
    })
  }
  return uniqueById(list)
}

function normalizeCategories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return []
  const list: Category[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!id || !name) continue
    list.push({
      id,
      name,
      parentId: typeof item.parentId === 'string' && item.parentId ? item.parentId : null,
      type: item.type === 'income' ? 'income' : 'expense',
      order: isNumber(item.order) ? item.order : list.length,
      archived: Boolean(item.archived)
    })
  }
  const categories = uniqueById(list)
  const ids = new Set(categories.map((item) => item.id))
  for (const category of categories) {
    if (category.parentId && !ids.has(category.parentId)) category.parentId = null
  }
  return categories
}

function normalizeRates(raw: unknown): RatePoint[] {
  if (!Array.isArray(raw)) return []
  const list: RatePoint[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const date = typeof item.date === 'string' ? item.date : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const map: Partial<Record<Currency, number>> = {}
    if (isRecord(item.map)) {
      for (const currency of CURRENCIES) {
        const value = item.map[currency]
        if (isNumber(value) && value > 0) map[currency] = value
      }
    }
    list.push({ date, map })
  }
  return [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 30)
}

function normalizeSettings(raw: unknown, accounts: Account[], categories: Category[]): Settings {
  const base = defaultMeta().settings
  const liveAccounts = accounts.filter((item) => !item.deleted)
  const fallbackAccount =
    liveAccounts.find((item) => !item.archived)?.id ?? liveAccounts[0]?.id ?? ''
  const fallbackCategory = categories.find((item) => !item.archived)?.id ?? categories[0]?.id ?? ''
  if (!isRecord(raw)) {
    return { ...base, defaultAccountId: fallbackAccount, lastCategoryId: fallbackCategory }
  }
  const defaultAccountId =
    typeof raw.defaultAccountId === 'string' &&
    liveAccounts.some((item) => item.id === raw.defaultAccountId)
      ? raw.defaultAccountId
      : fallbackAccount
  const lastCategoryId =
    typeof raw.lastCategoryId === 'string' && categories.some((item) => item.id === raw.lastCategoryId)
      ? raw.lastCategoryId
      : fallbackCategory
  return {
    baseCurrency: isCurrency(raw.baseCurrency) ? raw.baseCurrency : base.baseCurrency,
    defaultAccountId,
    lastCategoryId,
    lastCurrency: isCurrency(raw.lastCurrency) ? raw.lastCurrency : base.lastCurrency,
    rateUpdatedAt: isNumber(raw.rateUpdatedAt) ? raw.rateUpdatedAt : null
  }
}

function normalizeTxns(raw: unknown): Txn[] {
  if (!Array.isArray(raw)) return []
  const list: Txn[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const accountId = typeof item.accountId === 'string' ? item.accountId : ''
    const date = typeof item.date === 'string' ? item.date : ''
    if (!id || !accountId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (!isTxnType(item.type) || !isCurrency(item.currency)) continue
    if (!isNumber(item.amount) || item.amount <= 0) continue
    const currency = item.currency
    const amount = Math.round(item.amount)
    const rateToBase =
      isNumber(item.rateToBase) && item.rateToBase > 0
        ? item.rateToBase
        : currency === 'CNY'
          ? 1
          : 0
    const txn: Txn = {
      id,
      type: item.type,
      date,
      createdAt: isNumber(item.createdAt) ? item.createdAt : 0,
      amount,
      currency,
      accountId,
      categoryId: typeof item.categoryId === 'string' && item.categoryId ? item.categoryId : null,
      note: typeof item.note === 'string' ? item.note : '',
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      rateToBase,
      baseAmount: isNumber(item.baseAmount) ? Math.round(item.baseAmount) : 0,
      reimbursable: Boolean(item.reimbursable),
      excludeFromStats: Boolean(item.excludeFromStats)
    }
    if (txn.type === 'transfer') {
      const toAccountId = typeof item.toAccountId === 'string' ? item.toAccountId : ''
      if (!toAccountId) continue
      const toCurrency = isCurrency(item.toCurrency) ? item.toCurrency : currency
      const toAmount = isNumber(item.toAmount) && item.toAmount > 0 ? Math.round(item.toAmount) : amount
      txn.toAccountId = toAccountId
      txn.toCurrency = toCurrency
      txn.toAmount = toAmount
      txn.fxRate = isNumber(item.fxRate) && item.fxRate > 0 ? item.fxRate : toAmount / amount
    }
    list.push(txn)
  }
  return uniqueById(list)
}

/** 解析整库备份，字段缺失或类型异常时只保留可用数据 */
function parseBackup(raw: unknown): { txns: Txn[]; meta: Meta; exportedAt: string } {
  if (!isRecord(raw)) throw new Error('文件内容不是 JSON 对象')
  if (!Array.isArray(raw.txns) || !isRecord(raw.meta)) {
    throw new Error('缺少 txns 或 meta 字段，请选择「导出整库 JSON」生成的文件')
  }
  const accounts = normalizeAccounts(raw.meta.accounts)
  const categories = normalizeCategories(raw.meta.categories)
  const meta: Meta = {
    schemaVersion: 1,
    settings: normalizeSettings(raw.meta.settings, accounts, categories),
    accounts,
    categories,
    rates: normalizeRates(raw.meta.rates),
    ratesFetchedAt: isNumber(raw.meta.ratesFetchedAt) ? raw.meta.ratesFetchedAt : null
  }
  return {
    txns: normalizeTxns(raw.txns),
    meta,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : ''
  }
}

async function readBackup(source: string): Promise<{ txns: Txn[]; meta: Meta; exportedAt: string }> {
  let text: string
  try {
    text = await fs.readFile(source, 'utf-8')
  } catch {
    throw new Error('无法读取所选文件，请确认文件仍然存在')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  return parseBackup(parsed)
}

const KEEP_IMPORT_BACKUPS = 7

/** 导入前另存当前整库，误导入时可从该文件恢复 */
async function writeBeforeImportBackup(ctx: PluginContext, txns: Txn[], meta: Meta): Promise<string> {
  const dir = path.join(ctx.userDataPath, 'data')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `ledger.before-import.${stamp}.json`)
  await fs.writeFile(target, JSON.stringify({ exportedAt: new Date().toISOString(), txns, meta }, null, 2), 'utf-8')
  try {
    const names = (await fs.readdir(dir))
      .filter((name) => /^ledger\.before-import\..+\.json$/.test(name))
      .sort()
      .reverse()
    for (const name of names.slice(KEEP_IMPORT_BACKUPS)) {
      await fs.unlink(path.join(dir, name))
    }
  } catch {
    /* 清理失败不影响导入 */
  }
  return target
}

const handlers: PluginMainModule['handlers'] = {
  async load(_args, ctx): Promise<LedgerData> {
    return db(ctx).load()
  },

  async saveTxn(args, ctx) {
    const draft = args as TxnDraft
    const ledger = db(ctx)
    const txn = await ledger.mutateTxns((txns, state) => {
      if (!draft.accountId) throw new Error('请选择账户')
      if (!Number.isInteger(draft.amount) || draft.amount <= 0) throw new Error('金额需要大于 0')
      if (!state.meta.accounts.some((item) => item.id === draft.accountId)) {
        throw new Error('账户不存在，请重新选择')
      }
      if (draft.type !== 'transfer' && !draft.categoryId) throw new Error('请选择分类')
      if (draft.type !== 'transfer' && !state.meta.categories.some((item) => item.id === draft.categoryId)) {
        throw new Error('分类不存在，请重新选择')
      }
      const existing = txns.find((item) => item.id === (draft.id ?? ''))
      const rate = existing
        ? existing.currency === draft.currency
          ? existing.rateToBase
          : rateToBase(state.meta, draft.currency)
        : draft.rateToBase && draft.rateToBase > 0
          ? draft.rateToBase
          : rateToBase(state.meta, draft.currency)
      if (!rate) throw new Error(`缺少 ${draft.currency} 汇率，请先在设置页获取或手填`)

      const record: Txn = {
        id: draft.id ?? newId('txn'),
        type: draft.type,
        date: draft.date,
        createdAt: existing?.createdAt ?? draft.createdAt ?? Date.now(),
        amount: round(draft.amount),
        currency: draft.currency,
        accountId: draft.accountId,
        categoryId: draft.type === 'transfer' ? null : draft.categoryId,
        note: draft.note ?? '',
        tags: draft.tags ?? [],
        rateToBase: rate,
        baseAmount: round(draft.amount * rate),
        reimbursable: Boolean(draft.reimbursable),
        excludeFromStats: Boolean(draft.excludeFromStats)
      }

      if (draft.type === 'transfer') {
        if (!draft.toAccountId) throw new Error('请选择转入账户')
        if (draft.toAccountId === draft.accountId) throw new Error('转入账户不能与转出账户相同')
        if (!state.meta.accounts.some((item) => item.id === draft.toAccountId)) {
          throw new Error('转入账户不存在，请重新选择')
        }
        const toCurrency = draft.toCurrency ?? draft.currency
        if (toCurrency !== draft.currency && (!draft.toAmount || draft.toAmount <= 0)) {
          throw new Error('跨币种转账需要填写到账金额')
        }
        record.toAccountId = draft.toAccountId
        record.toCurrency = toCurrency
        record.toAmount = draft.toAmount && draft.toAmount > 0 ? round(draft.toAmount) : record.amount
        record.fxRate = record.toAmount / record.amount
      }

      const index = txns.findIndex((item) => item.id === record.id)
      if (index >= 0) txns.splice(index, 1, record)
      else txns.push(record)
      return record
    })

    // 上次使用的币种与分类单独落盘；这一步失败不影响已保存的流水
    try {
      await ledger.mutateMeta((meta) => {
        meta.settings.lastCurrency = draft.currency
        if (draft.categoryId) meta.settings.lastCategoryId = draft.categoryId
      })
    } catch {
      /* 忽略「上次使用值」的落盘失败 */
    }

    return txn
  },

  async deleteTxn(args, ctx) {
    const { id } = args as { id: string }
    return db(ctx).mutateTxns((txns) => {
      const index = txns.findIndex((item) => item.id === id)
      if (index >= 0) txns.splice(index, 1)
    })
  },

  async saveAccount(args, ctx): Promise<Account> {
    const draft = args as AccountDraft
    if (!draft.name?.trim()) throw new Error('请填写账户名称')
    return db(ctx).mutateMeta((meta) => {
      const existing = draft.id ? meta.accounts.find((item) => item.id === draft.id) : undefined
      if (existing) {
        existing.name = draft.name.trim()
        existing.type = draft.type
        existing.initial = draft.initial ?? {}
        if (typeof draft.archived === 'boolean') existing.archived = draft.archived
        return existing
      }
      const account: Account = {
        id: draft.id ?? newId('acc'),
        name: draft.name.trim(),
        type: draft.type,
        initial: draft.initial ?? {},
        archived: Boolean(draft.archived),
        order: meta.accounts.reduce((max, item) => Math.max(max, item.order), -1) + 1
      }
      meta.accounts.push(account)
      if (!meta.settings.defaultAccountId) meta.settings.defaultAccountId = account.id
      return account
    })
  },

  async reorderAccounts(args, ctx): Promise<Account[]> {
    const { ids } = args as { ids: string[] }
    if (!Array.isArray(ids) || !ids.length) return []
    return db(ctx).mutateMeta((meta) => {
      // 只接受已有账户的 id，缺失的账户按原相对顺序补到末尾
      const known = new Set(meta.accounts.map((item) => item.id))
      const ordered = ids.filter((id, index) => known.has(id) && ids.indexOf(id) === index)
      for (const account of meta.accounts) {
        if (!ordered.includes(account.id)) ordered.push(account.id)
      }
      const next = ordered.map((id) => meta.accounts.find((item) => item.id === id) as Account)
      next.forEach((account, index) => {
        account.order = index
      })
      meta.accounts = next
      return meta.accounts
    })
  },

  async deleteAccount(args, ctx) {
    const { id } = args as { id: string }
    const ledger = db(ctx)
    const state = await ledger.snapshotState()
    const target = state.meta.accounts.find((item) => item.id === id)
    if (!target || target.deleted) return { ok: false, reason: '账户不存在' }
    // 软删除：保留账户记录供历史流水引用，仅从界面与选择器中隐藏
    await ledger.mutateMeta((meta) => {
      const account = meta.accounts.find((item) => item.id === id)
      if (account) account.deleted = true
      if (meta.settings.defaultAccountId === id) {
        const fallback = meta.accounts.find((item) => item.id !== id && !item.deleted)
        meta.settings.defaultAccountId = fallback?.id ?? ''
      }
    })
    return { ok: true }
  },

  async saveCategory(args, ctx) {
    const draft = args as CategoryDraft
    const name = (draft.name ?? '').trim()
    if (!name) throw new Error('请填写标签名称')
    return db(ctx).mutateMeta((meta) => {
      const existing = draft.id ? meta.categories.find((item) => item.id === draft.id) : undefined
      if (existing) {
        existing.name = name
        existing.parentId = draft.parentId
        return existing
      }
      const duplicate = meta.categories.some(
        (item) => item.name === name && item.parentId === draft.parentId && item.type === draft.type
      )
      if (duplicate) throw new Error('同名标签已存在')
      const category: Category = {
        id: draft.id ?? newId('cat'),
        name,
        parentId: draft.parentId,
        type: draft.type,
        order: meta.categories.reduce((max, item) => Math.max(max, item.order), -1) + 1,
        archived: false
      }
      meta.categories.push(category)
      return category
    })
  },

  /** 删除分类：引用记录迁移到同类型的「其他」，返回迁移笔数 */
  async deleteCategory(args, ctx) {
    const { id, cascade } = args as { id: string; cascade?: boolean }
    const ledger = db(ctx)
    const state = await ledger.snapshotState()
    const target = state.meta.categories.find((item) => item.id === id)
    if (!target) return { ok: false, reason: '标签不存在' }

    const children = state.meta.categories.filter((item) => item.parentId === id)
    if (children.length && !cascade) {
      return { ok: false, reason: '该一级分类下还有标签，请先删除其标签', childCount: children.length }
    }
    // 一级分类至少要保留一个，否则录入时没有可选分类
    if (!target.parentId) {
      const siblings = state.meta.categories.filter(
        (item) => item.type === target.type && !item.parentId && item.id !== id
      )
      if (!siblings.length) return { ok: false, reason: '该类型至少需要保留一个一级分类' }
    }

    const removed = new Set<string>([id, ...children.map((item) => item.id)])
    const parentFallback = state.meta.categories.find(
      (item) =>
        item.type === target.type && !item.parentId && item.name === '其他' && !removed.has(item.id)
    )
    const fallback =
      parentFallback ??
      state.meta.categories.find(
        (item) => item.type === target.type && !item.parentId && !removed.has(item.id)
      )
    const fallbackId = fallback?.id ?? null
    // 删除二级标签时停留在原一级分类；删除一级分类时落到迁移目标，避免界面停留在已删除项
    const stayId = target.parentId ?? fallbackId ?? ''

    const moved = state.txns.filter((txn) => txn.categoryId && removed.has(txn.categoryId)).length
    if (moved) {
      await ledger.mutateTxns((txns) => {
        for (const txn of txns) {
          if (txn.categoryId && removed.has(txn.categoryId)) txn.categoryId = fallbackId
        }
      })
    }

    await ledger.mutateMeta((meta) => {
      meta.categories = meta.categories.filter((item) => !removed.has(item.id))
      if (meta.settings.lastCategoryId && removed.has(meta.settings.lastCategoryId)) {
        meta.settings.lastCategoryId = stayId
      }
    })

    return { ok: true, moved, fallbackId, stayId }
  },

  /** 一级分类排序：只重排这些分类在数组中的占位，二级分类与其他类型的位置保持不变 */
  async reorderCategories(args, ctx): Promise<Category[]> {
    const { ids } = args as { ids: string[] }
    if (!Array.isArray(ids) || !ids.length) return []
    return db(ctx).mutateMeta((meta) => {
      const known = new Set(meta.categories.map((item) => item.id))
      const ordered = ids.filter((id, index) => known.has(id) && ids.indexOf(id) === index)
      if (ordered.length !== ids.length) return meta.categories
      const targets = ordered.map((id) => meta.categories.find((item) => item.id === id) as Category)
      if (targets.some((item) => item.parentId)) return meta.categories
      if (new Set(targets.map((item) => item.type)).size !== 1) return meta.categories

      const positions: number[] = []
      meta.categories.forEach((item, index) => {
        if (ordered.includes(item.id)) positions.push(index)
      })
      if (positions.length !== ordered.length) return meta.categories
      const categories = [...meta.categories]
      positions.forEach((position, index) => {
        categories[position] = targets[index]
      })
      meta.categories = categories
      return meta.categories
    })
  },

  async saveSettings(args, ctx) {
    const patch = args as Partial<Meta['settings']>
    return db(ctx).mutateMeta((meta) => {
      meta.settings = { ...meta.settings, ...patch }
      return meta.settings
    })
  },

  async refreshRates(_args, ctx) {
    const ledger = db(ctx)
    try {
      const { date, map } = await fetchCnyRates()
      const saved = await ledger.mutateMeta((meta) => {
        upsertRate(meta, date, map)
        return { date, map }
      })
      return { ok: true, ...saved }
    } catch (err) {
      const state = await ledger.snapshotState()
      const cached = latestRates(state.meta)
      return {
        ok: false,
        date: cached?.date ?? '',
        map: cached?.map ?? {},
        error: err instanceof Error ? err.message : '汇率获取失败'
      }
    }
  },

  async saveRate(args, ctx) {
    const { currency, value } = args as { currency: Currency; value: number }
    if (currency === 'CNY') throw new Error('本位币为 CNY 时无需设置')
    if (!Number.isFinite(value) || value <= 0) throw new Error('汇率需要大于 0')
    return db(ctx).mutateMeta((meta) => {
      const date = today()
      // 以最近一次汇率为底，避免只改一个币种时其余币种在当日变成缺失
      const carried: Partial<Record<Currency, number>> = { CNY: 1, ...(latestRates(meta)?.map ?? {}) }
      upsertRate(meta, date, { ...carried, [currency]: value })
      return { date, map: latestRates(meta)?.map ?? {} }
    })
  },

  async export(args, ctx) {
    const request = args as ExportArgs
    const ledger = db(ctx)
    const { txns, meta } = await ledger.snapshotState()
    const rows = buildRows(txns, request, meta)
    const base = request.fileBase || request.from

    if (request.format === 'csv') {
      const content = buildCsv(rows)
      const saved = await ctx.saveFile(`ledger-${base}.csv`, content, [
        { name: 'CSV', extensions: ['csv'] }
      ])
      return { path: saved, count: rows.length }
    }

    if (request.format === 'md') {
      const content = buildMarkdown(rows, request, meta)
      const saved = await ctx.saveFile(`ledger-${base}.md`, content, [
        { name: 'Markdown', extensions: ['md'] }
      ])
      return { path: saved, count: rows.length }
    }

    const workbook = buildWorkbook(rows, meta)
    const balanceRows = buildBalanceSheet(txns, meta)
    const balanceSheet = XLSX.utils.aoa_to_sheet(balanceRows)
    balanceSheet['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 9 }, { wch: 12 }, { wch: 14 }, { wch: 12 }]
    XLSX.utils.book_append_sheet(workbook, balanceSheet, '账户余额')

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer
    const directory = await ctx.pickDirectory()
    if (!directory) return { path: null, count: rows.length }
    const target = path.join(directory, `ledger-${base}.xlsx`)
    await fs.writeFile(target, buffer)
    await ctx.openPath(directory)
    return { path: target, count: rows.length }
  },

  async openDataFolder(_args, ctx) {
    const dir = path.join(ctx.userDataPath, 'data')
    await fs.mkdir(dir, { recursive: true })
    await ctx.openPath(dir)
    return { path: dir }
  },

  async backup(_args, ctx) {
    const { txns, meta } = await db(ctx).snapshotState()
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), txns, meta }, null, 2)
    const saved = await ctx.saveFile(
      `ledger-backup-${today()}.json`,
      payload,
      [{ name: 'JSON', extensions: ['json'] }]
    )
    return { path: saved }
  },

  /** 选择并预检备份文件，不写入任何数据 */
  async pickImport(_args, ctx): Promise<ImportPreview | null> {
    const picked = await ctx.pickFile([{ name: 'JSON', extensions: ['json'] }])
    if (!picked) return null
    const backup = await readBackup(picked)
    return {
      path: picked,
      exportedAt: backup.exportedAt,
      txnCount: backup.txns.length,
      accountCount: backup.meta.accounts.length,
      categoryCount: backup.meta.categories.length
    }
  },

  /** 导入恢复：先另存当前整库，再用备份内容整体替换 */
  async importBackup(args, ctx): Promise<ImportResult> {
    const { path: source } = args as { path?: string }
    if (!source) throw new Error('缺少导入文件路径')
    const backup = await readBackup(source)
    const ledger = db(ctx)
    const current = await ledger.snapshotState()
    const safetyPath = await writeBeforeImportBackup(ctx, current.txns, current.meta)
    await ledger.replaceAll(backup.txns, backup.meta)
    return { txnCount: backup.txns.length, safetyPath }
  }
}

const mod: PluginMainModule = {
  manifest: {
    id: 'ledger',
    name: '记账',
    icon: 'wallet',
    description: '四币种记账，支持按月与按周汇总、账户余额与多格式导出',
    version: '0.1.0'
  },
  handlers
}

export default mod
