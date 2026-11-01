export type Currency = 'CNY' | 'EUR' | 'USD'
export type TxnType = 'expense' | 'income' | 'transfer'
export type AccountType = 'cash' | 'bank' | 'ewallet' | 'credit'
export type PeriodKind = 'month' | 'week' | 'custom'

export interface Settings {
  baseCurrency: Currency
  defaultAccountId: string
  lastCategoryId: string
  lastCurrency: Currency
  rateUpdatedAt: number | null
}

export interface Account {
  id: string
  name: string
  type: AccountType
  /** 各币种期初余额，单位：分 */
  initial: Partial<Record<Currency, number>>
  archived: boolean
  order: number
}

export interface Category {
  id: string
  name: string
  parentId: string | null
  type: 'expense' | 'income'
  order: number
  archived: boolean
}

export interface Txn {
  id: string
  type: TxnType
  date: string
  createdAt: number
  /** 原币金额，单位：分 */
  amount: number
  currency: Currency
  accountId: string
  categoryId: string | null
  note: string
  tags: string[]
  toAccountId?: string
  toCurrency?: Currency
  /** 目标账户入账金额，单位：分 */
  toAmount?: number
  fxRate?: number
  /** 交易时点：1 单位 currency 折合多少本位币 */
  rateToBase: number
  /** amount * rateToBase，单位：分 */
  baseAmount: number
  reimbursable: boolean
  excludeFromStats: boolean
}

export interface RatePoint {
  date: string
  /** 1 单位该币种折合多少 CNY */
  map: Partial<Record<Currency, number>>
}

export interface Meta {
  schemaVersion: 1
  settings: Settings
  accounts: Account[]
  categories: Category[]
  rates: RatePoint[]
  ratesFetchedAt: number | null
}

export interface StoredTxns {
  schemaVersion: 1
  txns: Txn[]
}

export interface LedgerData {
  txns: Txn[]
  meta: Meta
  recovered: boolean
  ratesError?: string
}

export interface Range {
  from: string
  to: string
  label: string
}

export interface TxnFilter {
  from: string
  to: string
  accountId?: string
  currency?: Currency | ''
  keyword?: string
}

export interface Summary {
  expense: number
  income: number
  net: number
  reimbursable: number
  perCurrency: Partial<Record<Currency, { amount: number; count: number }>>
}

export interface ExportRequest {
  format: 'csv' | 'md' | 'xlsx'
  from: string
  to: string
  label: string
  accountId?: string
  currency?: Currency | ''
  keyword?: string
}
