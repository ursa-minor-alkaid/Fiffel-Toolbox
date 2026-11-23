import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import type { PluginContext, PluginMainModule } from '../../src/shared/types'
import { LedgerStore } from './store'
import {
  CURRENCY_META,
  categoryLabel,
  cnyRate,
  filterTxns,
  rateToBase,
  toBaseCents,
  latestRates,
  today
} from './calc'
import {
  isAccountType,
  isCurrency,
  isIsoDate,
  isNumber,
  isRecord,
  isTxnType,
  defaultMeta,
  normalizeMeta,
  normalizeTxns
} from './normalize'
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
  rateToCny?: number
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
  isReimbursable: boolean
  isCounted: boolean
  large: boolean
  id: string
}

function buildRows(
  source: Txn[],
  args: ExportArgs,
  meta: Meta,
  large = false
): ExportRow[] {
  const list = filterTxns(
    source,
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
      type: large ? '大额支出' : txnTypeLabel(txn.type),
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
      isReimbursable: txn.reimbursable,
      isCounted: !txn.excludeFromStats,
      large,
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
  let text = String(value)
  // 防止备注等内容被 Excel 当成公式执行；纯数字的负号保留原样
  if (/^[=+@\t\r]/.test(text) || (/^-/.test(text) && !/^-\d+(\.\d+)?$/.test(text))) {
    text = `'${text}`
  }
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
  const counted = rows.filter((row) => row.isCounted && !row.isReimbursable)
  const expense = counted.filter((row) => row.type === '支出').reduce((sum, row) => sum + row.baseAmount, 0)
  const income = counted.filter((row) => row.type === '收入').reduce((sum, row) => sum + row.baseAmount, 0)
  const excluded = rows.some((row) => !row.isCounted || row.isReimbursable)

  const lines = [
    markdownHeader(args),
    `支出合计 ${symbol}${expense.toFixed(2)}　收入合计 ${symbol}${income.toFixed(2)}${excluded ? '（不含待报销与不计统计记录）' : ''}`,
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

/** 大额账本单独导出，不包含任何常规流水 */
function buildLargeMarkdown(rows: ExportRow[], args: ExportArgs, meta: Meta): string {
  const symbol = CURRENCY_META[meta.settings.baseCurrency].symbol
  const total = rows.filter((row) => row.isCounted).reduce((sum, row) => sum + row.baseAmount, 0)
  const title = args.label?.trim() || `${args.from} 至 ${args.to}`
  const lines = [
    '# 大额支出导出',
    '',
    `期间：${title}`,
    '',
    `大额支出合计 ${symbol}${total.toFixed(2)}`,
    '',
    '| 日期 | 分类 | 账户 | 金额 | 折算 | 备注 |',
    '| --- | --- | --- | --- | --- | --- |'
  ]

  for (const row of rows) {
    const category = row.child ? `${row.parent} / ${row.child}` : row.parent || '未分类'
    const amount = `${CURRENCY_META[row.currency].symbol}${row.amount.toFixed(2)}`
    lines.push(
      `| ${mdCell(row.date)} | ${mdCell(category)} | ${mdCell(row.account)} | ${mdCell(amount)} | ${mdCell(`${symbol}${row.baseAmount.toFixed(2)}`)} | ${mdCell(row.note)} |`
    )
  }

  return lines.join('\n')
}

function monthOf(date: string): string {
  return date.slice(0, 7)
}

function exportCells(row: ExportRow): Array<string | number> {
  return [
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
  ]
}

function buildWorkbook(rows: ExportRow[], meta: Meta): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new()
  const symbol = CURRENCY_META[meta.settings.baseCurrency].symbol

  const detail = [CSV_HEADER, ...rows.map(exportCells)]
  const detailSheet = XLSX.utils.aoa_to_sheet(detail)
  detailSheet['!cols'] = [
    { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 11 },
    { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 9 },
    { wch: 11 }, { wch: 24 }, { wch: 14 }, { wch: 7 }, { wch: 9 }, { wch: 24 }
  ]
  XLSX.utils.book_append_sheet(workbook, detailSheet, '交易明细')

  const periodMap = new Map<string, { expense: number; income: number; count: number }>()
  for (const row of rows) {
    if (row.type === '转账' || !row.isCounted || row.isReimbursable) continue
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
    if (row.type !== '支出' || !row.isCounted || row.isReimbursable) continue
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

/** 大额账本单独成册，只包含大额明细与大额汇总 */
function buildLargeWorkbook(rows: ExportRow[], meta: Meta): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new()
  const symbol = CURRENCY_META[meta.settings.baseCurrency].symbol

  const detailSheet = XLSX.utils.aoa_to_sheet([CSV_HEADER, ...rows.map(exportCells)])
  detailSheet['!cols'] = [
    { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 11 },
    { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 9 },
    { wch: 11 }, { wch: 24 }, { wch: 14 }, { wch: 7 }, { wch: 9 }, { wch: 24 }
  ]
  XLSX.utils.book_append_sheet(workbook, detailSheet, '大额支出')

  const monthly = new Map<string, { amount: number; count: number }>()
  const categoryMap = new Map<string, { parent: string; child: string; amount: number }>()
  let total = 0
  let count = 0
  for (const row of rows) {
    if (!row.isCounted) continue
    const month = monthOf(row.date)
    const monthBucket = monthly.get(month) ?? { amount: 0, count: 0 }
    monthBucket.amount += row.baseAmount
    monthBucket.count += 1
    monthly.set(month, monthBucket)

    const key = `${row.parent}|${row.child}`
    const categoryBucket =
      categoryMap.get(key) ?? { parent: row.parent || '未分类', child: row.child, amount: 0 }
    categoryBucket.amount += row.baseAmount
    categoryMap.set(key, categoryBucket)
    total += row.baseAmount
    count += 1
  }

  const summary: Array<Array<string | number>> = [['月份', `大额支出（${symbol}）`, '笔数']]
  for (const [month, bucket] of [...monthly.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    summary.push([month, Number(bucket.amount.toFixed(2)), bucket.count])
  }
  summary.push(['合计', Number(total.toFixed(2)), count])
  summary.push([], ['一级分类', '二级分类', `大额支出（${symbol}）`, '占比'])
  for (const [, bucket] of [...categoryMap.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
    const ratio = total ? bucket.amount / total : 0
    summary.push([
      bucket.parent,
      bucket.child,
      Number(bucket.amount.toFixed(2)),
      `${(ratio * 100).toFixed(1)}%`
    ])
  }
  const summarySheet = XLSX.utils.aoa_to_sheet(summary)
  summarySheet['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(workbook, summarySheet, '大额汇总')

  return workbook
}

interface ImportPreview {
  path: string
  exportedAt: string
  txnCount: number
  largeTxnCount: number
  accountCount: number
  categoryCount: number
}

interface ImportResult {
  txnCount: number
  safetyPath: string
}

interface BackupData {
  txns: Txn[]
  largeTxns: Txn[]
  meta: Meta
  exportedAt: string
}

/** 解析整库备份，字段缺失或类型异常时只保留可用数据 */
function parseBackup(raw: unknown): BackupData {
  if (!isRecord(raw)) throw new Error('文件内容不是 JSON 对象')
  if (!Array.isArray(raw.txns) || !isRecord(raw.meta)) {
    throw new Error('缺少 txns 或 meta 字段，请选择「导出整库 JSON」生成的文件')
  }
  const meta = normalizeMeta(raw.meta, defaultMeta())
  return {
    txns: normalizeTxns(raw.txns),
    // 旧版备份没有大额流水，按空集合导入
    largeTxns: Array.isArray(raw.largeTxns) ? normalizeTxns(raw.largeTxns) : [],
    meta,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : ''
  }
}

async function readBackup(source: string): Promise<BackupData> {
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
async function writeBeforeImportBackup(
  ctx: PluginContext,
  txns: Txn[],
  largeTxns: Txn[],
  meta: Meta
): Promise<string> {
  const dir = path.join(ctx.userDataPath, 'data')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `ledger.before-import.${stamp}.json`)
  await fs.writeFile(
    target,
    JSON.stringify({ exportedAt: new Date().toISOString(), txns, largeTxns, meta }, null, 2),
    'utf-8'
  )
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

const SETTING_KEYS = [
  'baseCurrency',
  'defaultAccountId',
  'lastCategoryId',
  'lastCurrency',
  'rateUpdatedAt'
]

/** 设置项白名单与取值校验，避免任意字段直接写入元数据 */
function validateSettingsPatch(meta: Meta, patch: Partial<Meta['settings']>): void {
  for (const key of Object.keys(patch)) {
    if (!SETTING_KEYS.includes(key)) throw new Error(`不支持的设置项：${key}`)
  }
  if (patch.baseCurrency !== undefined && !isCurrency(patch.baseCurrency)) {
    throw new Error('本位币不正确')
  }
  if (patch.lastCurrency !== undefined && !isCurrency(patch.lastCurrency)) {
    throw new Error('币种不正确')
  }
  if (
    patch.rateUpdatedAt !== undefined &&
    patch.rateUpdatedAt !== null &&
    !isNumber(patch.rateUpdatedAt)
  ) {
    throw new Error('汇率更新时间不正确')
  }
  if (patch.defaultAccountId) {
    const account = meta.accounts.find((item) => item.id === patch.defaultAccountId)
    if (!account || account.deleted || account.archived) throw new Error('默认账户不可用')
  }
  if (patch.lastCategoryId && !meta.categories.some((item) => item.id === patch.lastCategoryId)) {
    throw new Error('分类不存在')
  }
}

/** 同名文件已存在时追加序号，避免静默覆盖上一次导出 */
async function uniqueXlsxTarget(directory: string, base: string): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const name = index === 0 ? `ledger-${base}.xlsx` : `ledger-${base}-${index}.xlsx`
    const target = path.join(directory, name)
    try {
      await fs.access(target)
    } catch {
      return target
    }
  }
  return path.join(directory, `ledger-${base}-${Date.now()}.xlsx`)
}

/** 同一套金额、账户、分类与汇率规则，常规流水与大额支出共用 */
function buildTxnRecord(
  draft: TxnDraft,
  existing: Txn | undefined,
  meta: Meta,
  large = false
): Txn {
  if (!draft.accountId) throw new Error('请选择账户')
  if (!Number.isInteger(draft.amount) || draft.amount <= 0) throw new Error('金额需要大于 0')
  const account = meta.accounts.find((item) => item.id === draft.accountId)
  if (!account) throw new Error('账户不存在，请重新选择')
  if (!draft.id && account.deleted) throw new Error('账户已删除，请重新选择')
  if (draft.type !== 'transfer') {
    if (!draft.categoryId) throw new Error('请选择分类')
    const category = meta.categories.find((item) => item.id === draft.categoryId)
    if (!category) throw new Error('分类不存在，请重新选择')
    // 大额、支出、收入各自使用独立标签，不允许交叉引用
    const expected = large ? 'large' : draft.type === 'income' ? 'income' : 'expense'
    if (category.type !== expected) {
      throw new Error(large ? '请选择大额标签' : '分类与记录类型不一致，请重新选择')
    }
  }

  const baseCurrency = meta.settings.baseCurrency
  let rateToCny: number
  let rate: number
  if (draft.currency === baseCurrency) {
    // 本位币记录不依赖汇率，缺少汇率时也能正常入账
    rate = 1
    rateToCny =
      existing?.rateToCny && existing.rateToCny > 0
        ? existing.rateToCny
        : cnyRate(meta, draft.currency)
  } else {
    const baseRate = cnyRate(meta, baseCurrency)
    if (!baseRate) throw new Error(`缺少 ${baseCurrency} 汇率，请先在设置页获取或手填`)
    if (existing && existing.currency === draft.currency) {
      // 编辑保留原快照汇率，不随本位币汇率变动重算
      rate = existing.rateToBase
      rateToCny =
        existing.rateToCny && existing.rateToCny > 0
          ? existing.rateToCny
          : existing.rateToBase > 0
            ? existing.rateToBase * baseRate
            : cnyRate(meta, draft.currency)
    } else {
      if (draft.rateToCny && draft.rateToCny > 0) {
        rateToCny = draft.rateToCny
      } else if (draft.rateToBase && draft.rateToBase > 0) {
        rateToCny = draft.rateToBase * baseRate
      } else {
        rateToCny = cnyRate(meta, draft.currency)
      }
      if (!rateToCny) throw new Error(`缺少 ${draft.currency} 汇率，请先在设置页获取或手填`)
      rate = rateToCny / baseRate
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`缺少 ${draft.currency} 汇率，请先在设置页获取或手填`)
    }
  }

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
  if (rateToCny > 0) record.rateToCny = rateToCny

  if (draft.type === 'transfer') {
    if (!draft.toAccountId) throw new Error('请选择转入账户')
    if (draft.toAccountId === draft.accountId) throw new Error('转入账户不能与转出账户相同')
    const toAccount = meta.accounts.find((item) => item.id === draft.toAccountId)
    if (!toAccount) throw new Error('转入账户不存在，请重新选择')
    if (!draft.id && toAccount.deleted) throw new Error('转入账户已删除，请重新选择')
    const toCurrency = draft.toCurrency ?? draft.currency
    if (!isCurrency(toCurrency)) throw new Error('转入币种不正确')
    if (toCurrency === draft.currency) {
      // 同币种转账保持资金守恒，忽略手改的到账金额
      record.toAmount = record.amount
    } else {
      if (!draft.toAmount || draft.toAmount <= 0) {
        throw new Error('跨币种转账需要填写到账金额')
      }
      record.toAmount = round(draft.toAmount)
    }
    record.toAccountId = draft.toAccountId
    record.toCurrency = toCurrency
    record.fxRate = record.toAmount / record.amount
  }

  return record
}

const handlers: PluginMainModule['handlers'] = {
  async load(_args, ctx): Promise<LedgerData> {
    return db(ctx).load()
  },

  async saveTxn(args, ctx) {
    const draft = args as TxnDraft
    if (!isTxnType(draft.type)) throw new Error('交易类型不正确')
    if (!isCurrency(draft.currency)) throw new Error('币种不正确')
    if (!isIsoDate(draft.date)) throw new Error('日期格式不正确')
    const ledger = db(ctx)
    const txn = await ledger.mutateTxns((txns, state) => {
      const existing = txns.find((item) => item.id === (draft.id ?? ''))
      const record = buildTxnRecord(draft, existing, state.meta)
      const index = txns.findIndex((item) => item.id === record.id)
      if (index >= 0) txns.splice(index, 1, record)
      else txns.push(record)
      return record
    })

    // 只有新建记录才更新「上次使用值」，编辑或撤销不改变默认值
    if (!draft.id) {
      try {
        await ledger.mutateMeta((meta) => {
          meta.settings.lastCurrency = draft.currency
          if (draft.categoryId) meta.settings.lastCategoryId = draft.categoryId
        })
      } catch {
        /* 忽略「上次使用值」的落盘失败 */
      }
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

  /** 大额支出写入独立文件，账户扣减规则与常规支出一致 */
  async saveLargeTxn(args, ctx) {
    const draft = args as TxnDraft
    if (draft.type !== 'expense') throw new Error('大额记录只支持支出')
    if (!isCurrency(draft.currency)) throw new Error('币种不正确')
    if (!isIsoDate(draft.date)) throw new Error('日期格式不正确')
    return db(ctx).mutateLargeTxns((largeTxns, state) => {
      const existing = largeTxns.find((item) => item.id === (draft.id ?? ''))
      const record = buildTxnRecord(draft, existing, state.meta, true)
      const index = largeTxns.findIndex((item) => item.id === record.id)
      if (index >= 0) largeTxns.splice(index, 1, record)
      else largeTxns.push(record)
      return record
    })
  },

  async deleteLargeTxn(args, ctx) {
    const { id } = args as { id: string }
    return db(ctx).mutateLargeTxns((largeTxns) => {
      const index = largeTxns.findIndex((item) => item.id === id)
      if (index >= 0) largeTxns.splice(index, 1)
    })
  },

  async saveAccount(args, ctx): Promise<Account> {
    const draft = args as AccountDraft
    const name = draft.name?.trim()
    if (!name) throw new Error('请填写账户名称')
    if (!isAccountType(draft.type)) throw new Error('账户类型不正确')
    if (draft.initial) {
      for (const [currency, value] of Object.entries(draft.initial)) {
        if (!isCurrency(currency)) throw new Error('期初余额币种不正确')
        if (!isNumber(value) || !Number.isInteger(value)) {
          throw new Error(`期初余额格式不正确：${currency}`)
        }
      }
    }
    return db(ctx).mutateMeta((meta) => {
      const existing = draft.id ? meta.accounts.find((item) => item.id === draft.id) : undefined
      const nameChanged = !existing || existing.name !== name
      const duplicate =
        nameChanged &&
        meta.accounts.some((item) => item.id !== existing?.id && !item.deleted && item.name === name)
      if (duplicate) throw new Error('同名账户已存在')
      if (existing) {
        existing.name = name
        existing.type = draft.type
        existing.initial = draft.initial ?? {}
        if (typeof draft.archived === 'boolean') existing.archived = draft.archived
        if (existing.archived && meta.settings.defaultAccountId === existing.id) {
          const fallback = meta.accounts.find(
            (item) => item.id !== existing.id && !item.deleted && !item.archived
          )
          meta.settings.defaultAccountId = fallback?.id ?? ''
        }
        return existing
      }
      const account: Account = {
        id: draft.id ?? newId('acc'),
        name,
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
        const fallback =
          meta.accounts.find((item) => item.id !== id && !item.deleted && !item.archived) ??
          meta.accounts.find((item) => item.id !== id && !item.deleted)
        meta.settings.defaultAccountId = fallback?.id ?? ''
      }
    })
    return { ok: true }
  },

  async saveCategory(args, ctx) {
    const draft = args as CategoryDraft
    const name = (draft.name ?? '').trim()
    if (!name) throw new Error('请填写标签名称')
    if (draft.type !== 'expense' && draft.type !== 'income' && draft.type !== 'large') {
      throw new Error('分类类型不正确')
    }
    return db(ctx).mutateMeta((meta) => {
      const existing = draft.id ? meta.categories.find((item) => item.id === draft.id) : undefined
      const parent = draft.parentId
        ? meta.categories.find((item) => item.id === draft.parentId)
        : null
      if (draft.parentId && !parent) throw new Error('上级分类不存在')
      if (parent && parent.type !== draft.type) throw new Error('分类类型不一致')
      if (parent && parent.parentId) throw new Error('不支持三级分类')
      const duplicate = meta.categories.some(
        (item) =>
          item.id !== existing?.id &&
          item.name === name &&
          item.parentId === draft.parentId &&
          item.type === draft.type
      )
      if (duplicate) throw new Error('同名标签已存在')
      if (existing) {
        existing.name = name
        existing.parentId = draft.parentId
        existing.type = draft.type
        return existing
      }
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
    const snapshot = await ledger.snapshotState()
    const target = snapshot.meta.categories.find((item) => item.id === id)
    if (!target) return { ok: false, reason: '标签不存在' }

    const children = snapshot.meta.categories.filter((item) => item.parentId === id)
    if (children.length && !cascade) {
      return { ok: false, reason: '该标签下还有同级标签，请先删除其标签', childCount: children.length }
    }
    // 一级分类至少要保留一个，否则录入时没有可选分类
    if (!target.parentId) {
      const siblings = snapshot.meta.categories.filter(
        (item) => item.type === target.type && !item.parentId && item.id !== id
      )
      if (!siblings.length) return { ok: false, reason: '该类型至少需要保留一个一级分类' }
    }

    // 流水迁移与分类删除放在同一次写盘事务里，避免出现只完成一半的状态
    return ledger.mutateState((state) => {
      const current = state.meta.categories.find((item) => item.id === id)
      if (!current) return { ok: false, reason: '标签不存在' }
      const currentChildren = state.meta.categories.filter((item) => item.parentId === id)
      if (currentChildren.length && !cascade) {
        return { ok: false, reason: '该标签下还有同级标签，请先删除其标签', childCount: currentChildren.length }
      }

      const removed = new Set<string>([id, ...currentChildren.map((item) => item.id)])
      const parentFallback = state.meta.categories.find(
        (item) =>
          item.type === current.type && !item.parentId && item.name === '其他' && !removed.has(item.id)
      )
      const fallback =
        parentFallback ??
        state.meta.categories.find(
          (item) => item.type === current.type && !item.parentId && !removed.has(item.id)
        )
      const fallbackId = fallback?.id ?? null
      // 删除二级标签时停留在原一级分类；删除一级分类时落到迁移目标，避免界面停留在已删除项
      const stayId = current.parentId ?? fallbackId ?? ''

      let moved = 0
      const migrate = (list: Txn[]): void => {
        for (const txn of list) {
          if (txn.categoryId && removed.has(txn.categoryId)) {
            txn.categoryId = fallbackId
            moved += 1
          }
        }
      }
      // 大额与常规标签各自独立，只迁移引用被删分类的那一侧流水
      if (current.type === 'large') migrate(state.largeTxns)
      else migrate(state.txns)
      state.meta.categories = state.meta.categories.filter((item) => !removed.has(item.id))
      if (state.meta.settings.lastCategoryId && removed.has(state.meta.settings.lastCategoryId)) {
        state.meta.settings.lastCategoryId = stayId
      }
      return { ok: true, moved, fallbackId, stayId }
    })
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
    const rawPatch = args as Partial<Meta['settings']>
    const patch = Object.fromEntries(
      Object.entries(rawPatch).filter(([, value]) => value !== undefined)
    ) as Partial<Meta['settings']>
    const ledger = db(ctx)
    if (patch.baseCurrency === undefined) {
      return ledger.mutateMeta((meta) => {
        validateSettingsPatch(meta, patch)
        meta.settings = { ...meta.settings, ...patch }
        return meta.settings
      })
    }
    // 切换本位币时把历史快照换算到新本位币，保证汇总与导出口径一致
    return ledger.mutateState((state) => {
      validateSettingsPatch(state.meta, patch)
      const nextBase = patch.baseCurrency as Currency
      const oldBase = state.meta.settings.baseCurrency
      if (nextBase !== oldBase) {
        const newBaseRate = cnyRate(state.meta, nextBase)
        if (!newBaseRate && (state.txns.length || state.largeTxns.length)) {
          throw new Error(`缺少 ${nextBase} 汇率，无法切换本位币`)
        }
        const oldBaseRate = cnyRate(state.meta, oldBase)
        // 先算完所有汇率再写回，避免中途失败留下换算到一半的内存状态
        const all = [...state.txns, ...state.largeTxns]
        const rates = all.map((txn) => {
          const rateToCny =
            txn.rateToCny && txn.rateToCny > 0
              ? txn.rateToCny
              : oldBaseRate > 0
                ? txn.rateToBase * oldBaseRate
                : 0
          if (!rateToCny) throw new Error(`缺少 ${oldBase} 的历史汇率，无法换算现有记录`)
          return rateToCny
        })
        all.forEach((txn, index) => {
          const rateToCny = rates[index]
          txn.rateToCny = rateToCny
          txn.rateToBase = rateToCny / newBaseRate
          txn.baseAmount = round(txn.amount * txn.rateToBase)
        })
        state.meta.settings.baseCurrency = nextBase
      }
      const rest = { ...patch }
      delete rest.baseCurrency
      state.meta.settings = { ...state.meta.settings, ...rest }
      return state.meta.settings
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
    if (!isCurrency(currency)) throw new Error('币种不正确')
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
    const scope = request.scope === 'large' ? 'large' : 'regular'
    const ledger = db(ctx)
    const { txns, largeTxns, meta } = await ledger.snapshotState()
    // 两个界面各自导出自己的账本，不交叉包含
    const rows =
      scope === 'large'
        ? buildRows(largeTxns, request, meta, true)
        : buildRows(txns, request, meta)
    const count = rows.length
    const base = request.fileBase || request.from
    const fileBase = scope === 'large' ? `large-${base}` : base

    if (request.format === 'csv') {
      const content = buildCsv(rows)
      const saved = await ctx.saveFile(`ledger-${fileBase}.csv`, content, [
        { name: 'CSV', extensions: ['csv'] }
      ])
      return { path: saved, count, scope }
    }

    if (request.format === 'md') {
      const content =
        scope === 'large'
          ? buildLargeMarkdown(rows, request, meta)
          : buildMarkdown(rows, request, meta)
      const saved = await ctx.saveFile(`ledger-${fileBase}.md`, content, [
        { name: 'Markdown', extensions: ['md'] }
      ])
      return { path: saved, count, scope }
    }

    const workbook = scope === 'large' ? buildLargeWorkbook(rows, meta) : buildWorkbook(rows, meta)
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer
    const directory = await ctx.pickDirectory()
    if (!directory) return { path: null, count, scope }
    const target = await uniqueXlsxTarget(directory, fileBase)
    await fs.writeFile(target, buffer)
    await ctx.openPath(directory)
    return { path: target, count, scope }
  },

  async openDataFolder(_args, ctx) {
    const dir = path.join(ctx.userDataPath, 'data')
    await fs.mkdir(dir, { recursive: true })
    await ctx.openPath(dir)
    return { path: dir }
  },

  async backup(_args, ctx) {
    const { txns, largeTxns, meta } = await db(ctx).snapshotState()
    const payload = JSON.stringify(
      { exportedAt: new Date().toISOString(), txns, largeTxns, meta },
      null,
      2
    )
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
      largeTxnCount: backup.largeTxns.length,
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
    const safetyPath = await writeBeforeImportBackup(
      ctx,
      current.txns,
      current.largeTxns,
      current.meta
    )
    await ledger.replaceAll(backup.txns, backup.largeTxns, backup.meta)
    return { txnCount: backup.txns.length + backup.largeTxns.length, safetyPath }
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
