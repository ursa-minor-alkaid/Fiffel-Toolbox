import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { createPortal } from 'react-dom'
import { usePlugin, formatSize } from '../../src/renderer/src/utils'
import { filePathOf } from '../../src/renderer/src/bridge'

interface WebApp {
  id: string
  name: string
  file: string
  dir: string
  addedAt: number
  groupId?: string
  missing: boolean
}

interface AppGroup {
  id: string
  name: string
  collapsed: boolean
}

interface StorageInfo {
  dir: string
  fileCount: number
}

interface FileStat {
  missing: boolean
  mtime: number
  size: number
}

interface LogEntry {
  level: 'error' | 'warn'
  message: string
  at: number
}

const basename = (file: string): string => file.split(/[\\/]/).pop() ?? file

const AUTORELOAD_KEY = 'fiffel:webapp:autoreload'
const LEGACY_AUTORELOAD_KEY = 'toolbox:webapp:autoreload'
const LOG_LIMIT = 200

function readAutoReload(): boolean {
  try {
    const stored =
      window.localStorage.getItem(AUTORELOAD_KEY) ??
      window.localStorage.getItem(LEGACY_AUTORELOAD_KEY)
    return stored !== '0'
  } catch {
    return true
  }
}

function formatClock(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

export default function WebAppView(): JSX.Element {
  const { invoke } = usePlugin('webapp')
  const [apps, setApps] = useState<WebApp[]>([])
  const [activeId, setActiveId] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [data, setData] = useState<Record<string, string>>({})
  const [showData, setShowData] = useState(false)
  const [status, setStatus] = useState('')
  const [renaming, setRenaming] = useState<WebApp | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameHoldsRail, setRenameHoldsRail] = useState(false)
  const [deleting, setDeleting] = useState<WebApp | null>(null)
  const [deleteWithData, setDeleteWithData] = useState(false)
  const [groups, setGroups] = useState<AppGroup[]>([])
  const [groupMenu, setGroupMenu] = useState<{ group: AppGroup; x: number; y: number } | null>(
    null
  )
  const [groupEditor, setGroupEditor] = useState<{ mode: 'create' | 'rename'; id?: string } | null>(
    null
  )
  const [groupDraft, setGroupDraft] = useState('')
  const [deletingGroup, setDeletingGroup] = useState<AppGroup | null>(null)
  const [assigning, setAssigning] = useState<WebApp | null>(null)
  const [dropGroupId, setDropGroupId] = useState('')
  const [sortDragId, setSortDragId] = useState('')
  const [sortHeight, setSortHeight] = useState(0)
  const [sortGhost, setSortGhost] = useState<{
    group: AppGroup
    count: number
    collapsed: boolean
    left: number
    top: number
    width: number
  } | null>(null)
  const [sortDrop, setSortDrop] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [dragId, setDragId] = useState('')
  const [dragGhost, setDragGhost] = useState<{
    app: WebApp
    left: number
    top: number
    width: number
  } | null>(null)
  const [autoReload, setAutoReload] = useState<boolean>(readAutoReload)
  const [fullscreen, setFullscreen] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [railSticky, setRailSticky] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [menu, setMenu] = useState<{ app: WebApp; x: number; y: number } | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    offsetY: number
    top: number
    left: number
    width: number
    moved: boolean
  } | null>(null)
  const dragOrderRef = useRef<string[]>([])
  const appsOrderRef = useRef<string[]>([])
  const dropGroupRef = useRef('')
  const initialOrderRef = useRef('')
  const suppressClick = useRef(false)
  const sortDragRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    offsetY: number
    top: number
    left: number
    width: number
    height: number
    moved: boolean
  } | null>(null)
  const sortOrderRef = useRef<string[]>([])
  const sortDropRef = useRef<{ id: string; edge: 'before' | 'after' } | null>(null)
  const sortGhostRef = useRef<HTMLDivElement>(null)
  const suppressSortClick = useRef(false)

  /** 菜单或弹窗打开期间保持边栏展开，避免鼠标移出后收起 */
  const railLocked = Boolean(
    menu || groupMenu || renaming || groupEditor || deletingGroup || assigning
  )

  const refresh = useCallback(async (): Promise<void> => {
    const [list, groupList] = await Promise.all([
      invoke<WebApp[]>('list'),
      invoke<AppGroup[]>('listGroups')
    ])
    setApps(list)
    setGroups(groupList)
    setActiveId((current) =>
      current && list.some((app) => app.id === current) ? current : (list[0]?.id ?? '')
    )
  }, [invoke])

  const refreshStorage = useCallback(async (): Promise<void> => {
    setStorage(await invoke<StorageInfo>('storageInfo'))
  }, [invoke])

  const loadData = useCallback(
    async (id: string): Promise<void> => {
      if (!id) {
        setData({})
        return
      }
      setData(await invoke<Record<string, string>>('readData', { id }))
    },
    [invoke]
  )

  useEffect(() => {
    void refresh()
    void refreshStorage()
  }, [refresh, refreshStorage])

  useEffect(() => {
    void loadData(activeId)
    setLogs([])
    setLogOpen(false)
    setImmersive(false)
  }, [activeId, loadData])

  /** 沉浸预览：隐藏页首与工具条，只保留页面本身 */
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('webapp-scope')
    return () => {
      root.classList.remove('webapp-scope')
      root.classList.remove('webapp-immersive')
    }
  }, [])

  /** 沉浸状态切换时更新根节点样式 */
  useEffect(() => {
    document.documentElement.classList.toggle('webapp-immersive', immersive)
  }, [immersive])

  useEffect(() => {
    if (!immersive) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setImmersive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [immersive])

  useEffect(() => {
    if (!menu && !groupMenu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null)
        setGroupMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, groupMenu])

  /** 重命名结束后继续保留边栏，直到鼠标离开边栏区域 */
  useEffect(() => {
    if (!railSticky || railLocked) return
    const onMove = (event: PointerEvent): void => {
      const rail = railRef.current
      if (!rail) return
      const target = document.elementFromPoint(event.clientX, event.clientY)
      if (target && rail.contains(target)) return
      setRailSticky(false)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [railSticky, railLocked])

  /**
   * 在预览容器（iframe 之外）向下滚动进入沉浸模式。
   * iframe 内的滚轮事件不会冒泡到父文档，因此挂在 window 上只会收到宿主区域的事件。
   */
  useEffect(() => {
    if (immersive || !activeId) return
    const page = paneRef.current?.closest('.page') ?? null
    const scrollable = '.console-panel, .data-panel, .app-rail-sheet, .modal'
    let pull = 0
    let lastAt = 0
    let cooldown = 0

    const onWheel = (event: WheelEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (page && !page.contains(target)) return
      if (target.closest(scrollable)) {
        pull = 0
        return
      }
      const now = Date.now()
      if (now < cooldown) return
      if (now - lastAt > 400) pull = 0
      lastAt = now
      if (event.deltaY <= 0) {
        pull = 0
        return
      }
      pull += event.deltaY
      if (pull < 180) return
      pull = 0
      cooldown = now + 1200
      setImmersive(true)
    }

    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [immersive, activeId])

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTORELOAD_KEY, autoReload ? '1' : '0')
      window.localStorage.removeItem(LEGACY_AUTORELOAD_KEY)
    } catch {
      /* 隐私模式下忽略持久化失败 */
    }
  }, [autoReload])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const payload = event.data as {
        __tbx?: number
        appId?: string
        ops?: unknown
        level?: string
        message?: string
        at?: number
      }
      if (!payload || typeof payload.appId !== 'string') return
      if (payload.appId !== activeId) return

      const frame = frameRef.current?.querySelector('iframe')
      if (frame && event.source && event.source !== frame.contentWindow) return

      if (payload.__tbx === 1 && Array.isArray(payload.ops)) {
        void invoke('applyOps', { id: payload.appId, ops: payload.ops })
          .then(() => {
            if (payload.appId === activeId) void loadData(activeId)
          })
          .catch(() => undefined)
        return
      }

      if (payload.__tbx === 4 && immersive) {
        setImmersive(false)
        return
      }

      if (payload.__tbx === 2 && typeof payload.message === 'string') {
        const entry: LogEntry = {
          level: payload.level === 'warn' ? 'warn' : 'error',
          message: payload.message,
          at: typeof payload.at === 'number' ? payload.at : Date.now()
        }
        setLogs((previous) => {
          const next = [...previous, entry]
          return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
        })
        if (entry.level === 'error') setLogOpen(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [invoke, activeId, loadData, immersive])

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === paneRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement) void document.exitFullscreen()
    }
  }, [])

  const active = useMemo(() => apps.find((app) => app.id === activeId), [apps, activeId])
  const activeSlot = active?.id ?? ''
  const activeMissing = active?.missing ?? false
  const src = active
    ? `tbx://${active.id}/${encodeURIComponent(basename(active.file))}?r=${reloadKey}`
    : ''

  /** 源文件被外部编辑器改动后自动刷新预览 */
  useEffect(() => {
    if (!autoReload || !activeSlot || activeMissing) return
    let stopped = false
    let signature = ''

    const tick = async (): Promise<void> => {
      const info = await invoke<FileStat>('stat', { id: activeSlot }).catch(() => null)
      if (stopped || !info) return
      if (info.missing) {
        void refresh()
        return
      }
      const next = `${info.mtime}:${info.size}`
      if (!signature) {
        signature = next
        return
      }
      if (next !== signature) {
        signature = next
        setReloadKey((key) => key + 1)
        setLogs([])
        setStatus('源文件已更新，页面已自动重载')
      }
    }

    const timer = window.setInterval(() => void tick(), 1200)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [autoReload, activeSlot, activeMissing, invoke, refresh])

  const reload = (): void => {
    setReloadKey((key) => key + 1)
    setLogs([])
  }

  const registerPath = async (path: string): Promise<void> => {
    const list = await invoke<WebApp[]>('add', { file: path })
    setApps(list)
    const added = list.find((app) => app.file.toLowerCase() === path.toLowerCase())
    if (added) {
      setActiveId(added.id)
      setStatus(`已登记：${added.name}`)
    }
    await refresh()
  }

  const addApp = async (): Promise<void> => {
    const list = await invoke<WebApp[]>('add')
    setApps(list)
    const added = list.find((app) => !apps.some((old) => old.id === app.id))
    if (added) {
      setActiveId(added.id)
      setStatus(`已登记：${added.name}`)
    }
    await refresh()
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    if (!/\.html?$/i.test(file.name)) {
      setStatus('只接受 .html 或 .htm 文件')
      return
    }
    let path = ''
    try {
      path = filePathOf(file)
    } catch {
      path = ''
    }
    if (!path) {
      setStatus('无法读取文件路径，请改用「添加 HTML」按钮')
      return
    }
    try {
      await registerPath(path)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '登记失败')
    }
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
  }

  const groupIdOf = (app: WebApp): string =>
    app.groupId && groups.some((group) => group.id === app.groupId) ? app.groupId : ''

  const assignApp = async (app: WebApp, groupId: string): Promise<void> => {
    const target = groups.find((group) => group.id === groupId) ?? null
    const list = await invoke<WebApp[]>('assignGroup', { id: app.id, groupId })
    setApps(list)
    if (target?.collapsed) {
      // 归类成功后展开目标分组，便于直接看到结果；展开失败不影响归类
      try {
        const next = await invoke<AppGroup[]>('setGroupCollapsed', {
          id: target.id,
          collapsed: false
        })
        setGroups(next)
      } catch {
        setGroups((previous) =>
          previous.map((item) => (item.id === target.id ? { ...item, collapsed: false } : item))
        )
      }
    }
    setStatus(groupId ? `已归类到「${target?.name ?? ''}」` : '已移出分组')
  }

  const chooseGroupForApp = async (app: WebApp, groupId: string): Promise<void> => {
    setAssigning(null)
    try {
      await assignApp(app, groupId)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '归类失败')
    }
  }

  const toggleGroup = async (group: AppGroup): Promise<void> => {
    setGroups((previous) =>
      previous.map((item) => (item.id === group.id ? { ...item, collapsed: !group.collapsed } : item))
    )
    try {
      const next = await invoke<AppGroup[]>('setGroupCollapsed', {
        id: group.id,
        collapsed: !group.collapsed
      })
      setGroups(next)
    } catch (error) {
      setGroups((previous) =>
        previous.map((item) => (item.id === group.id ? { ...item, collapsed: group.collapsed } : item))
      )
      setStatus(error instanceof Error ? error.message : '分组状态更新失败')
    }
  }

  const openGroupEditor = (mode: 'create' | 'rename', group?: AppGroup): void => {
    setGroupMenu(null)
    setRailSticky(true)
    setGroupEditor({ mode, id: group?.id })
    setGroupDraft(mode === 'rename' ? (group?.name ?? '') : '')
  }

  const closeGroupEditor = (): void => setGroupEditor(null)

  const commitGroupEditor = async (): Promise<void> => {
    if (!groupEditor) return
    const editing = groupEditor
    const name = groupDraft.trim()
    try {
      if (editing.mode === 'create') {
        const next = await invoke<AppGroup[]>('createGroup', { name })
        setGroups(next)
        const created = next[next.length - 1]
        setStatus(`已新建分组「${created?.name ?? name}」`)
      } else if (editing.id) {
        const next = await invoke<AppGroup[]>('renameGroup', { id: editing.id, name })
        setGroups(next)
        const renamed = next.find((group) => group.id === editing.id)
        setStatus(`分组已重命名为「${renamed?.name ?? name}」`)
      }
      setGroupEditor(null)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '分组保存失败')
    }
  }

  const requestRemoveGroup = (group: AppGroup): void => {
    setGroupMenu(null)
    setRailSticky(true)
    setDeletingGroup(group)
  }

  const confirmRemoveGroup = async (): Promise<void> => {
    if (!deletingGroup) return
    const group = deletingGroup
    setDeletingGroup(null)
    try {
      const result = await invoke<{ groups: AppGroup[]; apps: WebApp[] }>('removeGroup', {
        id: group.id
      })
      setGroups(result.groups)
      setApps(result.apps)
      setStatus(`已删除分组「${group.name}」，其中页面已移到未分组`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '删除分组失败')
    }
  }

  /** 命中测试时跳过拖拽浮层，再判断指针落在边栏哪个分组内 */
  const groupAtPoint = (x: number, y: number): { inside: boolean; groupId: string } => {
    const sheet = listRef.current
    if (!sheet) return { inside: false, groupId: '' }
    const stack = document.elementsFromPoint(x, y)
    for (const element of stack) {
      if (element.closest('.app-drag-layer, .app-drag-ghost, .app-group-drag-ghost')) continue
      if (!sheet.contains(element)) return { inside: false, groupId: '' }
      const group = element.closest<HTMLElement>('.app-group')
      return { inside: true, groupId: group?.dataset.groupId ?? '' }
    }
    return { inside: false, groupId: '' }
  }

  const pointerInSheet = (x: number, y: number): boolean => {
    const sheet = listRef.current
    if (!sheet) return false
    const stack = document.elementsFromPoint(x, y)
    for (const element of stack) {
      if (element.closest('.app-drag-layer, .app-drag-ghost, .app-group-drag-ghost')) continue
      return sheet.contains(element)
    }
    return false
  }

  /** 以各分组标题的中线为界，计算拖动分组应插入的位置 */
  const sortDropAt = (pointerY: number): { id: string; edge: 'before' | 'after' } | null => {
    const sheet = listRef.current
    const drag = sortDragRef.current
    if (!sheet || !drag) return null
    const nodes = Array.from(sheet.querySelectorAll<HTMLElement>('.app-group'))
    const others = nodes.filter((node) => node.dataset.groupId !== drag.id)
    if (!others.length) return null

    let insertAt = others.length
    for (let index = 0; index < others.length; index += 1) {
      const head = others[index].querySelector<HTMLElement>('.app-group-head')
      if (!head) continue
      const box = head.getBoundingClientRect()
      if (pointerY < box.top + box.height / 2) {
        insertAt = index
        break
      }
    }

    if (insertAt >= others.length) {
      const last = others[others.length - 1].dataset.groupId ?? ''
      return last ? { id: last, edge: 'after' } : null
    }
    const id = others[insertAt].dataset.groupId ?? ''
    return id ? { id, edge: 'before' } : null
  }

  const applySortDrop = (next: { id: string; edge: 'before' | 'after' } | null): void => {
    const previous = sortDropRef.current
    if (
      previous === next ||
      (previous && next && previous.id === next.id && previous.edge === next.edge)
    ) {
      return
    }
    sortDropRef.current = next
    setSortDrop(next)
  }

  const beginGroupSort = (
    event: ReactPointerEvent<HTMLButtonElement>,
    group: AppGroup,
    count: number
  ): void => {
    if (event.button !== 0) return
    const sheet = listRef.current
    const header = event.currentTarget
    const container = header.closest<HTMLElement>('.app-group')
    if (!sheet || !container) return

    const headerRect = header.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    const drag = {
      id: group.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetY: event.clientY - headerRect.top,
      top: headerRect.top,
      left: box.left,
      width: box.width,
      height: box.height,
      moved: false
    }
    sortDragRef.current = drag
    sortOrderRef.current = groups.map((item) => item.id)
    sortDropRef.current = null

    let lastX = event.clientX
    let lastY = event.clientY
    let inside = false
    let frame = 0

    // 指针贴近边栏上下边缘时持续滚动
    const autoScroll = (): void => {
      const current = sortDragRef.current
      if (!sheet || !current) return
      const rect = sheet.getBoundingClientRect()
      const edge = 30
      let delta = 0
      if (lastY < rect.top + edge) delta = -Math.ceil((rect.top + edge - lastY) / 4)
      else if (lastY > rect.bottom - edge) delta = Math.ceil((lastY - rect.bottom + edge) / 4)
      if (delta !== 0) {
        sheet.scrollTop += delta
        if (inside) applySortDrop(sortDropAt(lastY))
      }
      frame = requestAnimationFrame(autoScroll)
    }

    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== drag.pointerId) return
      const current = sortDragRef.current
      if (!current) return
      lastX = moveEvent.clientX
      lastY = moveEvent.clientY

      if (!current.moved) {
        const far =
          Math.abs(moveEvent.clientY - current.startY) >= 4 ||
          Math.abs(moveEvent.clientX - current.startX) >= 4
        if (!far) return
        current.moved = true
        suppressSortClick.current = true
        setSortDragId(current.id)
        setSortHeight(current.height)
        setSortGhost({
          group,
          count,
          collapsed: group.collapsed,
          left: current.left,
          top: current.top,
          width: current.width
        })
        requestAnimationFrame(() => {
          const active = sortDragRef.current
          const ghost = sortGhostRef.current
          if (ghost && active) {
            ghost.style.setProperty('--drag-y', `${lastY - active.offsetY - active.top}px`)
          }
        })
        frame = requestAnimationFrame(autoScroll)
      }

      moveEvent.preventDefault()
      const ghost = sortGhostRef.current
      if (ghost) {
        ghost.style.setProperty('--drag-y', `${moveEvent.clientY - current.offsetY - current.top}px`)
      }

      inside = pointerInSheet(lastX, lastY)
      applySortDrop(inside ? sortDropAt(lastY) : null)
    }

    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frame) cancelAnimationFrame(frame)

      const current = sortDragRef.current
      sortDragRef.current = null
      const drop = sortDropRef.current
      sortDropRef.current = null
      setSortDragId('')
      setSortHeight(0)
      setSortGhost(null)
      setSortDrop(null)
      if (!current?.moved) return
      setRailSticky(true)

      window.setTimeout(() => {
        suppressSortClick.current = false
      }, 0)

      if (!drop) return
      const others = sortOrderRef.current.filter((id) => id !== current.id)
      const at = others.indexOf(drop.id)
      if (at < 0) return
      const insertAt = drop.edge === 'before' ? at : at + 1
      const next = [...others]
      next.splice(insertAt, 0, current.id)
      if (next.join('|') === sortOrderRef.current.join('|')) return

      setGroups((previous) => {
        const byId = new Map(previous.map((item) => [item.id, item]))
        return next
          .map((id) => byId.get(id))
          .filter((item): item is AppGroup => Boolean(item))
      })
      void invoke<AppGroup[]>('reorderGroups', { ids: next })
        .then((list) => setGroups(list))
        .catch((error) => {
          setStatus(error instanceof Error ? error.message : '分组排序保存失败')
          void invoke<AppGroup[]>('listGroups')
            .then((list) => setGroups(list))
            .catch(() => undefined)
        })
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  /** 在指定范围内按指针位置调整顺序，其余范围的顺序保持不变 */
  const moveDragTo = (pointerY: number, scopeId: string): void => {
    const sheet = listRef.current
    const drag = dragRef.current
    if (!sheet || !drag) return

    const selector = scopeId
      ? `.app-group[data-group-id="${scopeId}"] .list-item`
      : '.list-item[data-group-id=""]'
    const nodes = Array.from(sheet.querySelectorAll<HTMLElement>(selector))
    const ids = nodes.map((node) => node.dataset.id ?? '').filter(Boolean)
    if (ids.length < 2 || !ids.includes(drag.id)) return

    const others = nodes.filter((node) => node.dataset.id !== drag.id)
    let insertAt = others.length
    for (let index = 0; index < others.length; index += 1) {
      const box = others[index].getBoundingClientRect()
      if (pointerY < box.top + box.height / 2) {
        insertAt = index
        break
      }
    }

    const nextScope = ids.filter((id) => id !== drag.id)
    nextScope.splice(insertAt, 0, drag.id)
    if (nextScope.join('|') === ids.join('|')) return

    const scoped = new Set(ids)
    let cursor = 0
    const nextGlobal = appsOrderRef.current.map((id) =>
      scoped.has(id) ? nextScope[cursor++] : id
    )
    if (nextGlobal.join('|') === appsOrderRef.current.join('|')) return

    appsOrderRef.current = nextGlobal
    dragOrderRef.current = nextGlobal
    setApps((previous) => {
      const byId = new Map(previous.map((app) => [app.id, app]))
      return nextGlobal
        .map((id) => byId.get(id))
        .filter((app): app is WebApp => Boolean(app))
    })
  }

  const beginItemDrag = (event: ReactPointerEvent<HTMLDivElement>, app: WebApp): void => {
    if (event.button !== 0) return
    const item = event.currentTarget
    const rect = item.getBoundingClientRect()
    const drag = {
      id: app.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetY: event.clientY - rect.top,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      moved: false
    }
    dragRef.current = drag
    appsOrderRef.current = apps.map((entry) => entry.id)
    dragOrderRef.current = [...appsOrderRef.current]
    initialOrderRef.current = dragOrderRef.current.join('|')
    dropGroupRef.current = ''
    setDropGroupId('')

    const ownGroup = groupIdOf(app)
    let scope = ownGroup
    let canReorder = true
    let lastY = event.clientY
    let frame = 0

    // 指针贴近列表上下边缘时持续滚动
    const autoScroll = (): void => {
      const sheet = listRef.current
      if (!sheet || !dragRef.current) return
      const box = sheet.getBoundingClientRect()
      const edge = 30
      let delta = 0
      if (lastY < box.top + edge) delta = -Math.ceil((box.top + edge - lastY) / 4)
      else if (lastY > box.bottom - edge) delta = Math.ceil((lastY - box.bottom + edge) / 4)
      if (delta !== 0) {
        sheet.scrollTop += delta
        if (canReorder) moveDragTo(lastY, scope)
      }
      frame = requestAnimationFrame(autoScroll)
    }

    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== drag.pointerId) return
      const current = dragRef.current
      if (!current) return
      lastY = moveEvent.clientY
      if (!current.moved) {
        const far =
          Math.abs(moveEvent.clientY - current.startY) >= 4 ||
          Math.abs(moveEvent.clientX - current.startX) >= 4
        if (!far) return
        current.moved = true
        suppressClick.current = true
        setDragId(current.id)
        setDragGhost({
          app,
          left: current.left,
          top: current.top,
          width: current.width
        })
        requestAnimationFrame(() => {
          const active = dragRef.current
          const ghost = ghostRef.current
          if (ghost && active) {
            ghost.style.setProperty('--drag-y', `${lastY - active.offsetY - active.top}px`)
          }
        })
        frame = requestAnimationFrame(autoScroll)
      }
      moveEvent.preventDefault()
      const ghost = ghostRef.current
      if (ghost) {
        ghost.style.setProperty('--drag-y', `${moveEvent.clientY - current.offsetY - current.top}px`)
      }

      const hit = groupAtPoint(moveEvent.clientX, moveEvent.clientY)
      const targetGroup = hit.inside && hit.groupId !== ownGroup ? hit.groupId : ''
      if (targetGroup !== dropGroupRef.current) {
        dropGroupRef.current = targetGroup
        setDropGroupId(targetGroup)
      }
      canReorder = hit.inside && hit.groupId === ownGroup
      if (canReorder) {
        scope = ownGroup
        moveDragTo(moveEvent.clientY, scope)
      }
    }

    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frame) cancelAnimationFrame(frame)
      const current = dragRef.current
      dragRef.current = null
      const targetGroup = dropGroupRef.current
      dropGroupRef.current = ''
      setDragId('')
      setDragGhost(null)
      setDropGroupId('')
      if (!current?.moved) return
      setRailSticky(true)

      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)

      const persist = async (): Promise<void> => {
        try {
          if (dragOrderRef.current.join('|') !== initialOrderRef.current) {
            const list = await invoke<WebApp[]>('reorder', { ids: dragOrderRef.current })
            setApps(list)
          }
          if (targetGroup && targetGroup !== ownGroup) {
            await assignApp(app, targetGroup)
          }
        } catch (error) {
          setStatus(error instanceof Error ? error.message : '归类失败')
        }
      }
      void persist()
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  const requestRemove = (target?: WebApp): void => {
    const app = target ?? active
    if (!app) return
    setMenu(null)
    setDeleteWithData(false)
    setDeleting(app)
  }

  const confirmRemove = async (): Promise<void> => {
    if (!deleting) return
    const app = deleting
    setDeleting(null)
    const list = await invoke<WebApp[]>('remove', { id: app.id, deleteData: deleteWithData })
    setApps(list)
    setActiveId((current) => (current === app.id ? (list[0]?.id ?? '') : current))
    void refreshStorage()
    setStatus('已移除登记')
  }

  const clearData = async (): Promise<void> => {
    if (!active) return
    if (!window.confirm(`确定清空「${active.name}」的全部存储数据？`)) return
    await invoke('clearData', { id: active.id })
    await loadData(active.id)
    void refreshStorage()
    setStatus('数据已清空')
  }

  const removeKey = async (key: string): Promise<void> => {
    if (!active) return
    await invoke('applyOps', { id: active.id, ops: [{ op: 'remove', key }] })
    await loadData(active.id)
    setStatus(`已删除键：${key}`)
  }

  const exportAll = async (): Promise<void> => {
    const result = await invoke<{ savedTo: string | null; appCount: number }>('exportAll')
    setStatus(result.savedTo ? `已导出 ${result.appCount} 个应用 → ${result.savedTo}` : '已取消导出')
  }

  const exportActive = async (): Promise<void> => {
    if (!active) return
    const result = await invoke<{ savedTo: string | null; keyCount: number }>('exportOne', {
      id: active.id
    })
    setStatus(result.savedTo ? `已导出 ${result.keyCount} 个键 → ${result.savedTo}` : '已取消导出')
  }

  const openStorage = async (): Promise<void> => {
    const info = await invoke<StorageInfo>('openStorage')
    setStorage(info)
    setStatus(`已打开存储目录：${info.dir}`)
  }

  const chooseStorage = async (): Promise<void> => {
    const info = await invoke<StorageInfo | null>('chooseStorage')
    if (!info) return
    setStorage(info)
    await loadData(activeId)
    reload()
    setStatus(`存储目录已切换到 ${info.dir}，原有数据已复制`)
  }

  const resetStorage = async (): Promise<void> => {
    const info = await invoke<StorageInfo>('resetStorage')
    setStorage(info)
    await loadData(activeId)
    reload()
    setStatus(`存储目录已恢复默认：${info.dir}`)
  }

  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await paneRef.current?.requestFullscreen()
    } catch {
      setStatus('当前环境不支持全屏')
    }
  }

  const openRename = (app: WebApp, holdRail = false): void => {
    setRenameHoldsRail(holdRail)
    if (holdRail) setRailSticky(true)
    setRenaming(app)
    setRenameDraft(app.name)
  }

  const closeRename = (): void => {
    setRenaming(null)
    setRenameHoldsRail(false)
  }

  const commitRename = async (): Promise<void> => {
    if (!renaming) return
    const list = await invoke<WebApp[]>('rename', { id: renaming.id, name: renameDraft })
    setApps(list)
    const renamed = list.find((app) => app.id === renaming.id)
    if (renamed) setStatus(`已重命名为：${renamed.name}`)
    closeRename()
  }

  const railPinned = Boolean(
    menu ||
      groupMenu ||
      dragId ||
      sortDragId ||
      groupEditor ||
      deletingGroup ||
      assigning ||
      (renaming && renameHoldsRail)
  )
  const ungrouped = apps.filter((app) => !groupIdOf(app))

  const renderItem = (app: WebApp): JSX.Element => (
    <div
      key={app.id}
      data-id={app.id}
      data-group-id={groupIdOf(app)}
      className={`list-item${app.id === activeId ? ' active' : ''}${app.id === dragId ? ' is-dragging' : ''}`}
      onPointerDown={(event) => beginItemDrag(event, app)}
      onClick={() => {
        if (suppressClick.current) return
        setActiveId(app.id)
        setRailOpen(false)
        setRailSticky(false)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ app, x: event.clientX, y: event.clientY })
      }}
    >
      <div className="list-item-title">
        {app.name}
        {app.missing ? (
          <span className="tag" style={{ marginLeft: 6 }}>
            文件缺失
          </span>
        ) : null}
      </div>
      <div className="list-item-sub">{app.dir}</div>
    </div>
  )

  const dataKeys = Object.keys(data)
  const totalBytes = dataKeys.reduce((sum, key) => sum + byteLength(data[key]), 0)
  const errorCount = logs.filter((entry) => entry.level === 'error').length
  const warnCount = logs.length - errorCount

  return (
    <>
      <div className="toolbar">
        <button className="primary" onClick={() => void addApp()}>
          添加 HTML
        </button>
        <button onClick={() => void refresh()}>刷新列表</button>
        <div className="spacer" />
        <button className="ghost" onClick={() => void exportAll()}>
          导出全部数据
        </button>
      </div>

      <div className="toolbar storage-bar">
        <span className="storage-label">存储数据</span>
        <span className="storage-path mono" title={storage?.dir}>
          {storage ? storage.dir : '读取中…'}
        </span>
        <span className="dim">{storage ? `${storage.fileCount} 个文件` : ''}</span>
        <div className="spacer" />
        <button className="ghost" onClick={() => void openStorage()}>
          打开文件夹
        </button>
        <button className="ghost" onClick={() => void chooseStorage()}>
          更改目录
        </button>
        <button className="ghost" onClick={() => void resetStorage()}>
          恢复默认
        </button>
      </div>

      {status && <div className="banner info">{status}</div>}

      <div className="panes webapp-stage">
        <div
          ref={railRef}
          className={`app-rail${railOpen || railSticky || railPinned ? ' is-open' : ''}`}
          onMouseLeave={() => {
            setRailOpen(false)
            if (!railLocked) setRailSticky(false)
          }}
          onDragOver={handleDragOver}
          onDrop={(event) => void handleDrop(event)}
        >
          <button
            type="button"
            className="app-rail-trigger"
            title={`已登记 ${apps.length} 个页面`}
            aria-expanded={railOpen || railSticky || railPinned}
            onClick={() => {
              setRailSticky(false)
              setRailOpen((value) => !value)
            }}
          >
            <span className="app-rail-label">已登记</span>
            <span className="app-rail-count">{apps.length}</span>
          </button>

          <div className="app-rail-flyout">
            <div className="app-rail-sheet" ref={listRef}>
              <div className="list-pane-head">
                <span className="dim">已登记 {apps.length} 个页面</span>
                <button
                  type="button"
                  className="ghost small app-rail-newgroup"
                  title="新建分组"
                  onClick={() => openGroupEditor('create')}
                >
                  新建分组
                </button>
              </div>

              {groups.map((group) => {
                const members = apps.filter((app) => groupIdOf(app) === group.id)
                const sorting = sortDragId === group.id
                return (
                  <div
                    key={group.id}
                    data-group-id={group.id}
                    style={sorting ? { height: sortHeight } : undefined}
                    className={`app-group${group.collapsed ? ' is-collapsed' : ''}${dropGroupId === group.id ? ' is-drop-target' : ''}${sorting ? ' is-sorting' : ''}${sortDrop?.id === group.id ? ` is-drop-${sortDrop.edge}` : ''}`}
                  >
                    <button
                      type="button"
                      className="ghost app-group-head"
                      title={group.collapsed ? '展开分组' : '收起分组'}
                      aria-expanded={!group.collapsed}
                      onPointerDown={(event) => beginGroupSort(event, group, members.length)}
                      onClick={() => {
                        if (suppressSortClick.current) return
                        void toggleGroup(group)
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setGroupMenu({ group, x: event.clientX, y: event.clientY })
                      }}
                    >
                      <span
                        className={`app-group-caret${group.collapsed ? ' is-collapsed' : ''}`}
                        aria-hidden="true"
                      />
                      <span className="app-group-name">{group.name}</span>
                      <span className="app-group-count">{members.length}</span>
                    </button>

                    {!group.collapsed && (
                      <div className="app-group-body">
                        {members.map(renderItem)}
                        {!members.length && (
                          <div className="app-group-empty">空分组，拖动页面到这里归类</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {groups.length > 0 && ungrouped.length > 0 && (
                <div className="app-rail-divider">
                  <span>未分组</span>
                </div>
              )}

              {ungrouped.map(renderItem)}
              {!apps.length && <div className="empty">还没有登记页面</div>}
            </div>
          </div>
        </div>

        <div
          className="webapp-pane"
          ref={paneRef}
          onDragOver={handleDragOver}
          onDrop={(event) => void handleDrop(event)}
        >
          {active ? (
            <>
              <div className="webapp-head">
                <span className="mono" title={active.file}>
                  {active.file}
                </span>
                <div className="spacer" />
                <button className="ghost" onClick={reload}>
                  重新加载
                </button>
                <button
                  className={`ghost${autoReload ? ' is-on' : ''}`}
                  title="监控源文件，改动后自动刷新预览"
                  onClick={() => setAutoReload((value) => !value)}
                >
                  自动重载 {autoReload ? '开' : '关'}
                </button>
                <button className="ghost" onClick={() => void toggleFullscreen()}>
                  {fullscreen ? '退出全屏' : '全屏'}
                </button>
                <button className="ghost" onClick={() => openRename(active)}>
                  重命名
                </button>
                <button className="ghost" onClick={() => void invoke('reveal', { id: active.id })}>
                  打开源目录
                </button>
                <button className="ghost" onClick={() => setShowData((value) => !value)}>
                  查看数据 ({dataKeys.length})
                </button>
                <button className="ghost" onClick={() => void clearData()}>
                  清空数据
                </button>
                <button className="ghost" onClick={() => requestRemove()}>
                  移除
                </button>
              </div>

              {active.missing ? (
                <div className="empty">原文件已不存在，请移除登记或恢复到原路径。</div>
              ) : (
                <div className="frame-wrap" ref={frameRef}>
                  <iframe key={`${active.id}-${reloadKey}`} src={src} title={active.name} />
                </div>
              )}

              {!active.missing && (
                <>
                  <div className="console-bar">
                    <button className="ghost small" onClick={() => setLogOpen((value) => !value)}>
                      控制台 {logOpen ? '收起' : '展开'}
                    </button>
                    {errorCount > 0 && <span className="console-count error">ERR {errorCount}</span>}
                    {warnCount > 0 && <span className="console-count warn">WARN {warnCount}</span>}
                    <span className="spacer" />
                    {logs.length > 0 && (
                      <span className="dim">{formatClock(logs[logs.length - 1].at)}</span>
                    )}
                    <button className="ghost small" onClick={() => setLogs([])}>
                      清空
                    </button>
                  </div>

                  {logOpen && (
                    <div className="console-panel">
                      {logs.length ? (
                        logs.map((entry, index) => (
                          <div className={`log-entry ${entry.level}`} key={`${entry.at}-${index}`}>
                            <span className="log-time">{formatClock(entry.at)}</span>
                            <span className="log-level">
                              {entry.level === 'error' ? 'ERR' : 'WARN'}
                            </span>
                            <span className="log-text">{entry.message}</span>
                          </div>
                        ))
                      ) : (
                        <div className="dim">暂无输出</div>
                      )}
                    </div>
                  )}
                </>
              )}

              {showData && !immersive && (
                <div className="data-panel">
                  <div className="data-head">
                    <span className="dim">共 {dataKeys.length} 个键</span>
                    <span className="dim">{formatSize(totalBytes)}</span>
                    <span className="spacer" />
                    <button className="ghost small" onClick={() => void exportActive()}>
                      导出
                    </button>
                  </div>
                  {dataKeys.length ? (
                    dataKeys.map((key) => (
                      <div className="data-row" key={key}>
                        <span className="mono dim" title={key}>
                          {key}
                        </span>
                        <span className="mono" title={data[key]}>
                          {data[key]}
                        </span>
                        <span className="mono data-size">{formatSize(byteLength(data[key]))}</span>
                        <button className="ghost small" onClick={() => void removeKey(key)}>
                          删除
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="dim">暂无存储数据</div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="empty">从左侧选择一个页面，或先添加</div>
          )}
        </div>
      </div>

      {immersive && (
        <button
          type="button"
          className="webapp-restore"
          onClick={() => setImmersive(false)}
          title="退出沉浸模式（Esc）"
        >
          退出沉浸
        </button>
      )}

      {menu &&
        createPortal(
          <>
            <div
              className="menu-backdrop"
              onClick={() => setMenu(null)}
              onContextMenu={(event) => event.preventDefault()}
            />
            <div
              className="context-menu"
              style={{
                left: Math.max(8, Math.min(menu.x, window.innerWidth - 180)),
                top: Math.max(8, Math.min(menu.y, window.innerHeight - 130))
              }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                className="ghost"
                onClick={() => {
                  openRename(menu.app, true)
                  setMenu(null)
                }}
              >
                重命名
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setMenu(null)
                  setAssigning(menu.app)
                }}
              >
                归类到分组
              </button>
              <button className="ghost" onClick={() => requestRemove(menu.app)}>
                删除
              </button>
            </div>
          </>,
          document.body
        )}

      {groupMenu &&
        createPortal(
          <>
            <div
              className="menu-backdrop"
              onClick={() => setGroupMenu(null)}
              onContextMenu={(event) => event.preventDefault()}
            />
            <div
              className="context-menu"
              style={{
                left: Math.max(8, Math.min(groupMenu.x, window.innerWidth - 180)),
                top: Math.max(8, Math.min(groupMenu.y, window.innerHeight - 96))
              }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                className="ghost"
                onClick={() => openGroupEditor('rename', groupMenu.group)}
              >
                重命名分组
              </button>
              <button className="ghost" onClick={() => requestRemoveGroup(groupMenu.group)}>
                删除分组
              </button>
            </div>
          </>,
          document.body
        )}

      {dragId && createPortal(<div className="app-drag-layer" />, document.body)}

      {sortDragId && createPortal(<div className="app-drag-layer" />, document.body)}

      {sortGhost &&
        createPortal(
          <div
            ref={sortGhostRef}
            className="app-group-drag-ghost"
            style={{
              left: sortGhost.left,
              top: sortGhost.top,
              width: sortGhost.width,
              transform: 'translate3d(0, var(--drag-y), 0)'
            }}
          >
            <div className="app-group-head">
              <span
                className={`app-group-caret${sortGhost.collapsed ? ' is-collapsed' : ''}`}
                aria-hidden="true"
              />
              <span className="app-group-name">{sortGhost.group.name}</span>
              <span className="app-group-count">{sortGhost.count}</span>
            </div>
          </div>,
          document.body
        )}

      {dragGhost &&
        createPortal(
          <div
            ref={ghostRef}
            className="list-item app-drag-ghost"
            style={{
              left: dragGhost.left,
              top: dragGhost.top,
              width: dragGhost.width,
              transform: 'translate3d(0, var(--drag-y), 0)'
            }}
          >
            <div className="list-item-title">
              {dragGhost.app.name}
              {dragGhost.app.missing ? (
                <span className="tag" style={{ marginLeft: 6 }}>
                  文件缺失
                </span>
              ) : null}
            </div>
            <div className="list-item-sub">{dragGhost.app.dir}</div>
          </div>,
          document.body
        )}

      {renaming && (
        <div className="modal-backdrop" onClick={closeRename}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">重命名</div>
            <input
              value={renameDraft}
              autoFocus
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename()
              }}
            />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost" onClick={closeRename}>
                取消
              </button>
              <button className="primary" onClick={() => void commitRename()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {groupEditor && (
        <div className="modal-backdrop" onClick={closeGroupEditor}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">
              {groupEditor.mode === 'create' ? '新建分组' : '重命名分组'}
            </div>
            <input
              value={groupDraft}
              autoFocus
              placeholder="分组名称"
              onChange={(event) => setGroupDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitGroupEditor()
              }}
            />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost" onClick={closeGroupEditor}>
                取消
              </button>
              <button className="primary" onClick={() => void commitGroupEditor()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingGroup && (
        <div className="modal-backdrop" onClick={() => setDeletingGroup(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">删除分组</div>
            <div className="dim" style={{ lineHeight: 1.7 }}>
              确定删除分组「{deletingGroup.name}」？分组内的页面会移到未分组区域，不会被删除。
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost" onClick={() => setDeletingGroup(null)}>
                取消
              </button>
              <button className="primary" onClick={() => void confirmRemoveGroup()}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {assigning && (
        <div className="modal-backdrop" onClick={() => setAssigning(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">归类到分组</div>
            <div className="dim" style={{ lineHeight: 1.7 }}>
              选择「{assigning.name}」要放入的分组。
            </div>
            <div className="assign-list">
              <button
                type="button"
                className={`ghost assign-option${groupIdOf(assigning) ? '' : ' is-current'}`}
                onClick={() => void chooseGroupForApp(assigning, '')}
              >
                <span>未分组</span>
                <span className="dim">{groupIdOf(assigning) ? '移出分组' : '当前'}</span>
              </button>
              {groups.map((group) => {
                const current = groupIdOf(assigning) === group.id
                const count = apps.filter((app) => groupIdOf(app) === group.id).length
                return (
                  <button
                    key={group.id}
                    type="button"
                    className={`ghost assign-option${current ? ' is-current' : ''}`}
                    onClick={() => void chooseGroupForApp(assigning, group.id)}
                  >
                    <span>{group.name}</span>
                    <span className="dim">{current ? '当前' : `${count} 个页面`}</span>
                  </button>
                )
              })}
            </div>
            {!groups.length && (
              <div className="dim" style={{ marginTop: 8 }}>
                还没有分组，可先在侧边栏新建分组。
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost" onClick={() => setAssigning(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div className="modal-backdrop" onClick={() => setDeleting(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">删除登记</div>
            <div className="dim" style={{ lineHeight: 1.7 }}>
              确定删除「{deleting.name}」的登记？
            </div>
            <label className="row" style={{ marginTop: 12, gap: 8 }}>
              <input
                type="checkbox"
                checked={deleteWithData}
                onChange={(event) => setDeleteWithData(event.target.checked)}
              />
              <span className="dim">同时清空该页面的存储数据</span>
            </label>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost" onClick={() => setDeleting(null)}>
                取消
              </button>
              <button className="primary" onClick={() => void confirmRemove()}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
