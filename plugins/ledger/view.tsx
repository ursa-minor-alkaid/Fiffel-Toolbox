import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { usePlugin } from '../../src/renderer/src/utils'
import {
  ACCOUNT_TYPES,
  CURRENCIES,
  CURRENCY_META,
  accountBalance,
  accountDelta,
  accountTotal,
  categoryLabel,
  fileTag,
  filterTxns,
  formatMoney,
  isoDate,
  latestRates,
  monthRange,
  parseAmountToCents,
  parseRate,
  periodPrefix,
  rangeFor,
  rateToBase,
  summarize,
  today
} from './calc'
import type {
  Account,
  Category,
  Currency,
  LedgerData,
  PeriodKind,
  Txn,
  TxnFilter,
  TxnType
} from './types'
import './ledger.css'

type Page = 'ledger' | 'accounts' | 'settings'

interface AccountDraft {
  id?: string
  name: string
  type: Account['type']
  /** 期初余额保留输入原文，保存时再换算成分 */
  initial: Partial<Record<Currency, string>>
}

const emptyDraft = (): AccountDraft => ({ name: '', type: 'cash', initial: {} })

const accountDraftOf = (account: Account): AccountDraft => {
  const initial: Partial<Record<Currency, string>> = {}
  for (const item of CURRENCIES) {
    const cents = account.initial[item]
    if (cents) initial[item] = (cents / 100).toFixed(2)
  }
  return { id: account.id, name: account.name, type: account.type, initial }
}

const messageOf = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

interface ImportPreview {
  path: string
  exportedAt: string
  txnCount: number
  accountCount: number
  categoryCount: number
}

const importTimeLabel = (value: string): string => {
  if (!value) return '未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export default function LedgerView(): JSX.Element {
  const { invoke } = usePlugin('ledger')
  const amountRef = useRef<HTMLInputElement | null>(null)
  const statusTimer = useRef<number | undefined>(undefined)
  const undoRef = useRef<{ txn: Txn; index: number } | null>(null)

  const [data, setData] = useState<LedgerData | null>(null)
  const [page, setPage] = useState<Page>('ledger')
  const [period, setPeriod] = useState<PeriodKind>('month')
  const [from, setFrom] = useState(monthRange().from)
  const [to, setTo] = useState(today())
  const [filterAccount, setFilterAccount] = useState('')
  const [filterCurrency, setFilterCurrency] = useState<Currency | ''>('')
  const [keyword, setKeyword] = useState('')
  const [expandCur, setExpandCur] = useState(false)
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [rateWarning, setRateWarning] = useState('')

  const [type, setType] = useState<TxnType>('expense')
  const [currency, setCurrency] = useState<Currency>('CNY')
  const [accountId, setAccountId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [date, setDate] = useState(today())
  const [amountText, setAmountText] = useState('')
  const [note, setNote] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [toCurrency, setToCurrency] = useState<Currency>('CNY')
  const [toAmountText, setToAmountText] = useState('')
  const [toTouched, setToTouched] = useState(false)
  const [toCurrencyTouched, setToCurrencyTouched] = useState(false)
  const [newSubName, setNewSubName] = useState('')

  const parentRowRef = useRef<HTMLDivElement | null>(null)
  const categoryDragRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    startScroll: number
    moved: boolean
    node: HTMLElement
  } | null>(null)
  const categorySlots = useRef<
    Array<{ id: string; left: number; top: number; width: number; height: number }>
  >([])
  const categoryOrder = useRef<string[]>([])
  const suppressCategoryClick = useRef(false)
  const chipFlipRects = useRef<Map<string, { left: number; top: number }> | null>(null)
  const renameBusy = useRef(false)
  const renameSettled = useRef(false)
  const [dragCategoryId, setDragCategoryId] = useState('')
  const [dropBar, setDropBar] = useState<{ left: number; top: number; height: number } | null>(null)
  const [newParentName, setNewParentName] = useState('')
  const [editingCategory, setEditingCategory] = useState<{ id: string; name: string } | null>(null)
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null)

  const [editingTxn, setEditingTxn] = useState<{ id: string; field: 'amount' | 'category' } | null>(null)
  const [editText, setEditText] = useState('')
  const editSettled = useRef(false)
  const [undoState, setUndoState] = useState<{ txn: Txn; index: number } | null>(null)
  undoRef.current = undoState

  const [accountDraft, setAccountDraft] = useState<AccountDraft | null>(null)
  const [deletingAccount, setDeletingAccount] = useState<Account | null>(null)
  const [flowsAccount, setFlowsAccount] = useState<Account | null>(null)
  const [dragAccountId, setDragAccountId] = useState('')
  const accountGridRef = useRef<HTMLDivElement | null>(null)
  const accountDragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null)
  const accountOrderRef = useRef<string[]>([])
  const suppressAccountClick = useRef(false)
  const flipRects = useRef<Map<string, DOMRect> | null>(null)
  const [rateEUR, setRateEUR] = useState('')
  const [rateUSD, setRateUSD] = useState('')
  const [rateGBP, setRateGBP] = useState('')
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importBusy, setImportBusy] = useState(false)

  const flash = (text: string, isError = false): void => {
    setStatus(text)
    setStatusError(isError)
    window.clearTimeout(statusTimer.current)
    statusTimer.current = window.setTimeout(() => setStatus(''), isError ? 6000 : 2500)
  }

  const apply = (next: LedgerData): void => setData(next)

  useEffect(() => {
    let alive = true
    void invoke<LedgerData>('load').then((loaded) => {
      if (!alive) return
      apply(loaded)
      const settings = loaded.meta.settings
      const active = loaded.meta.accounts.filter((item) => !item.archived && !item.deleted)
      setAccountId(settings.defaultAccountId || active[0]?.id || '')
      setCurrency(settings.lastCurrency)
      setCategoryId(settings.lastCategoryId)
      setToCurrency(settings.lastCurrency)
      if (loaded.recovered) {
        flash('已从备份恢复，请核对最近一笔改动', true)
      }
      const latest = latestRates(loaded.meta)
      const complete = CURRENCIES.every((item) => item === 'CNY' || Boolean(latest?.map[item]))
      const fetchedToday =
        typeof loaded.meta.ratesFetchedAt === 'number' &&
        isoDate(new Date(loaded.meta.ratesFetchedAt)) === today()
      // 同一天只拉取一次，缺失币种时也要补拉
      if (!fetchedToday || !latest || !complete) {
        void invoke<{ ok: boolean; error?: string }>('refreshRates').then((result) => {
          if (!result.ok) setRateWarning(result.error ?? '汇率获取失败，可在设置页手填')
          else setRateWarning('')
          void invoke<LedgerData>('load').then(apply)
        })
      }
    })
    return () => {
      alive = false
      window.clearTimeout(statusTimer.current)
    }
  }, [invoke])

  const meta = data?.meta
  const txns = data?.txns ?? []

  const accounts = useMemo(
    () => (meta ? meta.accounts.filter((item) => !item.deleted).sort((a, b) => a.order - b.order) : []),
    [meta]
  )
  const activeAccounts = useMemo(() => accounts.filter((item) => !item.archived), [accounts])
  const range = useMemo(() => rangeFor(period, from, to), [period, from, to])

  const filter: TxnFilter = useMemo(
    () => ({
      from: range.from,
      to: range.to,
      accountId: filterAccount || undefined,
      currency: filterCurrency || undefined,
      keyword
    }),
    [range, filterAccount, filterCurrency, keyword]
  )

  const visible = useMemo(
    () => (meta ? filterTxns(txns, filter, meta.categories) : []),
    [txns, filter, meta]
  )

  const summary = useMemo(
    () => (meta ? summarize(txns, filter, meta, meta.categories) : null),
    [txns, filter, meta]
  )

  const grouped = useMemo(() => {
    const groups = new Map<string, Txn[]>()
    for (const txn of visible) {
      const bucket = groups.get(txn.date) ?? []
      bucket.push(txn)
      groups.set(txn.date, bucket)
    }
    return [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, items]) => ({
        day,
        items: items.sort((a, b) => b.createdAt - a.createdAt)
      }))
  }, [visible])

  /** 查看流水弹窗使用完整流水，按日期与创建时间倒序 */
  const flowsAccountTxns = useMemo(() => {
    if (!flowsAccount) return []
    return txns
      .filter((txn) => txn.accountId === flowsAccount.id || txn.toAccountId === flowsAccount.id)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt))
  }, [txns, flowsAccount])

  const typeCategories = useMemo(() => {
    if (!meta) return []
    const kind = type === 'income' ? 'income' : 'expense'
    return meta.categories.filter((item) => item.type === kind && !item.archived)
  }, [meta, type])

  const parentCategories = useMemo(
    () => typeCategories.filter((item) => !item.parentId),
    [typeCategories]
  )

  const selectedParent = useMemo(() => {
    const info = meta ? categoryLabel(meta.categories, categoryId) : null
    if (!info) return parentCategories[0]?.id ?? ''
    const cat = meta?.categories.find((item) => item.id === categoryId)
    return cat?.parentId ?? cat?.id ?? ''
  }, [meta, categoryId, parentCategories])

  const baseCurrency = meta?.settings.baseCurrency ?? 'CNY'

  const amountCents = parseAmountToCents(amountText)
  const amountInvalid = Boolean(amountText.trim()) && (amountCents === null || amountCents <= 0)
  const conversion = useMemo(() => {
    if (!meta || !amountCents || amountCents <= 0) return ''
    const rate = rateToBase(meta, currency)
    if (!rate) return '汇率未设置'
    const baseCents = Math.round(amountCents * rate)
    if (currency === baseCurrency) {
      const others = CURRENCIES.filter((item) => item !== baseCurrency)
        .map((item) => {
          const otherRate = rateToBase(meta, item)
          return otherRate ? `${CURRENCY_META[item].symbol}${(baseCents / otherRate / 100).toFixed(2)}` : ''
        })
        .filter(Boolean)
      if (!others.length) return ''
      return `${formatMoney(baseCents, baseCurrency)} ≈ ${others.join('　·　')}`
    }
    return `${formatMoney(amountCents, currency)} ≈ ${formatMoney(baseCents, baseCurrency)}　·　1 ${currency} = ${rate.toFixed(4)} ${baseCurrency}`
  }, [meta, amountCents, currency, baseCurrency])

  useEffect(() => {
    if (type !== 'transfer' || !meta || toTouched) return
    const cents = parseAmountToCents(amountText)
    if (!cents || cents <= 0) {
      setToAmountText('')
      return
    }
    const source = rateToBase(meta, currency)
    const target = rateToBase(meta, toCurrency)
    if (!source || !target) {
      setToAmountText('')
      return
    }
    setToAmountText((cents * source / target / 100).toFixed(2))
  }, [type, amountText, currency, toCurrency, toTouched, meta])

  useEffect(() => {
    if (!activeAccounts.length) return
    if (activeAccounts.some((item) => item.id === accountId)) return
    setAccountId(activeAccounts[0].id)
  }, [activeAccounts, accountId])

  useEffect(() => {
    // 设计约定：/ 聚焦金额框，输入框内不拦截
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (page !== 'ledger') return
      event.preventDefault()
      amountRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [page])

  useEffect(() => {
    if (toAccountId && toAccountId !== accountId) return
    const alternative = activeAccounts.find((item) => item.id !== accountId)
    if (alternative) setToAccountId(alternative.id)
  }, [activeAccounts, accountId, toAccountId])

  useEffect(() => {
    // 账户被删除后筛选值失效，回到全部账户，避免列表凭空为空
    if (!filterAccount) return
    if (accounts.some((item) => item.id === filterAccount)) return
    setFilterAccount('')
  }, [accounts, filterAccount])

  useEffect(() => {
    if (!meta) return
    const point = latestRates(meta)
    if (!point) return
    setRateEUR(point.map.EUR ? point.map.EUR.toFixed(4) : '')
    setRateUSD(point.map.USD ? point.map.USD.toFixed(4) : '')
    setRateGBP(point.map.GBP ? point.map.GBP.toFixed(4) : '')
  }, [meta?.rates])

  useEffect(() => {
    if (!meta || type === 'transfer') return
    const kind = type === 'income' ? 'income' : 'expense'
    const current = meta.categories.find((item) => item.id === categoryId)
    if (current && current.type === kind) return
    const parent = meta.categories.find((item) => item.type === kind && !item.parentId && !item.archived)
    const child = meta.categories.find((item) => item.parentId === parent?.id)
    setCategoryId(child?.id ?? parent?.id ?? '')
  }, [meta, type, categoryId])

  const switchType = (next: TxnType): void => {
    setType(next)
    if (next === 'transfer') return
    const kind = next === 'income' ? 'income' : 'expense'
    const current = meta?.categories.find((item) => item.id === categoryId)
    if (!current || current.type !== kind) {
      const first = meta?.categories.find((item) => item.type === kind && !item.parentId && !item.archived)
      const child = meta?.categories.find((item) => item.parentId === first?.id)
      setCategoryId(child?.id ?? first?.id ?? '')
    }
  }

  /** 在当前一级分类下新增二级标签，回车即保存 */
  const addSubCategory = async (): Promise<void> => {
    if (!meta || type === 'transfer') return
    const name = newSubName.trim()
    if (!name) return
    if (!selectedParent) {
      flash('请先选择一级分类', true)
      return
    }
    const kind = type === 'income' ? 'income' : 'expense'
    const duplicate = meta.categories.some(
      (item) => item.parentId === selectedParent && item.type === kind && item.name === name
    )
    if (duplicate) {
      flash(`「${name}」已存在`, true)
      return
    }
    try {
      const saved = await invoke<Category>('saveCategory', { name, parentId: selectedParent, type: kind })
      setData((prev) =>
        prev
          ? { ...prev, meta: { ...prev.meta, categories: [...prev.meta.categories, saved] } }
          : prev
      )
      setNewSubName('')
      setCategoryId(saved.id)
      flash(`已新增标签「${saved.name}」`)
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  /** 删除二级标签，引用记录迁移到同类型的「其他」 */
  const removeSubCategory = async (category: Category): Promise<void> => {
    try {
      const result = await invoke<{
        ok: boolean
        reason?: string
        moved?: number
        fallbackId?: string | null
        stayId?: string
      }>('deleteCategory', { id: category.id })
      if (!result.ok) {
        flash(result.reason ?? '无法删除该标签', true)
        return
      }
      const fallbackId = result.fallbackId ?? null
      // 删除后停留在原一级分类下，不跟着迁移目标跳到「其他」
      const stayId = result.stayId ?? category.parentId ?? fallbackId ?? ''
      setData((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          txns: prev.txns.map((txn) =>
            txn.categoryId === category.id ? { ...txn, categoryId: fallbackId } : txn
          ),
          meta: {
            ...prev.meta,
            categories: prev.meta.categories.filter((item) => item.id !== category.id),
            settings:
              prev.meta.settings.lastCategoryId === category.id
                ? { ...prev.meta.settings, lastCategoryId: stayId }
                : prev.meta.settings
          }
        }
      })
      if (categoryId === category.id) setCategoryId(stayId)
      flash(result.moved ? `已删除标签，${result.moved} 笔记录转到其他` : '已删除标签')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  /** 新增一级分类，创建后直接选中，便于继续补充二级标签 */
  const addParentCategory = async (): Promise<void> => {
    if (!meta || type === 'transfer') return
    const name = newParentName.trim()
    if (!name) return
    const kind = type === 'income' ? 'income' : 'expense'
    const duplicate = meta.categories.some(
      (item) => !item.parentId && item.type === kind && item.name === name
    )
    if (duplicate) {
      flash(`「${name}」已存在`, true)
      return
    }
    try {
      const saved = await invoke<Category>('saveCategory', { name, parentId: null, type: kind })
      setData((prev) =>
        prev ? { ...prev, meta: { ...prev.meta, categories: [...prev.meta.categories, saved] } } : prev
      )
      setNewParentName('')
      setCategoryId(saved.id)
      flash(`已新增一级分类「${saved.name}」`)
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  /** 双击一级分类后提交重命名；输入框失焦时无效名称直接放弃，避免卡在编辑态 */
  const commitCategoryRename = async (fromBlur = false): Promise<void> => {
    const draft = editingCategory
    if (!draft || renameBusy.current) return
    const current = meta?.categories.find((item) => item.id === draft.id)
    if (!current) {
      setEditingCategory(null)
      return
    }
    const name = draft.name.trim()
    if (!name) {
      if (fromBlur) {
        setEditingCategory(null)
        return
      }
      flash('标签名称不能为空', true)
      return
    }
    if (name === current.name) {
      setEditingCategory(null)
      return
    }
    const duplicate = meta?.categories.some(
      (item) =>
        item.id !== draft.id &&
        item.name === name &&
        item.parentId === current.parentId &&
        item.type === current.type
    )
    if (duplicate) {
      flash(`「${name}」已存在`, true)
      if (fromBlur) setEditingCategory(null)
      return
    }
    renameBusy.current = true
    try {
      const saved = await invoke<Category>('saveCategory', {
        id: current.id,
        name,
        parentId: current.parentId,
        type: current.type
      })
      setData((prev) =>
        prev
          ? {
              ...prev,
              meta: {
                ...prev.meta,
                categories: prev.meta.categories.map((item) => (item.id === saved.id ? saved : item))
              }
            }
          : prev
      )
      setEditingCategory(null)
      flash(`已重命名为「${saved.name}」`)
    } catch (err) {
      flash(messageOf(err), true)
    } finally {
      renameBusy.current = false
    }
  }

  /** 确认删除一级分类：其下二级标签一并删除，引用流水迁移到其他分类 */
  const confirmRemoveCategory = async (): Promise<void> => {
    const target = deletingCategory
    if (!target) return
    setDeletingCategory(null)
    try {
      const result = await invoke<{
        ok: boolean
        reason?: string
        moved?: number
        fallbackId?: string | null
        stayId?: string
      }>('deleteCategory', { id: target.id, cascade: true })
      if (!result.ok) {
        flash(result.reason ?? '无法删除该分类', true)
        return
      }
      const reloaded = await invoke<LedgerData>('load')
      apply(reloaded)
      setEditingCategory(null)
      if (!reloaded.meta.categories.some((item) => item.id === categoryId)) {
        setCategoryId(result.stayId ?? reloaded.meta.settings.lastCategoryId)
      }
      flash(result.moved ? `已删除分类，${result.moved} 笔记录转到其他` : '已删除分类')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  /** 提交一级分类的新顺序：先按拖动结果本地重排，再落盘 */
  const commitCategoryOrder = (ids: string[]): void => {
    const row = parentRowRef.current
    if (row) {
      const rects = new Map<string, { left: number; top: number }>()
      row.querySelectorAll<HTMLElement>('[data-cat-id]').forEach((node) => {
        const id = node.dataset.catId ?? ''
        if (!id) return
        const box = node.getBoundingClientRect()
        rects.set(id, { left: box.left, top: box.top })
      })
      chipFlipRects.current = rects
    }

    setData((prev) => {
      if (!prev) return prev
      const positions: number[] = []
      prev.meta.categories.forEach((item, index) => {
        if (ids.includes(item.id)) positions.push(index)
      })
      const pool = ids
        .map((id) => prev.meta.categories.find((item) => item.id === id))
        .filter((item): item is Category => Boolean(item))
      if (positions.length !== ids.length || pool.length !== ids.length) return prev
      const categories = [...prev.meta.categories]
      positions.forEach((position, index) => {
        categories[position] = pool[index]
      })
      return { ...prev, meta: { ...prev.meta, categories } }
    })

    void invoke<Category[]>('reorderCategories', { ids })
      .then((saved) => {
        if (Array.isArray(saved) && saved.length) {
          setData((prev) => (prev ? { ...prev, meta: { ...prev.meta, categories: saved } } : prev))
        }
      })
      .catch(async (err) => {
        flash(messageOf(err), true)
        try {
          apply(await invoke<LedgerData>('load'))
        } catch {
          /* 重新读取失败时保留本地顺序，下次写入会以磁盘内容为准 */
        }
      })
  }

  /**
   * 一级分类拖动排序：
   * 槽位在按下时固定，拖动中只平移被拖标签，不改变布局，
   * 因此不会出现其他标签跳动、重影或指针抖动。
   */
  const beginCategoryDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    id: string
  ): void => {
    if (event.button !== 0) return
    const origin = event.target as HTMLElement
    if (origin.closest('.ledger-chip-x')) return
    if (editingCategory) return

    const row = parentRowRef.current
    if (!row) return
    const nodes = Array.from(row.querySelectorAll<HTMLElement>('[data-cat-id]'))
    if (nodes.length < 2) return
    const originalIds = nodes.map((node) => node.dataset.catId ?? '').filter(Boolean)
    if (originalIds.length < 2 || !originalIds.includes(id)) return

    const scroller = row.closest('.ledger-page') as HTMLElement | null
    const node = event.currentTarget
    categorySlots.current = nodes.map((item) => ({
      id: item.dataset.catId ?? '',
      left: item.offsetLeft,
      top: item.offsetTop,
      width: item.offsetWidth,
      height: item.offsetHeight
    }))
    categoryOrder.current = originalIds
    categoryDragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScroll: scroller?.scrollTop ?? 0,
      moved: false,
      node
    }

    let lastX = event.clientX
    let lastY = event.clientY
    let frame = 0

    const updateDrop = (): void => {
      const drag = categoryDragRef.current
      if (!drag) return
      const box = row.getBoundingClientRect()
      const localX = lastX - box.left
      const localY = lastY - box.top
      const others = categorySlots.current.filter((slot) => slot.id !== drag.id)
      if (!others.length) return

      // 行优先：指针在某标签所在行之上，或同排且在中线左侧，即插到该标签之前
      let insertAt = others.length
      for (let index = 0; index < others.length; index += 1) {
        const slot = others[index]
        if (localY < slot.top) {
          insertAt = index
          break
        }
        if (localY <= slot.top + slot.height && localX < slot.left + slot.width / 2) {
          insertAt = index
          break
        }
      }

      const last = others[others.length - 1]
      const bar =
        insertAt >= others.length
          ? { left: last.left + last.width + 3, top: last.top, height: last.height }
          : {
              left: others[insertAt].left - 4,
              top: others[insertAt].top,
              height: others[insertAt].height
            }
      setDropBar((prev) =>
        prev && prev.left === bar.left && prev.top === bar.top && prev.height === bar.height
          ? prev
          : bar
      )

      const next = others.map((slot) => slot.id)
      next.splice(Math.min(insertAt, next.length), 0, drag.id)
      categoryOrder.current = next
    }

    const autoScroll = (): void => {
      const drag = categoryDragRef.current
      if (!drag) return
      if (scroller) {
        const box = scroller.getBoundingClientRect()
        const edge = 32
        let scrolled = false
        if (lastY < box.top + edge) {
          const before = scroller.scrollTop
          scroller.scrollTop -= Math.ceil((box.top + edge - lastY) / 4)
          scrolled = scroller.scrollTop !== before
        } else if (lastY > box.bottom - edge) {
          const before = scroller.scrollTop
          scroller.scrollTop += Math.ceil((lastY - box.bottom + edge) / 4)
          scrolled = scroller.scrollTop !== before
        }
        // 页面滚动后标签的屏幕位置变了，补上滚动量才能让标签继续贴着指针
        if (scrolled) {
          const delta = scroller.scrollTop - drag.startScroll
          drag.node.style.transform = `translate3d(${lastX - drag.startX}px, ${lastY - drag.startY + delta}px, 0)`
        }
      }
      updateDrop()
      frame = requestAnimationFrame(autoScroll)
    }

    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return
      const drag = categoryDragRef.current
      if (!drag) return
      lastX = moveEvent.clientX
      lastY = moveEvent.clientY
      if (!drag.moved) {
        if (Math.abs(lastX - drag.startX) < 4 && Math.abs(lastY - drag.startY) < 4) return
        drag.moved = true
        setDragCategoryId(drag.id)
        drag.node.style.transition = 'none'
        frame = requestAnimationFrame(autoScroll)
      }
      moveEvent.preventDefault()
      const delta = (scroller?.scrollTop ?? 0) - drag.startScroll
      drag.node.style.transform = `translate3d(${lastX - drag.startX}px, ${lastY - drag.startY + delta}px, 0)`
      updateDrop()
    }

    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frame) cancelAnimationFrame(frame)
      const drag = categoryDragRef.current
      const moved = drag?.moved ?? false
      categoryDragRef.current = null
      setDragCategoryId('')
      setDropBar(null)
      if (!drag) return
      if (!moved) {
        drag.node.style.transition = ''
        drag.node.style.transform = ''
        return
      }
      // 吞掉拖动结束后的这次点击，避免误触选中或删除
      suppressCategoryClick.current = true
      window.setTimeout(() => {
        suppressCategoryClick.current = false
      }, 0)
      if (categoryOrder.current.join('|') === originalIds.join('|')) {
        drag.node.style.transition = 'transform 0.16s cubic-bezier(0.22, 1, 0.36, 1)'
        drag.node.style.transform = ''
        return
      }
      commitCategoryOrder(categoryOrder.current)
      drag.node.style.transition = ''
      drag.node.style.transform = ''
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  useLayoutEffect(() => {
    // 排序落位后用 FLIP 补间：先反向位移，再回零，标签滑动到位而不是瞬移
    const previous = chipFlipRects.current
    if (!previous) return
    chipFlipRects.current = null
    const row = parentRowRef.current
    if (!row) return
    const nodes = Array.from(row.querySelectorAll<HTMLElement>('[data-cat-id]'))
    nodes.forEach((node) => {
      const before = previous.get(node.dataset.catId ?? '')
      if (!before) return
      const box = node.getBoundingClientRect()
      const dx = before.left - box.left
      const dy = before.top - box.top
      node.style.transition = 'none'
      node.style.transform = dx || dy ? `translate3d(${dx}px, ${dy}px, 0)` : ''
      requestAnimationFrame(() => {
        node.style.transition = 'transform 0.18s cubic-bezier(0.22, 1, 0.36, 1)'
        node.style.transform = ''
      })
    })
  }, [parentCategories])

  useEffect(() => {
    // 切换类型或离开记账页时退出重命名，避免输入框残留在其他分类上
    setEditingCategory(null)
  }, [type, page])

  const saveEntry = async (): Promise<void> => {
    if (!meta) return
    const cents = parseAmountToCents(amountText)
    if (!cents || cents <= 0) {
      flash('金额需要大于 0', true)
      amountRef.current?.focus()
      return
    }
    if (!accountId) {
      flash('请先在账户页新增账户', true)
      return
    }
    if (type !== 'transfer' && !categoryId) {
      flash('请选择分类', true)
      return
    }
    const draft: Record<string, unknown> = {
      type,
      date: date || today(),
      amount: cents,
      currency,
      accountId,
      categoryId: type === 'transfer' ? null : categoryId,
      note: note.trim(),
      tags: []
    }
    if (type === 'transfer') {
      if (!toAccountId || toAccountId === accountId) {
        flash('转入账户需要与转出账户不同', true)
        return
      }
      draft.toAccountId = toAccountId
      draft.toCurrency = toCurrency
      const toCents = parseAmountToCents(toAmountText)
      if (toCurrency !== currency && (!toCents || toCents <= 0)) {
        flash('跨币种转账需要填写到账金额', true)
        return
      }
      draft.toAmount = toCents && toCents > 0 ? toCents : cents
    }

    try {
      const saved = await invoke<Txn>('saveTxn', draft)
      setData((prev) => {
        if (!prev) return prev
        const exists = prev.txns.some((item) => item.id === saved.id)
        return {
          ...prev,
          txns: exists
            ? prev.txns.map((item) => (item.id === saved.id ? saved : item))
            : [...prev.txns, saved],
          meta: {
            ...prev.meta,
            settings: {
              ...prev.meta.settings,
              lastCurrency: currency,
              lastCategoryId: draft.categoryId ? categoryId : prev.meta.settings.lastCategoryId
            }
          }
        }
      })
      setAmountText('')
      setNote('')
      setToAmountText('')
      setToTouched(false)
      setToCurrencyTouched(false)
      flash('已保存')
      amountRef.current?.focus()
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const updateTxn = async (txn: Txn, patch: Partial<Txn>): Promise<void> => {
    try {
      const saved = await invoke<Txn>('saveTxn', { ...txn, ...patch })
      setData((prev) =>
        prev ? { ...prev, txns: prev.txns.map((item) => (item.id === saved.id ? saved : item)) } : prev
      )
      flash('已更新')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const removeTxn = async (txn: Txn): Promise<void> => {
    const index = txns.findIndex((item) => item.id === txn.id)
    try {
      await invoke('deleteTxn', { id: txn.id })
      setData((prev) => (prev ? { ...prev, txns: prev.txns.filter((item) => item.id !== txn.id) } : prev))
      setUndoState({ txn, index })
      window.setTimeout(() => {
        setUndoState((current) => (current && current.txn.id === txn.id ? null : current))
      }, 6000)
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const restoreTxn = async (): Promise<void> => {
    const pending = undoRef.current
    if (!pending) return
    try {
      const saved = await invoke<Txn>('saveTxn', pending.txn)
      setData((prev) => {
        if (!prev) return prev
        if (prev.txns.some((item) => item.id === saved.id)) return prev
        return { ...prev, txns: [...prev.txns, saved] }
      })
      setUndoState(null)
      flash('已撤销删除')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const updateMetaLocal = (next: Partial<LedgerData['meta']>): void => {
    setData((prev) => (prev ? { ...prev, meta: { ...prev.meta, ...next } } : prev))
  }

  const changeBase = async (value: Currency): Promise<void> => {
    try {
      const settings = await invoke<LedgerData['meta']['settings']>('saveSettings', { baseCurrency: value })
      if (meta) updateMetaLocal({ settings })
      flash(`本位币已切换为 ${value}，历史折算金额保持原快照`)
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const changeDefaultAccount = async (value: string): Promise<void> => {
    setAccountId(value)
    try {
      await invoke('saveSettings', { defaultAccountId: value })
      if (meta) updateMetaLocal({ settings: { ...meta.settings, defaultAccountId: value } })
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const saveRates = async (): Promise<void> => {
    try {
      const entries: Array<[Currency, string]> = [
        ['EUR', rateEUR],
        ['USD', rateUSD],
        ['GBP', rateGBP]
      ]
      const filled: Array<[Currency, number]> = []
      for (const [item, text] of entries) {
        if (!text.trim()) continue
        const value = parseRate(text)
        if (!value) {
          flash(`${item} 汇率需要填写大于 0 的数值`, true)
          return
        }
        filled.push([item, value])
      }
      if (!filled.length) {
        flash('请至少填写一个汇率', true)
        return
      }
      for (const [item, value] of filled) {
        await invoke('saveRate', { currency: item, value })
      }
      const reloaded = await invoke<LedgerData>('load')
      setData(reloaded)
      setRateWarning('')
      flash('汇率已保存，只影响之后录入的记录')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const openDataFolder = async (): Promise<void> => {
    try {
      const result = await invoke<{ path: string }>('openDataFolder')
      flash(`数据目录：${result.path}`)
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const backup = async (): Promise<void> => {
    try {
      const result = await invoke<{ path: string | null }>('backup')
      flash(result.path ? `已导出：${result.path}` : '已取消导出')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const pickImport = async (): Promise<void> => {
    try {
      const result = await invoke<ImportPreview | null>('pickImport')
      setImportPreview(result)
      if (result) flash('请核对备份内容后确认恢复')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const confirmImport = async (): Promise<void> => {
    const preview = importPreview
    if (!preview || importBusy) return
    setImportBusy(true)
    try {
      const result = await invoke<{ txnCount: number; safetyPath: string }>('importBackup', {
        path: preview.path
      })
      const reloaded = await invoke<LedgerData>('load')
      apply(reloaded)
      const settings = reloaded.meta.settings
      const active = reloaded.meta.accounts.filter((item) => !item.archived && !item.deleted)
      setAccountId(settings.defaultAccountId || active[0]?.id || '')
      setCurrency(settings.lastCurrency)
      setCategoryId(settings.lastCategoryId)
      setToCurrency(settings.lastCurrency)
      setFilterAccount('')
      setUndoState(null)
      setImportPreview(null)
      flash(`已恢复 ${result.txnCount} 条记录，导入前数据另存于 ${result.safetyPath}`)
    } catch (err) {
      flash(messageOf(err), true)
    } finally {
      setImportBusy(false)
    }
  }

  const exportData = async (format: 'csv' | 'md' | 'xlsx'): Promise<void> => {
    try {
      const result = await invoke<{ path: string | null; count: number }>('export', {
        format,
        from: range.from,
        to: range.to,
        label: periodPrefix(period) + range.label,
        fileBase: fileTag(period, range),
        accountId: filterAccount || undefined,
        currency: filterCurrency || undefined,
        keyword
      })
      if (!result.path) {
        flash('已取消导出')
        return
      }
      flash(`已导出 ${result.count} 条：${result.path}`)
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const saveAccount = async (): Promise<void> => {
    if (!accountDraft) return
    if (!accountDraft.name.trim()) {
      flash('请填写账户名称', true)
      return
    }
    const initial: Partial<Record<Currency, number>> = {}
    for (const item of CURRENCIES) {
      const text = (accountDraft.initial[item] ?? '').trim()
      if (!text) continue
      const cents = parseAmountToCents(text)
      if (cents === null) {
        flash(`期初余额格式不正确：${item}`, true)
        return
      }
      // 信用类账户允许负值，0 视作未填
      if (cents !== 0) initial[item] = cents
    }
    try {
      const saved = await invoke<Account>('saveAccount', {
        id: accountDraft.id,
        name: accountDraft.name,
        type: accountDraft.type,
        initial
      })
      setData((prev) => {
        if (!prev) return prev
        const exists = prev.meta.accounts.some((item) => item.id === saved.id)
        return {
          ...prev,
          meta: {
            ...prev.meta,
            accounts: exists
              ? prev.meta.accounts.map((item) => (item.id === saved.id ? saved : item))
              : [...prev.meta.accounts, saved]
          }
        }
      })
      if (!accountDraft.id) setAccountId(saved.id)
      setAccountDraft(null)
      flash(accountDraft.id ? '账户已更新' : '账户已创建')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const archiveAccount = async (account: Account): Promise<void> => {
    try {
      const saved = await invoke<Account>('saveAccount', { ...account, archived: !account.archived })
      setData((prev) =>
        prev
          ? {
              ...prev,
              meta: {
                ...prev.meta,
                accounts: prev.meta.accounts.map((item) => (item.id === saved.id ? saved : item))
              }
            }
          : prev
      )
      if (saved.archived && accountId === saved.id) {
        const next = accounts.find((item) => item.id !== saved.id && !item.archived)
        setAccountId(next?.id ?? '')
      }
      if (saved.archived && toAccountId === saved.id) {
        const alternative = accounts.find((item) => item.id !== saved.id && !item.archived && item.id !== accountId)
        setToAccountId(alternative?.id ?? '')
      }
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const removeAccount = async (account: Account): Promise<void> => {
    try {
      const result = await invoke<{ ok: boolean; reason?: string }>('deleteAccount', { id: account.id })
      if (!result.ok) {
        flash(result.reason ?? '无法删除该账户', true)
        return
      }
      const fallback = accounts.find((item) => item.id !== account.id && !item.archived)
      if (accountId === account.id) setAccountId(fallback?.id ?? '')
      if (toAccountId === account.id) setToAccountId(fallback?.id ?? '')
      if (accountDraft?.id === account.id) setAccountDraft(null)
      if (flowsAccount?.id === account.id) setFlowsAccount(null)
      setData((prev) =>
        prev
          ? {
              ...prev,
              meta: {
                ...prev.meta,
                accounts: prev.meta.accounts.map((item) =>
                  item.id === account.id ? { ...item, deleted: true } : item
                )
              }
            }
          : prev
      )
      flash('账户已删除，历史流水保持不变')
    } catch (err) {
      flash(messageOf(err), true)
    }
  }

  const confirmRemoveAccount = async (): Promise<void> => {
    const account = deletingAccount
    if (!account) return
    setDeletingAccount(null)
    await removeAccount(account)
  }

  const cycleCurrency = (value: Currency): void => {
    setCurrency(value)
    // 未手动选过转入币种时跟随转出币种
    if (!toCurrencyTouched) setToCurrency(value)
  }

  /** 乐观更新本地顺序，order 字段按新位置重排 */
  const applyAccountOrder = (ids: string[]): void => {
    // 先记录换位前的布局位置，供渲染后做位移补间
    const grid = accountGridRef.current
    if (grid) {
      const nodes = Array.from(grid.querySelectorAll<HTMLElement>('.ledger-account-card'))
      const map = new Map<string, DOMRect>()
      nodes.forEach((node) => {
        node.style.transition = 'none'
        node.style.transform = ''
        const id = node.dataset.id
        if (id) map.set(id, node.getBoundingClientRect())
      })
      flipRects.current = map
    }

    setData((prev) => {
      if (!prev) return prev
      const byId = new Map(prev.meta.accounts.map((item) => [item.id, item]))
      const next: Account[] = []
      for (const id of ids) {
        const account = byId.get(id)
        if (account) next.push(account)
      }
      for (const account of prev.meta.accounts) {
        if (!ids.includes(account.id)) next.push(account)
      }
      return {
        ...prev,
        meta: {
          ...prev.meta,
          accounts: next.map((account, index) => ({ ...account, order: index }))
        }
      }
    })
  }

  useEffect(() => {
    // FLIP：按换位前后的位置差做一次短补间，使卡片是滑过去而不是瞬移
    const previous = flipRects.current
    if (!previous) return
    flipRects.current = null
    const grid = accountGridRef.current
    if (!grid) return
    const nodes = Array.from(grid.querySelectorAll<HTMLElement>('.ledger-account-card'))
    const current = nodes.map((node) => node.getBoundingClientRect())
    nodes.forEach((node, index) => {
      const id = node.dataset.id
      const before = id ? previous.get(id) : undefined
      if (!before) return
      const dx = before.left - current[index].left
      const dy = before.top - current[index].top
      if (!dx && !dy) {
        node.style.transition = ''
        node.style.transform = ''
        return
      }
      node.style.transition = 'none'
      node.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        node.style.transition = 'transform 0.16s cubic-bezier(0.22, 1, 0.36, 1)'
        node.style.transform = ''
      })
    })
  }, [accounts])

  /**
   * 拖动重排，行为与侧边栏一致：
   * 以拖动开始时各卡片的槽位为基准判断落点，槽位固定所以指针不动就不会抖动；
   * 不生成拖影节点，只给被拖卡片切换描边样式，因此不会出现重影。
   */
  const beginAccountDrag = (event: ReactPointerEvent<HTMLDivElement>, id: string): void => {
    if (event.button !== 0) return
    const origin = event.target as HTMLElement
    if (origin.closest('input, select, textarea')) return
    if (accountDraft) return

    const grid = accountGridRef.current
    if (!grid) return
    const scroller = grid.closest('.ledger-page') as HTMLElement | null
    const startX = event.clientX
    const startY = event.clientY
    const pointerId = event.pointerId
    const nodes = Array.from(grid.querySelectorAll<HTMLElement>('.ledger-account-card'))
    if (nodes.length < 2) return
    if (!nodes.some((node) => node.dataset.id === id)) return

    const originalIds = nodes.map((node) => node.dataset.id ?? '').filter(Boolean)
    if (originalIds.length < 2) return

    // 槽位在拖动开始时固定下来，换位不会改变它，因此指针不动就不会抖动
    const slots = nodes.map((node) => ({
      id: node.dataset.id ?? '',
      top: node.offsetTop,
      left: node.offsetLeft,
      width: node.offsetWidth,
      height: node.offsetHeight
    }))

    accountDragRef.current = { id, startX, startY, moved: false }
    accountOrderRef.current = originalIds

    const moveTo = (pointerX: number, pointerY: number): void => {
      const drag = accountDragRef.current
      if (!drag) return
      const box = grid.getBoundingClientRect()
      // 换算到网格内容坐标；滚动会同步反映在 box 上
      const localX = pointerX - box.left
      const localY = pointerY - box.top
      const others = slots.filter((slot) => slot.id !== drag.id)
      if (!others.length) return

      // 行优先：指针在某张卡片上沿之上，或同排且在中线左侧，即插到该卡片之前
      let insertAt = others.length
      for (let index = 0; index < others.length; index += 1) {
        const slot = others[index]
        if (localY < slot.top) {
          insertAt = index
          break
        }
        if (localY <= slot.top + slot.height && localX < slot.left + slot.width / 2) {
          insertAt = index
          break
        }
      }

      const next = others.map((slot) => slot.id)
      next.splice(Math.min(insertAt, next.length), 0, drag.id)
      if (next.join('|') === accountOrderRef.current.join('|')) return
      accountOrderRef.current = next
      applyAccountOrder(next)
    }

    let lastX = startX
    let lastY = startY
    let frame = 0

    // 指针贴近上下边缘时连续滚动，滚动后重新计算落点
    const autoScroll = (): void => {
      if (!accountDragRef.current) return
      if (scroller) {
        const box = scroller.getBoundingClientRect()
        const edge = 32
        if (lastY < box.top + edge) {
          scroller.scrollTop -= Math.ceil((box.top + edge - lastY) / 4)
        } else if (lastY > box.bottom - edge) {
          scroller.scrollTop += Math.ceil((lastY - box.bottom + edge) / 4)
        }
      }
      moveTo(lastX, lastY)
      frame = requestAnimationFrame(autoScroll)
    }

    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      const drag = accountDragRef.current
      if (!drag) return
      lastX = moveEvent.clientX
      lastY = moveEvent.clientY
      if (!drag.moved) {
        const far =
          Math.abs(moveEvent.clientY - startY) >= 4 || Math.abs(moveEvent.clientX - startX) >= 4
        if (!far) return
        drag.moved = true
        setDragAccountId(id)
        frame = requestAnimationFrame(autoScroll)
      }
      moveEvent.preventDefault()
      moveTo(lastX, lastY)
    }

    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frame) cancelAnimationFrame(frame)
      const moved = accountDragRef.current?.moved ?? false
      const order = accountOrderRef.current
      accountDragRef.current = null
      setDragAccountId('')
      if (!moved) return
      // 拖动结束后吞掉这次点击，避免误触卡片内按钮
      suppressAccountClick.current = true
      window.setTimeout(() => {
        suppressAccountClick.current = false
      }, 0)
      if (order.join('|') === originalIds.join('|')) return
      void invoke<Account[]>('reorderAccounts', { ids: order })
        .then((saved) => {
          if (Array.isArray(saved) && saved.length) {
            setData((prev) => (prev ? { ...prev, meta: { ...prev.meta, accounts: saved } } : prev))
          }
        })
        .catch((err) => flash(messageOf(err), true))
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  if (!meta) {
    return (
      <div className="ledger-page">
        <div className="ledger-empty">正在读取本地账本…</div>
      </div>
    )
  }

  const ratePoint = latestRates(meta)
  const periodLabel = `${periodPrefix(period)}${range.label}`

  return (
    <div className="ledger-page">
      <div className="ledger-tabs">
        <button className={page === 'ledger' ? 'ledger-tab is-on' : 'ledger-tab'} onClick={() => setPage('ledger')}>
          记账
        </button>
        <button className={page === 'accounts' ? 'ledger-tab is-on' : 'ledger-tab'} onClick={() => setPage('accounts')}>
          账户
        </button>
        <button className={page === 'settings' ? 'ledger-tab is-on' : 'ledger-tab'} onClick={() => setPage('settings')}>
          设置
        </button>
        <span className="ledger-tabs-note">
          汇率 {ratePoint ? ratePoint.date : '未获取'} · 本位币 {baseCurrency}
        </span>
      </div>

      {status && <div className={statusError ? 'ledger-flash is-error' : 'ledger-flash'}>{status}</div>}
      {rateWarning && page !== 'settings' && (
        <div className="ledger-flash is-error">汇率未更新：{rateWarning}，可在设置页手填</div>
      )}

      {page === 'ledger' && (
        <>
          <section className="ledger-composer">
            <div className="ledger-composer-main">
              <div className="ledger-seg">
                {(['expense', 'income', 'transfer'] as TxnType[]).map((item) => (
                  <button
                    key={item}
                    className={type === item ? 'ledger-seg-btn is-on' : 'ledger-seg-btn'}
                    onClick={() => switchType(item)}
                  >
                    {item === 'expense' ? '支出' : item === 'income' ? '收入' : '转账'}
                  </button>
                ))}
              </div>
              <select
                className="ledger-currency"
                value={currency}
                onChange={(event) => cycleCurrency(event.target.value as Currency)}
                aria-label="币种"
              >
                {CURRENCIES.map((item) => (
                  <option key={item} value={item}>
                    {CURRENCY_META[item].symbol} {item}
                  </option>
                ))}
              </select>
              <input
                ref={amountRef}
                className={amountInvalid ? 'ledger-amount is-invalid' : 'ledger-amount'}
                value={amountText}
                placeholder="0.00"
                inputMode="decimal"
                autoFocus
                onChange={(event) => setAmountText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveEntry()
                  if (event.key === 'Escape') setAmountText('')
                }}
              />
            </div>
            <div className="ledger-hint">{conversion}</div>

            <div className="ledger-meta-row">
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)} aria-label="账户">
                {activeAccounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              {!activeAccounts.length && <span className="ledger-no-account">先在账户页新增账户</span>}
              <input
                className="ledger-note"
                value={note}
                placeholder="备注，可选"
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveEntry()
                }}
              />
              <button className="primary ledger-save" onClick={() => void saveEntry()}>
                保存
              </button>
            </div>

            {type === 'transfer' && (
              <div className="ledger-transfer-row">
                <span className="dim">转入</span>
                <select value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
                  {activeAccounts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <select
                  value={toCurrency}
                  onChange={(event) => {
                    setToCurrency(event.target.value as Currency)
                    setToCurrencyTouched(true)
                    setToTouched(false)
                  }}
                >
                  {CURRENCIES.map((item) => (
                    <option key={item} value={item}>
                      {CURRENCY_META[item].symbol} {item}
                    </option>
                  ))}
                </select>
                <input
                  value={toAmountText}
                  placeholder="到账金额"
                  onChange={(event) => {
                    setToAmountText(event.target.value)
                    setToTouched(true)
                  }}
                />
                <span className="dim ledger-hint-inline">
                  {currency !== toCurrency ? '按汇率自动折算，可手改' : ''}
                </span>
              </div>
            )}

            {type !== 'transfer' && (
              <div className="ledger-categories">
                <div className="ledger-chips" ref={parentRowRef}>
                  {parentCategories.map((parent) => {
                    const editing = editingCategory?.id === parent.id ? editingCategory : null
                    if (editing) {
                      return (
                        <input
                          key={parent.id}
                          className="ledger-chip-rename"
                          value={editing.name}
                          autoFocus
                          aria-label={`重命名一级分类 ${parent.name}`}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) =>
                            setEditingCategory({ id: parent.id, name: event.target.value })
                          }
                          onBlur={() => {
                            if (renameSettled.current) {
                              renameSettled.current = false
                              return
                            }
                            void commitCategoryRename(true)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              renameSettled.current = true
                              void commitCategoryRename()
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              renameSettled.current = true
                              setEditingCategory(null)
                            }
                          }}
                        />
                      )
                    }
                    return (
                      <button
                        key={parent.id}
                        data-cat-id={parent.id}
                        className={[
                          'ledger-chip',
                          'ledger-chip-parent',
                          selectedParent === parent.id ? 'is-on' : '',
                          dragCategoryId === parent.id ? 'is-dragging' : ''
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        title="拖动排序，双击重命名"
                        onPointerDown={(event) => beginCategoryDrag(event, parent.id)}
                        onClick={() => {
                          if (suppressCategoryClick.current) return
                          const child = typeCategories.find((item) => item.parentId === parent.id)
                          setCategoryId(child?.id ?? parent.id)
                        }}
                        onDoubleClick={() => {
                          if (suppressCategoryClick.current) return
                          renameSettled.current = false
                          setEditingCategory({ id: parent.id, name: parent.name })
                        }}
                      >
                        {parent.name}
                        {selectedParent === parent.id && (
                          <span
                            className="ledger-chip-x"
                            aria-label={`删除一级分类 ${parent.name}`}
                            title="删除该一级分类"
                            onClick={(event) => {
                              event.stopPropagation()
                              setDeletingCategory(parent)
                            }}
                          >
                            ×
                          </span>
                        )}
                      </button>
                    )
                  })}
                  <input
                    className="ledger-chip-add ledger-chip-add-parent"
                    value={newParentName}
                    placeholder="+ 一级标签"
                    aria-label="新增一级标签"
                    onChange={(event) => setNewParentName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void addParentCategory()
                      }
                      if (event.key === 'Escape') setNewParentName('')
                    }}
                  />
                  {dropBar && (
                    <span
                      className="ledger-chip-drop"
                      style={{ left: dropBar.left, top: dropBar.top, height: dropBar.height }}
                    />
                  )}
                </div>
                <div className="ledger-chips ledger-subchips">
                  <input
                    className="ledger-chip-add"
                    value={newSubName}
                    placeholder="+ 新标签"
                    aria-label="新增二级标签"
                    onChange={(event) => setNewSubName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void addSubCategory()
                      }
                      if (event.key === 'Escape') setNewSubName('')
                    }}
                  />
                  {typeCategories
                    .filter((item) => item.parentId === selectedParent)
                    .map((child) => (
                      <button
                        key={child.id}
                        className={categoryId === child.id ? 'ledger-chip is-on' : 'ledger-chip'}
                        onClick={() => setCategoryId(child.id)}
                      >
                        {child.name}
                        {categoryId === child.id && (
                          <span
                            className="ledger-chip-x"
                            aria-label={`删除标签 ${child.name}`}
                            title="删除该标签"
                            onClick={(event) => {
                              event.stopPropagation()
                              void removeSubCategory(child)
                            }}
                          >
                            ×
                          </span>
                        )}
                      </button>
                    ))}
                </div>
              </div>
            )}
          </section>

          <div className="ledger-periodbar">
            <span className="ledger-label">期间</span>
            <div className="ledger-seg">
              <button
                className={period === 'month' ? 'ledger-seg-btn is-on' : 'ledger-seg-btn'}
                onClick={() => setPeriod('month')}
              >
                本月
              </button>
              <button
                className={period === 'week' ? 'ledger-seg-btn is-on' : 'ledger-seg-btn'}
                onClick={() => setPeriod('week')}
              >
                本周
              </button>
              <button
                className={period === 'custom' ? 'ledger-seg-btn is-on' : 'ledger-seg-btn'}
                onClick={() => {
                  setPeriod('custom')
                  // 历史区间默认本月 1 日至今天，已有自定义日期时保留
                  if (!from || !to) {
                    setFrom(monthRange().from)
                    setTo(today())
                  }
                }}
              >
                历史
              </button>
            </div>
            {period === 'custom' && (
              <div className="ledger-daterange">
                <input
                  type="date"
                  value={from}
                  onChange={(event) => {
                    const value = event.target.value
                    // 起止颠倒时直接交换，输入框与查询口径保持一致
                    if (value && to && value > to) {
                      setFrom(to)
                      setTo(value)
                      return
                    }
                    setFrom(value)
                  }}
                />
                <span className="dim">至</span>
                <input
                  type="date"
                  value={to}
                  onChange={(event) => {
                    const value = event.target.value
                    if (value && from && value < from) {
                      setTo(from)
                      setFrom(value)
                      return
                    }
                    setTo(value)
                  }}
                />
              </div>
            )}
            <span className="ledger-period-text">{periodLabel}</span>
            <span className="ledger-spacer" />
            <select value={filterAccount} onChange={(event) => setFilterAccount(event.target.value)}>
              <option value="">全部账户</option>
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.archived ? '（已归档）' : ''}
                </option>
              ))}
            </select>
            <select
              value={filterCurrency}
              onChange={(event) => setFilterCurrency(event.target.value as Currency | '')}
            >
              <option value="">全部币种</option>
              {CURRENCIES.map((item) => (
                <option key={item} value={item}>
                  {CURRENCY_META[item].name}
                </option>
              ))}
            </select>
            <input
              className="ledger-search"
              value={keyword}
              placeholder="搜索备注或分类"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>

          <section className="ledger-summary">
            <div className="ledger-summary-main">
              <div className="ledger-stat">
                <span>支出</span>
                <b className="is-expense">{formatMoney(summary?.expense ?? 0, baseCurrency)}</b>
              </div>
              <div className="ledger-stat">
                <span>收入</span>
                <b className="is-income">{formatMoney(summary?.income ?? 0, baseCurrency)}</b>
              </div>
              <div className="ledger-stat">
                <span>净额</span>
                <b>{formatMoney(summary?.net ?? 0, baseCurrency)}</b>
              </div>
              <div className="ledger-stat">
                <span>待报销</span>
                <b>{formatMoney(summary?.reimbursable ?? 0, baseCurrency)}</b>
              </div>
              <button className="ledger-toggle" onClick={() => setExpandCur((value) => !value)}>
                {expandCur ? '收起币种' : '展开币种'}
              </button>
            </div>
            {expandCur && (
              <div className="ledger-summary-cur">
                {CURRENCIES.filter((item) => summary?.perCurrency[item]?.count).map((item) => {
                  const bucket = summary?.perCurrency[item]
                  if (!bucket) return null
                  const rate = rateToBase(meta, item)
                  return (
                    <span key={item}>
                      {item} {formatMoney(bucket.amount, item)}（{bucket.count} 笔）≈{' '}
                      {rate ? formatMoney(Math.round(bucket.amount * rate), baseCurrency) : '汇率缺失'}
                    </span>
                  )
                })}
                {!CURRENCIES.some((item) => summary?.perCurrency[item]?.count) && (
                  <span>当前期间没有支出记录</span>
                )}
              </div>
            )}
          </section>

          <div className="ledger-exportbar">
            <button onClick={() => void exportData('csv')}>导出 CSV</button>
            <button onClick={() => void exportData('md')}>导出 Markdown</button>
            <button onClick={() => void exportData('xlsx')}>导出 XLSX</button>
            <span className="dim ledger-hint-inline">导出范围跟随当前期间与筛选</span>
          </div>

          <section className="ledger-list">
            {grouped.length === 0 && (
              <div className="ledger-empty">
                <span>{txns.length ? '当前期间与筛选下没有记录' : '还没有记录，从上方输入金额开始'}</span>
              </div>
            )}
            {grouped.map((group) => (
              <div key={group.day} className="ledger-day">
                <div className="ledger-day-head">
                  <span>{group.day}</span>
                  <span>{group.items.length} 笔</span>
                </div>
                {group.items.map((txn) => {
                  const label = categoryLabel(meta.categories, txn.categoryId)
                  const target = txn.toAccountId
                    ? meta.accounts.find((item) => item.id === txn.toAccountId)
                    : undefined
                  const source = meta.accounts.find((item) => item.id === txn.accountId)
                  const baseValue = txn.baseAmount || 0
                  const editingCategory =
                    editingTxn?.id === txn.id && editingTxn.field === 'category' && txn.type !== 'transfer'
                  const editingAmount = editingTxn?.id === txn.id && editingTxn.field === 'amount'
                  return (
                    <div key={txn.id} className="ledger-row">
                      <span className="ledger-row-time">
                        {txn.type === 'transfer' ? '转账' : txn.date.slice(5)}
                      </span>
                      <span
                        className="ledger-row-desc"
                        onDoubleClick={() => {
                          if (txn.type === 'transfer') return
                          setEditingTxn({ id: txn.id, field: 'category' })
                        }}
                      >
                        {editingCategory ? (
                          <select
                            className="ledger-inline-select"
                            value={txn.categoryId ?? ''}
                            autoFocus
                            onChange={(event) => {
                              const value = event.target.value
                              setEditingTxn(null)
                              if (value) void updateTxn(txn, { categoryId: value })
                            }}
                            onBlur={() => setEditingTxn(null)}
                          >
                            {meta.categories
                              .filter((item) => item.type === txn.type)
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {categoryLabel(meta.categories, item.id)?.full}
                                </option>
                              ))}
                            {!txn.categoryId && <option value="">未分类</option>}
                          </select>
                        ) : txn.type === 'transfer' ? (
                          <>
                            {source?.name ?? '-'} → {target?.name ?? '-'}
                            {txn.note && <small>{txn.note}</small>}
                          </>
                        ) : (
                          <>
                            {label?.parent ?? '未分类'}
                            {label?.child && <small>{label.child}</small>}
                            {txn.note && <small>{txn.note}</small>}
                            {txn.reimbursable && <small className="ledger-tag">待报销</small>}
                          </>
                        )}
                      </span>
                      <span className="ledger-row-account">{source?.name ?? '-'}</span>
                      <span
                        className={`ledger-row-money ${txn.type === 'income' ? 'is-income' : txn.type === 'expense' ? 'is-expense' : ''}`}
                        onDoubleClick={() => {
                          if (txn.type === 'transfer') return
                          editSettled.current = false
                          setEditingTxn({ id: txn.id, field: 'amount' })
                          setEditText((txn.amount / 100).toFixed(2))
                        }}
                      >
                        {editingAmount ? (
                          <input
                            className="ledger-inline-input"
                            value={editText}
                            autoFocus
                            onChange={(event) => setEditText(event.target.value)}
                            onBlur={() => {
                              if (editSettled.current) {
                                editSettled.current = false
                                return
                              }
                              const cents = parseAmountToCents(editText)
                              setEditingTxn(null)
                              if (cents && cents > 0 && cents !== txn.amount) void updateTxn(txn, { amount: cents })
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                editSettled.current = true
                                const cents = parseAmountToCents(editText)
                                setEditingTxn(null)
                                if (cents && cents > 0) void updateTxn(txn, { amount: cents })
                              }
                              if (event.key === 'Escape') {
                                // 取消时不提交，同时抑制随之触发的 blur 提交
                                editSettled.current = true
                                setEditingTxn(null)
                              }
                            }}
                          />
                        ) : (
                          <>
                            {txn.type === 'income' ? '+' : txn.type === 'expense' ? '-' : ''}
                            {formatMoney(txn.amount, txn.currency)}
                            {txn.type === 'transfer' ? (
                              <em className="ledger-row-base">
                                → {formatMoney(txn.toAmount ?? 0, txn.toCurrency ?? txn.currency)}
                              </em>
                            ) : (
                              txn.currency !== baseCurrency && (
                                <em className="ledger-row-base">
                                  ≈ {formatMoney(baseValue, baseCurrency)}
                                </em>
                              )
                            )}
                          </>
                        )}
                      </span>
                      <button className="ledger-row-del" title="删除" onClick={() => void removeTxn(txn)}>
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </section>

          {deletingCategory && (
            <div className="modal-backdrop" onClick={() => setDeletingCategory(null)}>
              <div className="modal" onClick={(event) => event.stopPropagation()}>
                <div className="modal-title">删除一级分类</div>
                <div className="ledger-confirm-text">
                  确定删除「{deletingCategory.name}」？
                </div>
                <div className="ledger-confirm-note">
                  {(() => {
                    const childCount = meta.categories.filter(
                      (item) => item.parentId === deletingCategory.id
                    ).length
                    return childCount > 0
                      ? `该分类下的 ${childCount} 个二级标签会一并删除。相关流水会保留，分类改为同类型的其他一级分类。`
                      : '相关流水会保留，分类改为同类型的其他一级分类。'
                  })()}
                </div>
                <div className="ledger-confirm-actions">
                  <button className="ghost" onClick={() => setDeletingCategory(null)}>
                    取消
                  </button>
                  <button className="ledger-danger" onClick={() => void confirmRemoveCategory()}>
                    删除
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {page === 'accounts' && (
        <>
          <section className="ledger-accounts-head">
            <div className="ledger-stat">
              <span>折算合计</span>
              <b>{formatMoney(accounts.reduce((sum, item) => sum + accountTotal(txns, item, meta), 0), baseCurrency)}</b>
            </div>
            <span className="dim ledger-hint-inline">按当前汇率估算</span>
            <span className="ledger-spacer" />
            <button className="primary" onClick={() => setAccountDraft(emptyDraft())}>
              新增账户
            </button>
          </section>

          {accountDraft && !accountDraft.id && (
            <section className="ledger-account-form">
              <div className="ledger-form-row">
                <input
                  value={accountDraft.name}
                  placeholder="账户名称，如 美元储蓄"
                  autoFocus
                  onChange={(event) => setAccountDraft({ ...accountDraft, name: event.target.value })}
                />
                <select
                  value={accountDraft.type}
                  onChange={(event) =>
                    setAccountDraft({ ...accountDraft, type: event.target.value as Account['type'] })
                  }
                >
                  {(Object.keys(ACCOUNT_TYPES) as Account['type'][]).map((item) => (
                    <option key={item} value={item}>
                      {ACCOUNT_TYPES[item]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ledger-form-row">
                <span className="dim">期初余额</span>
                {CURRENCIES.map((item) => (
                  <label key={item} className="ledger-init">
                    <span>{CURRENCY_META[item].symbol}</span>
                    <input
                      placeholder="0.00"
                      value={accountDraft.initial[item] ?? ''}
                      onChange={(event) => {
                        setAccountDraft({
                          ...accountDraft,
                          initial: { ...accountDraft.initial, [item]: event.target.value }
                        })
                      }}
                    />
                  </label>
                ))}
                <button className="primary" onClick={() => void saveAccount()}>
                  创建
                </button>
                <button className="ghost" onClick={() => setAccountDraft(null)}>
                  取消
                </button>
              </div>
            </section>
          )}

          <div
            className={`ledger-account-grid${dragAccountId ? ' is-sorting' : ''}`}
            ref={accountGridRef}
          >
            {accounts.map((account) => {
              const editing = accountDraft?.id === account.id
              const total = accountTotal(txns, account, meta)
              return (
                <div
                  key={account.id}
                  data-id={account.id}
                  className={[
                    'ledger-account-card',
                    account.archived ? 'is-archived' : '',
                    account.id === dragAccountId ? 'is-dragging' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onPointerDown={(event) => beginAccountDrag(event, account.id)}
                >
                  {editing ? (
                    <div className="ledger-account-edit">
                      <div className="ledger-form-row">
                        <input
                          value={accountDraft.name}
                          autoFocus
                          onChange={(event) => setAccountDraft({ ...accountDraft, name: event.target.value })}
                        />
                        <select
                          value={accountDraft.type}
                          onChange={(event) =>
                            setAccountDraft({ ...accountDraft, type: event.target.value as Account['type'] })
                          }
                        >
                          {(Object.keys(ACCOUNT_TYPES) as Account['type'][]).map((item) => (
                            <option key={item} value={item}>
                              {ACCOUNT_TYPES[item]}
                            </option>
                          ))}
                        </select>
                      </div>
                      {CURRENCIES.map((item) => (
                        <label key={item} className="ledger-init">
                          <span>{CURRENCY_META[item].symbol}</span>
                          <input
                            value={accountDraft.initial[item] ?? ''}
                            placeholder="0.00"
                            onChange={(event) => {
                              setAccountDraft({
                                ...accountDraft,
                                initial: { ...accountDraft.initial, [item]: event.target.value }
                              })
                            }}
                          />
                        </label>
                      ))}
                      <div className="ledger-form-row">
                        <button className="primary" onClick={() => void saveAccount()}>
                          保存
                        </button>
                        <button className="ghost" onClick={() => setAccountDraft(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="ledger-account-head">
                        <b>{account.name}</b>
                        <span className="ledger-account-type">
                          {ACCOUNT_TYPES[account.type]}
                          {account.archived ? ' · 已归档' : ''}
                        </span>
                        <span className="ledger-spacer" />
                        <button
                          className="ghost ledger-mini"
                          onClick={() => {
                            if (suppressAccountClick.current) return
                            setAccountDraft(accountDraftOf(account))
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="ghost ledger-mini"
                          onClick={() => {
                            if (suppressAccountClick.current) return
                            void archiveAccount(account)
                          }}
                        >
                          {account.archived ? '恢复' : '归档'}
                        </button>
                      </div>
                      {CURRENCIES.map((item) => {
                        const value = accountBalance(txns, account, item)
                        return (
                          <div key={item} className={`ledger-balance${value === 0 ? ' is-zero' : ''}`}>
                            <span>{item}</span>
                            <span>{formatMoney(value, item)}</span>
                          </div>
                        )
                      })}
                      <div className="ledger-account-total">
                        <span>折算</span>
                        <span>{formatMoney(total, baseCurrency)}</span>
                      </div>
                      <div className="ledger-account-actions">
                        <button
                          className="ghost ledger-mini"
                          onClick={() => {
                            if (suppressAccountClick.current) return
                            setFlowsAccount(account)
                          }}
                        >
                          查看流水
                        </button>
                        <button
                          className="ghost ledger-mini"
                          onClick={() => {
                            if (suppressAccountClick.current) return
                            setDeletingAccount(account)
                          }}
                        >
                          删除
                        </button>
                      </div>

                    </>
                  )}
                </div>
              )
            })}
          </div>

          <div className="ledger-accounts-note">
            账户只记录存款和活期、大额定期（视作存款）；投资内容不包含在内
          </div>

          {flowsAccount && (
            <div className="modal-backdrop" onClick={() => setFlowsAccount(null)}>
              <div
                className="modal ledger-flows-modal"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="modal-title">账户流水</div>
                <div className="ledger-flows-head">
                  <b>{flowsAccount.name}</b>
                  <span className="dim">
                    {ACCOUNT_TYPES[flowsAccount.type]} · {flowsAccountTxns.length} 笔
                  </span>
                </div>
                <div className="ledger-flows-scroll">
                  {flowsAccountTxns.length === 0 ? (
                    <div className="ledger-flows-empty">该账户暂无流水</div>
                  ) : (
                    flowsAccountTxns.map((txn) => {
                      const delta = accountDelta(txn, flowsAccount.id)
                      if (!delta) return null
                      const label = categoryLabel(meta.categories, txn.categoryId)
                      return (
                        <div key={txn.id} className="ledger-flow-line">
                          <span>{txn.date.slice(5)}</span>
                          <span>
                            {txn.type === 'transfer'
                              ? txn.toAccountId === flowsAccount.id
                                ? '转入'
                                : '转出'
                              : label?.full ?? '未分类'}
                          </span>
                          <span className={delta.cents >= 0 ? 'is-income' : 'is-expense'}>
                            {formatMoney(delta.cents, delta.currency, true)}
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
                <div className="ledger-confirm-actions">
                  <button className="ghost" onClick={() => setFlowsAccount(null)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          )}

          {deletingAccount && (
            <div className="modal-backdrop" onClick={() => setDeletingAccount(null)}>
              <div className="modal" onClick={(event) => event.stopPropagation()}>
                <div className="modal-title">删除账户</div>
                <div className="ledger-confirm-text">
                  确定删除「{deletingAccount.name}」？账户会从账户页与录入选择中移除，删除后无法恢复。
                </div>
                <div className="ledger-confirm-note">
                  已有流水会全部保留，历史记录仍显示原账户名称，金额、分类与撤销操作不受影响。
                </div>
                <div className="ledger-confirm-actions">
                  <button className="ghost" onClick={() => setDeletingAccount(null)}>
                    取消
                  </button>
                  <button className="ledger-danger" onClick={() => void confirmRemoveAccount()}>
                    删除
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {page === 'settings' && (
        <>
          <section className="ledger-settings-block">
            <h2>本位币与默认账户</h2>
            <div className="ledger-setting-row">
              <span className="ledger-label">本位币</span>
              <select value={baseCurrency} onChange={(event) => void changeBase(event.target.value as Currency)}>
                {CURRENCIES.map((item) => (
                  <option key={item} value={item}>
                    {CURRENCY_META[item].symbol} {item} {CURRENCY_META[item].name}
                  </option>
                ))}
              </select>
              <span className="dim">历史记录的折算金额保持当时的汇率快照</span>
            </div>
            <div className="ledger-setting-row">
              <span className="ledger-label">默认账户</span>
              <select value={accountId} onChange={(event) => void changeDefaultAccount(event.target.value)}>
                {activeAccounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="ledger-settings-block">
            <h2>汇率</h2>
            <div className="ledger-setting-row">
              <span className="ledger-label">1 EUR</span>
              <input value={rateEUR} onChange={(event) => setRateEUR(event.target.value)} />
              <span className="dim">CNY</span>
            </div>
            <div className="ledger-setting-row">
              <span className="ledger-label">1 USD</span>
              <input value={rateUSD} onChange={(event) => setRateUSD(event.target.value)} />
              <span className="dim">CNY</span>
            </div>
            <div className="ledger-setting-row">
              <span className="ledger-label">1 GBP</span>
              <input value={rateGBP} onChange={(event) => setRateGBP(event.target.value)} />
              <span className="dim">CNY</span>
            </div>
            <div className="ledger-setting-row">
              <button className="primary" onClick={() => void saveRates()}>
                保存汇率
              </button>
              <button
                className="ghost"
                onClick={() => {
                  void invoke<{ ok: boolean; error?: string }>('refreshRates').then(async (result) => {
                    if (!result.ok) flash(result.error ?? '汇率获取失败', true)
                    else flash('汇率已更新')
                    setRateWarning(result.ok ? '' : (result.error ?? '汇率获取失败'))
                    const reloaded = await invoke<LedgerData>('load')
                    setData(reloaded)
                  })
                }}
              >
                获取最新汇率
              </button>
              <span className="dim">{ratePoint ? `最新 ${ratePoint.date}` : '尚未获取汇率'}</span>
            </div>
            <div className="ledger-setting-note">
              获取最新汇率时，以央行中间价乘 1.005 计入；手填的数值按原值使用。
            </div>
          </section>

          <section className="ledger-settings-block">
            <h2>数据</h2>
            <div className="ledger-setting-row">
              <button onClick={() => void openDataFolder()}>打开本地数据文件夹</button>
              <button onClick={() => void backup()}>导出整库 JSON</button>
              <button onClick={() => void pickImport()}>从 JSON 导入恢复</button>
            </div>
            {importPreview && (
              <div className="ledger-import-confirm">
                <div className="ledger-import-title">将用备份覆盖当前账本</div>
                <div className="ledger-import-file">{importPreview.path}</div>
                <div className="ledger-import-stats">
                  记录 {importPreview.txnCount} 条　账户 {importPreview.accountCount} 个　分类 {importPreview.categoryCount} 个　导出时间{' '}
                  {importTimeLabel(importPreview.exportedAt)}
                </div>
                <div className="ledger-import-warn">
                  恢复会替换当前的流水、账户、分类、汇率与设置。执行前会自动把现有数据另存到本地数据文件夹。
                </div>
                <div className="ledger-setting-row">
                  <button className="primary" disabled={importBusy} onClick={() => void confirmImport()}>
                    {importBusy ? '正在恢复…' : '确认恢复'}
                  </button>
                  <button
                    className="ghost"
                    disabled={importBusy}
                    onClick={() => setImportPreview(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            <div className="ledger-setting-note">
              数据保存在 %APPDATA%\Fiffel\data，包含 ledger.txns.json、ledger.meta.json，每次写入前保留 .bak 与当日快照。
            </div>
          </section>
        </>
      )}

      {undoState && (
        <div className="ledger-undo">
          <span>已删除 1 条记录</span>
          <button className="ghost ledger-mini" onClick={() => void restoreTxn()}>
            撤销
          </button>
        </div>
      )}
    </div>
  )
}
