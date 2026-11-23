export type Currency = 'CNY' | 'EUR' | 'USD' | 'GBP'
export type TxnType = 'expense' | 'income' | 'transfer'
export type CategoryType = 'expense' | 'income' | 'large'
export type ExportScope = 'regular' | 'large'
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
  /** 已删除的账户仅保留名称供历史流水引用，不再出现在账户页与选择器 */
  deleted?: boolean
}

export interface Category {
  id: string
  name: string
  parentId: string | null
  /** 大额支出使用独立标签集合，与支出/收入互不共用 */
  type: CategoryType
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
  /** 交易时点：1 单位 currency 折合多少 CNY，用于切换本位币时换算 */
  rateToCny?: number
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
  /** 大额支出独立存储，不与常规支出混合 */
  largeTxns: Txn[]
  meta: Meta
  recovered: boolean
  /** 加载时发现并自动处理的数据问题，供界面提示 */
  warning?: string
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
  /** 所选窗口内已过去天数的日平均支出，单位：分 */
  dailyExpense: number
  perCurrency: Partial<Record<Currency, { amount: number; count: number; base: number }>>
}

export interface ExportRequest {
  format: 'csv' | 'md' | 'xlsx'
  from: string
  to: string
  label: string
  accountId?: string
  currency?: Currency | ''
  keyword?: string
  /** 当前界面作用域：大额界面只导出大额账本，其余界面只导出常规账本 */
  scope?: ExportScope
}
