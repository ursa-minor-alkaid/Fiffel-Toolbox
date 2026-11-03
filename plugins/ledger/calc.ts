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

/** ISO 8601 周号，周四所在的年份即该周的年份 */
export function isoWeek(date: Date): string {
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = thursday.getDay() || 7
  thursday.setDate(thursday.getDate() + 4 - day)
  const yearStart = new Date(thursday.getFullYear(), 0, 1)
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${thursday.getFullYear()}-W${pad(week)}`
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
  if (kind === 'week') return isoWeek(new Date(`${range.from}T00:00:00`))
  return `${range.from}_${range.to}`
}

/** 最新一天的汇率；没有数据时返回 null */
export function latestRates(meta: Meta): { date: string; map: Partial<Record<Currency, number>> } | null {
  if (!meta.rates.length) return null
  const sorted = [...meta.rates].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
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

const OPERATORS: Record<string, { prec: number; apply: (left: number, right: number) => number }> = {
  '+': { prec: 1, apply: (left, right) => left + right },
  '-': { prec: 1, apply: (left, right) => left - right },
  '*': { prec: 2, apply: (left, right) => left * right },
  '/': { prec: 2, apply: (left, right) => (right === 0 ? Number.NaN : left / right) }
}

/** 一元负号，优先级高于乘除 */
const NEGATE = 'neg'

const precedenceOf = (token: string): number => {
  if (token === NEGATE) return 3
  return OPERATORS[token]?.prec ?? 0
}

/** 拆分金额表达式；出现非法字符或数字格式错误时返回 null */
function tokenizeAmount(text: string): string[] | null {
  const tokens: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if ((char >= '0' && char <= '9') || char === '.') {
      let end = index
      let dots = 0
      while (end < text.length) {
        const current = text[end]
        if (current === '.') {
          dots += 1
          if (dots > 1) return null
        } else if (current < '0' || current > '9') {
          break
        }
        end += 1
      }
      const number = text.slice(index, end)
      if (number === '.') return null
      tokens.push(number)
      index = end
      continue
    }
    if (OPERATORS[char] || char === '(' || char === ')') {
      tokens.push(char)
      index += 1
      continue
    }
    return null
  }
  return tokens
}

/**
 * 解析金额输入，支持四则运算与括号，返回分。
 * 自行解析而不使用 eval / Function，避免被渲染层 CSP 拦截。
 */
export function parseAmountToCents(raw: string): number | null {
  const text = raw.trim().replace(/[¥€$£,，\s]/g, '')
  if (!text) return null
  const tokens = tokenizeAmount(text)
  if (!tokens || !tokens.length) return null

  const output: string[] = []
  const pending: string[] = []
  let expectValue = true

  for (const token of tokens) {
    if (OPERATORS[token] || token === '(' || token === ')') {
      if (token === '(') {
        if (!expectValue) return null
        pending.push(token)
        continue
      }
      if (token === ')') {
        if (expectValue) return null
        let matched = false
        while (pending.length) {
          const top = pending.pop() as string
          if (top === '(') {
            matched = true
            break
          }
          output.push(top)
        }
        if (!matched) return null
        continue
      }
      if (expectValue) {
        // 正号可忽略，负号作为一元运算处理
        if (token === '+') continue
        if (token !== '-') return null
        pending.push(NEGATE)
        continue
      }
      while (pending.length) {
        const top = pending[pending.length - 1]
        if (top === '(' || precedenceOf(top) < precedenceOf(token)) break
        output.push(pending.pop() as string)
      }
      pending.push(token)
      expectValue = true
      continue
    }
    if (!expectValue) return null
    output.push(token)
    expectValue = false
  }

  if (expectValue) return null
  while (pending.length) {
    const top = pending.pop() as string
    if (top === '(') return null
    output.push(top)
  }

  const stack: number[] = []
  for (const token of output) {
    if (token === NEGATE) {
      const value = stack.pop()
      if (value === undefined) return null
      stack.push(-value)
      continue
    }
    const operator = OPERATORS[token]
    if (!operator) {
      const value = Number(token)
      if (!Number.isFinite(value)) return null
      stack.push(value)
      continue
    }
    const right = stack.pop()
    const left = stack.pop()
    if (left === undefined || right === undefined) return null
    const value = operator.apply(left, right)
    if (!Number.isFinite(value)) return null
    stack.push(value)
  }
  if (stack.length !== 1) return null
  return Math.round(stack[0] * 100)
}

/** 解析汇率一类的普通小数，按原精度返回 */
export function parseRate(raw: string): number | null {
  const text = raw.trim().replace(/[,\s]/g, '')
  if (!text || !/^\d*\.?\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : null
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
