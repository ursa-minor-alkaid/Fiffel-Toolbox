import { CURRENCIES } from './calc'
import type {
  Account,
  Category,
  Currency,
  Meta,
  RatePoint,
  Settings,
  StoredTxns,
  Txn,
  TxnType
} from './types'

const SCHEMA_VERSION = 1

const ACCOUNT_TYPE_NAMES: string[] = ['cash', 'bank', 'ewallet', 'credit']

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

function defaultLargeCategories(startOrder = 0): Category[] {
  const large: Array<[string, string, Array<[string, string]>]> = [
    ['large-home', '住房', [['large-house', '购房'], ['large-renovation', '装修']]],
    ['large-vehicle', '车辆', [['large-car', '购车']]],
    ['large-study', '教育', [['large-tuition', '学费']]],
    ['large-health', '医疗', [['large-surgery', '手术']]],
    ['large-travel', '旅行', [['large-trip', '长途']]],
    ['large-other', '其他', []]
  ]
  const list: Category[] = []
  let order = startOrder
  for (const [id, name, children] of large) {
    list.push({ id, name, parentId: null, type: 'large', order: order++, archived: false })
    for (const [childId, childName] of children) {
      list.push({ id: childId, name: childName, parentId: id, type: 'large', order: order++, archived: false })
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
  const categories = defaultCategories()
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
    categories: [...categories, ...defaultLargeCategories(categories.length)],
    rates: [],
    ratesFetchedAt: null
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as string[]).includes(value)

export const isAccountType = (value: unknown): value is Account['type'] =>
  typeof value === 'string' && ACCOUNT_TYPE_NAMES.includes(value)

export const isTxnType = (value: unknown): value is TxnType =>
  value === 'expense' || value === 'income' || value === 'transfer'

const pad = (value: number): string => String(value).padStart(2, '0')

/** 校验 YYYY-MM-DD 且日期真实存在 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return false
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` === value
}

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

export function normalizeAccounts(raw: unknown): Account[] {
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

export function normalizeCategories(raw: unknown): Category[] {
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
      type: item.type === 'income' ? 'income' : item.type === 'large' ? 'large' : 'expense',
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

export function normalizeRates(raw: unknown): RatePoint[] {
  if (!Array.isArray(raw)) return []
  const list: RatePoint[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const date = typeof item.date === 'string' ? item.date : ''
    if (!isIsoDate(date)) continue
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

export function normalizeSettings(raw: unknown, accounts: Account[], categories: Category[]): Settings {
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
    liveAccounts.some((item) => item.id === raw.defaultAccountId && !item.archived)
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

export function normalizeTxns(raw: unknown): Txn[] {
  if (!Array.isArray(raw)) return []
  const list: Txn[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const accountId = typeof item.accountId === 'string' ? item.accountId : ''
    const date = typeof item.date === 'string' ? item.date : ''
    if (!id || !accountId || !isIsoDate(date)) continue
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
    if (isNumber(item.rateToCny) && item.rateToCny > 0) txn.rateToCny = item.rateToCny
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

/** 校验正式文件的整体结构，用于区分「空账本」与「结构损坏」 */
export function isStoredTxnsShape(value: unknown): value is StoredTxns | Txn[] {
  if (Array.isArray(value)) return true
  return isRecord(value) && Array.isArray(value.txns)
}

/** 校验元数据文件至少包含一个已知字段，避免把空对象当成有效数据 */
export function isMetaShape(value: unknown): boolean {
  if (!isRecord(value)) return false
  return ['schemaVersion', 'settings', 'accounts', 'categories', 'rates', 'ratesFetchedAt'].some(
    (key) => key in value
  )
}

export function normalizeStoredTxns(value: StoredTxns | Txn[]): { txns: Txn[]; dropped: number } {
  const raw = Array.isArray(value) ? value : value.txns
  const txns = normalizeTxns(raw)
  return { txns, dropped: Math.max(0, raw.length - txns.length) }
}

export function normalizeMeta(raw: unknown, fallback: Meta): Meta {
  if (!isRecord(raw)) return fallback
  const accounts = Array.isArray(raw.accounts) ? normalizeAccounts(raw.accounts) : fallback.accounts
  const categories = Array.isArray(raw.categories)
    ? normalizeCategories(raw.categories)
    : [...fallback.categories]
  // 旧账本没有大额标签，补上默认集合，保证大额录入有可选项
  if (!categories.some((item) => item.type === 'large')) {
    const startOrder = categories.reduce((max, item) => Math.max(max, item.order), -1) + 1
    categories.push(...defaultLargeCategories(startOrder))
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: normalizeSettings(raw.settings, accounts, categories),
    accounts,
    categories,
    rates: normalizeRates(raw.rates),
    ratesFetchedAt: isNumber(raw.ratesFetchedAt) ? raw.ratesFetchedAt : null
  }
}
