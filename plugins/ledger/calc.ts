import type {
  Account,
  Category,
  Currency,
  Meta,
  Range,
  Summary,
  Txn,
  TxnFilter
} from './types'

export const CURRENCIES: Currency[] = ['CNY', 'EUR', 'USD', 'GBP']

export const CURRENCY_META: Record<Currency, { symbol: string; name: string }> = {
  CNY: { symbol: '¥', name: '人民币' },
  EUR: { symbol: '€', name: '欧元' },
  USD: { symbol: '$', name: '美元' },
  GBP: { symbol: '£', name: '英镑' }
}

export const ACCOUNT_TYPES: Record<Account['type'], string> = {
  cash: '现金',
  bank: '银行卡',
  ewallet: '电子钱包',
  credit: '信用'
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function isoDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

export function today(): string {
  return isoDate(new Date())
}

export function monthRange(now = new Date()): Range {
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return {
    from: isoDate(from),
    to: isoDate(to),
    label: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  }
}

export function weekRange(now = new Date()): Range {
  const day = now.getDay() || 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - day + 1)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return {
    from: isoDate(monday),
    to: isoDate(sunday),
    label: `${isoDate(monday).slice(5)} 至 ${isoDate(sunday).slice(5)}`
  }
}

export function customRange(from: string, to: string): Range {
  const fallback = today()
  let start = from || fallback
  let end = to || fallback
  if (start > end) {
    const swap = start
    start = end
    end = swap
  }
  return { from: start, to: end, label: `${start} 至 ${end}` }
}

export function rangeFor(
  kind: 'month' | 'week' | 'custom',
  from: string,
  to: string,
  now = new Date()
): Range {
  if (kind === 'week') return weekRange(now)
  if (kind === 'custom') return customRange(from, to)
  return monthRange(now)
}

export function periodPrefix(kind: 'month' | 'week' | 'custom'): string {
  if (kind === 'week') return '本周 '
  if (kind === 'custom') return '历史 '
  return '本月 '
}

export function fileTag(kind: 'month' | 'week' | 'custom', range: Range): string {
  if (kind === 'month') return range.label
  return `${range.from}_${range.to}`
}

/** 最新一天的汇率；没有数据时返回 null */
export function latestRates(meta: Meta): { date: string; map: Partial<Record<Currency, number>> } | null {
  if (!meta.rates.length) return null
  const sorted = [...meta.rates].sort((a, b) => (a.date < b.date ? 1 : -1))
  return sorted[0]
}

/** 1 单位该币种折合多少 CNY；缺失时返回 0，调用方据此提示手填 */
export function cnyRate(meta: Meta, currency: Currency): number {
  if (currency === 'CNY') return 1
  const point = latestRates(meta)
  const value = point?.map[currency] ?? 0
  return typeof value === 'number' && value > 0 ? value : 0
}

/** 1 单位该币种折合多少本位币 */
export function rateToBase(meta: Meta, currency: Currency): number {
  const base = cnyRate(meta, meta.settings.baseCurrency)
  const own = cnyRate(meta, currency)
  if (!base || !own) return 0
  return own / base
}

export function toBaseCents(cents: number, currency: Currency, meta: Meta): number {
  const rate = rateToBase(meta, currency)
  return rate ? Math.round(cents * rate) : 0
}

export function formatMoney(cents: number, currency: Currency, withSign = false): string {
  const value = Math.abs(cents) / 100
  const text = value.toFixed(2)
  const sign = withSign ? (cents < 0 ? '-' : '+') : cents < 0 ? '-' : ''
  return `${sign}${CURRENCY_META[currency].symbol}${text}`
}

export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** 解析金额输入，支持四则运算，返回分 */
export function parseAmountToCents(raw: string): number | null {
  const text = raw.trim().replace(/[¥€$£,，\s]/g, '')
  if (!text) return null
  if (!/^[\d.+\-*/()\s.]+$/.test(text)) return null
  try {
    const value = Function(`"use strict";return (${text})`)()
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return Math.round(value * 100)
  } catch {
    return null
  }
}

export interface CategoryLabel {
  parent: string
  child: string
  full: string
}

export function categoryLabel(categories: Category[], id: string | null): CategoryLabel | null {
  if (!id) return null
  const cat = categories.find((item) => item.id === id)
  if (!cat) return null
  if (!cat.parentId) return { parent: cat.name, child: '', full: cat.name }
  const parent = categories.find((item) => item.id === cat.parentId)
  const parentName = parent ? parent.name : ''
  return {
    parent: parentName,
    child: cat.name,
    full: parentName ? `${parentName} / ${cat.name}` : cat.name
  }
}

export function matchesFilter(txn: Txn, filter: TxnFilter, categories: Category[]): boolean {
  if (txn.date < filter.from || txn.date > filter.to) return false
  if (filter.accountId && txn.accountId !== filter.accountId && txn.toAccountId !== filter.accountId) {
    return false
  }
  if (filter.currency && txn.currency !== filter.currency) return false
  const keyword = (filter.keyword ?? '').trim().toLowerCase()
  if (!keyword) return true
  const label = categoryLabel(categories, txn.categoryId)
  const hay = `${txn.note} ${label ? label.full : ''}`.toLowerCase()
  return hay.includes(keyword)
}

export function filterTxns(txns: Txn[], filter: TxnFilter, categories: Category[]): Txn[] {
  return txns.filter((txn) => matchesFilter(txn, filter, categories))
}

export function summarize(txns: Txn[], filter: TxnFilter, meta: Meta, categories: Category[]): Summary {
  const list = filterTxns(txns, filter, categories)
  const perCurrency: Summary['perCurrency'] = {}
  let expense = 0
  let income = 0
  let reimbursable = 0

  for (const txn of list) {
    if (txn.type === 'transfer' || txn.excludeFromStats) continue
    const base = txn.baseAmount || toBaseCents(txn.amount, txn.currency, meta)
    if (txn.type === 'expense') {
      if (txn.reimbursable) {
        reimbursable += base
        continue
      }
      expense += base
      const bucket = perCurrency[txn.currency] ?? { amount: 0, count: 0 }
      bucket.amount += txn.amount
      bucket.count += 1
      perCurrency[txn.currency] = bucket
    } else {
      income += base
    }
  }

  return {
    expense,
    income,
    net: income - expense,
    reimbursable,
    perCurrency
  }
}

/** 账户某币种的当前余额，单位：分 */
export function accountBalance(
  txns: Txn[],
  account: Account,
  currency: Currency
): number {
  let value = account.initial[currency] ?? 0
  for (const txn of txns) {
    if (txn.type === 'income' && txn.accountId === account.id && txn.currency === currency) {
      value += txn.amount
    } else if (txn.type === 'expense' && txn.accountId === account.id && txn.currency === currency) {
      value -= txn.amount
    } else if (txn.type === 'transfer') {
      if (txn.accountId === account.id && txn.currency === currency) {
        value -= txn.amount
      } else if (txn.toAccountId === account.id && txn.toCurrency === currency) {
        value += txn.toAmount ?? 0
      }
    }
  }
  return value
}

export function accountTotal(txns: Txn[], account: Account, meta: Meta): number {
  return CURRENCIES.reduce((sum, currency) => {
    return sum + toBaseCents(accountBalance(txns, account, currency), currency, meta)
  }, 0)
}

/** 该账户在某笔交易中的资金变化，用于账户流水展示 */
export function accountDelta(
  txn: Txn,
  accountId: string
): { cents: number; currency: Currency } | null {
  if (txn.type === 'income' && txn.accountId === accountId) {
    return { cents: txn.amount, currency: txn.currency }
  }
  if (txn.type === 'expense' && txn.accountId === accountId) {
    return { cents: -txn.amount, currency: txn.currency }
  }
  if (txn.type === 'transfer') {
    if (txn.accountId === accountId) return { cents: -txn.amount, currency: txn.currency }
    if (txn.toAccountId === accountId) {
      return { cents: txn.toAmount ?? 0, currency: txn.toCurrency ?? txn.currency }
    }
  }
  return null
}
