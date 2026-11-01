import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import type { PluginContext, PluginMainModule } from '../../src/shared/types'
import { LedgerStore } from './store'
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
  amount: number
  currency: Currency
  accountId: string
  categoryId: string | null
  note?: string
  tags?: string[]
  toAccountId?: string
  toCurrency?: Currency
  toAmount?: number
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

/** 现汇按央行中间价的 102% 折算 */
const RATE_UPLIFT = 1.02

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
  meta.rates = [...meta.rates].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30)
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
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
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
  return `# 记账导出\n\n期间：${args.from} 至 ${args.to}\n`
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
      `| ${row.date} | ${row.type} | ${category} | ${row.account} | ${amount} | ${symbol}${row.baseAmount.toFixed(2)} | ${row.note} |`
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
      const existing = txns.find((item) => item.id === (draft.id ?? ''))
      const rate =
        existing && existing.currency === draft.currency
          ? existing.rateToBase
          : rateToBase(state.meta, draft.currency)
      if (!rate) throw new Error(`缺少 ${draft.currency} 汇率，请先在设置页获取或手填`)

      const record: Txn = {
        id: draft.id ?? newId('txn'),
        type: draft.type,
        date: draft.date,
        createdAt: existing?.createdAt ?? Date.now(),
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
        record.toAccountId = draft.toAccountId
        record.toCurrency = draft.toCurrency ?? draft.currency
        record.toAmount = draft.toAmount && draft.toAmount > 0 ? draft.toAmount : draft.amount
        record.fxRate = record.toAmount / record.amount
      }

      const index = txns.findIndex((item) => item.id === record.id)
      if (index >= 0) txns.splice(index, 1, record)
      else txns.push(record)

      state.meta.settings.lastCategoryId = record.categoryId ?? state.meta.settings.lastCategoryId
      state.meta.settings.lastCurrency = record.currency
      return record
    })

    await ledger.mutateMeta((meta) => {
      meta.settings.lastCurrency = draft.currency
      if (draft.categoryId) meta.settings.lastCategoryId = draft.categoryId
    })

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

  async deleteAccount(args, ctx) {
    const { id } = args as { id: string }
    const ledger = db(ctx)
    const state = await ledger.snapshotState()
    const used = state.txns.some((txn) => txn.accountId === id || txn.toAccountId === id)
    if (used) return { ok: false, reason: '该账户已有流水，只能归档' }
    await ledger.mutateMeta((meta) => {
      meta.accounts = meta.accounts.filter((item) => item.id !== id)
      if (meta.settings.defaultAccountId === id) {
        meta.settings.defaultAccountId = meta.accounts[0]?.id ?? ''
      }
    })
    return { ok: true }
  },

  async saveCategory(args, ctx) {
    const draft = args as CategoryDraft
    return db(ctx).mutateMeta((meta) => {
      const existing = draft.id ? meta.categories.find((item) => item.id === draft.id) : undefined
      if (existing) {
        existing.name = draft.name
        existing.parentId = draft.parentId
        return existing
      }
      const category: Category = {
        id: draft.id ?? newId('cat'),
        name: draft.name,
        parentId: draft.parentId,
        type: draft.type,
        order: meta.categories.reduce((max, item) => Math.max(max, item.order), -1) + 1,
        archived: false
      }
      meta.categories.push(category)
      return category
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
      upsertRate(meta, date, { CNY: 1, [currency]: value })
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
