import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { api } from './bridge'
import { pluginIcon } from './icons'
import SkinPicker from './SkinPicker'
import WhirlAscii from './skins/WhirlAscii'
import TitleBar from './TitleBar'
import type { PluginManifest } from '../../shared/types'

/** 约定：plugins/<id>/view.tsx 默认导出工具页面组件 */
const views = import.meta.glob<{ default: ComponentType }>('../../../plugins/*/view.tsx', {
  eager: true
})

function resolveView(pluginId: string): ComponentType | undefined {
  const entry = views[`../../../plugins/${pluginId}/view.tsx`]
  return entry?.default
}

const pad = (value: number): string => String(value).padStart(2, '0')

const SIDEBAR_KEY = 'fiffel:sidebar'
const LEGACY_SIDEBAR_KEY = 'toolbox:sidebar'
const ORDER_KEY = 'fiffel:plugin-order'

function readCollapsed(): boolean {
  try {
    return (
      (localStorage.getItem(SIDEBAR_KEY) ?? localStorage.getItem(LEGACY_SIDEBAR_KEY)) ===
      'collapsed'
    )
  } catch {
    return false
  }
}

function readOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 按保存的顺序排列，未记录的新插件排在末尾并保持原有相对顺序 */
function applyOrder(list: PluginManifest[], order: string[]): PluginManifest[] {
  if (!order.length) return list
  const rank = new Map(order.map((id, index) => [id, index]))
  const indexed = list.map((plugin, index) => ({ plugin, index }))
  indexed.sort((a, b) => {
    const ra = rank.get(a.plugin.id) ?? Number.MAX_SAFE_INTEGER
    const rb = rank.get(b.plugin.id) ?? Number.MAX_SAFE_INTEGER
    return ra === rb ? a.index - b.index : ra - rb
  })
  return indexed.map((entry) => entry.plugin)
}

/** 图标底色轮换，按插件 id 计算，排序变化时配色不变 */
function toneOf(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 9973
  }
  return hash % 4
}

export default function App(): JSX.Element {
  const [allPlugins, setAllPlugins] = useState<PluginManifest[]>([])
  const [order, setOrder] = useState<string[]>(readOrder)
  const [active, setActive] = useState('')
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [dragId, setDragId] = useState('')
  const navRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    void api.listPlugins().then((list) => {
      setAllPlugins(list)
      setActive((current) => current || list[0]?.id || '')
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded')
      localStorage.removeItem(LEGACY_SIDEBAR_KEY)
    } catch {
      /* 隐私模式下忽略持久化失败 */
    }
  }, [collapsed])

  const plugins = useMemo(() => applyOrder(allPlugins, order), [allPlugins, order])

  const activeIndex = Math.max(
    0,
    plugins.findIndex((plugin) => plugin.id === active)
  )
  const activePlugin = plugins[activeIndex]
  const ActiveView = active ? resolveView(active) : undefined

  const commitOrder = (next: string[]): void => {
    setOrder(next)
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    } catch {
      /* 隐私模式下忽略持久化失败 */
    }
  }

  /** 以其余条目中点为界，指针越过哪个中点就换到哪个位置 */
  const moveDrag = (pointerY: number): void => {
    const nav = navRef.current
    const drag = dragRef.current
    if (!nav || !drag) return

    const nodes = Array.from(nav.querySelectorAll<HTMLElement>('.nav-item'))
    const ids = nodes.map((node) => node.dataset.id ?? '').filter(Boolean)
    if (ids.length < 2) return

    const others = nodes.filter((node) => node.dataset.id !== drag.id)
    let insertAt = others.length
    for (let index = 0; index < others.length; index += 1) {
      const box = others[index].getBoundingClientRect()
      if (pointerY < box.top + box.height / 2) {
        insertAt = index
        break
      }
    }

    const without = ids.filter((id) => id !== drag.id)
    without.splice(insertAt, 0, drag.id)
    if (without.join('|') !== ids.join('|')) commitOrder(without)
  }

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string): void => {
    if (event.button !== 0) return
    const startX = event.clientX
    const startY = event.clientY
    const pointerId = event.pointerId
    dragRef.current = { id, startX, startY, moved: false }

    let lastY = startY
    let frame = 0

    // 指针贴近列表上下边缘时连续滚动，避免长列表拖不到末尾
    const autoScroll = (): void => {
      const nav = navRef.current
      if (!nav || !dragRef.current) return
      const box = nav.getBoundingClientRect()
      const edge = 32
      if (lastY < box.top + edge) {
        nav.scrollTop -= Math.ceil((box.top + edge - lastY) / 4)
      } else if (lastY > box.bottom - edge) {
        nav.scrollTop += Math.ceil((lastY - box.bottom + edge) / 4)
      }
      frame = requestAnimationFrame(autoScroll)
    }

    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      const drag = dragRef.current
      if (!drag) return
      lastY = moveEvent.clientY
      if (!drag.moved) {
        const far = Math.abs(moveEvent.clientY - startY) >= 4 || Math.abs(moveEvent.clientX - startX) >= 4
        if (!far) return
        drag.moved = true
        suppressClick.current = true
        setDragId(id)
        frame = requestAnimationFrame(autoScroll)
      }
      moveEvent.preventDefault()
      moveDrag(moveEvent.clientY)
    }

    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frame) cancelAnimationFrame(frame)
      const moved = dragRef.current?.moved ?? false
      dragRef.current = null
      setDragId('')
      if (moved) {
        window.setTimeout(() => {
          suppressClick.current = false
        }, 0)
      }
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  return (
    <div className="shell">
      <TitleBar />
      <div className={`app${collapsed ? ' is-collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-row">
              <div className="brand-word" data-text="Fiffel">
                Fiffel
              </div>
              <button
                className="sidebar-toggle"
                onClick={() => setCollapsed((value) => !value)}
                title={collapsed ? '展开侧边栏' : '收起侧边栏'}
                aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
                aria-expanded={!collapsed}
              >
                {collapsed ? '»' : '«'}
              </button>
            </div>
            <div className="brand-rule" />
            <div className="brand-meta">FIFFEL / LOCAL</div>
          </div>

          <nav
            className={`nav${dragId ? ' is-sorting' : ''}`}
            aria-label="插件列表"
            ref={navRef}
          >
            {plugins.map((plugin, index) => {
              const Icon = pluginIcon(plugin.icon)
              return (
                <button
                  key={plugin.id}
                  type="button"
                  data-id={plugin.id}
                  data-tone={toneOf(plugin.id)}
                  className={[
                    'nav-item',
                    plugin.id === active ? 'active' : '',
                    plugin.id === dragId ? 'is-dragging' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ animationDelay: `${60 + index * 45}ms` }}
                  onPointerDown={(event) => beginDrag(event, plugin.id)}
                  onClick={() => {
                    if (suppressClick.current) return
                    setActive(plugin.id)
                  }}
                  title={collapsed ? plugin.name : (plugin.description ?? plugin.name)}
                >
                  <span className="nav-tile" aria-hidden="true">
                    {Icon ? (
                      <Icon size={17} strokeWidth={1.7} />
                    ) : (
                      plugin.name.slice(0, 1)
                    )}
                  </span>
                  <span className="nav-text">
                    <span className="nav-label">{plugin.name}</span>
                    <span className="nav-desc">{plugin.description ?? '本地工具'}</span>
                  </span>
                  <span className="nav-grip" aria-hidden="true" />
                </button>
              )
            })}
            {!plugins.length && <p className="nav-empty">未发现插件</p>}
          </nav>

          <div className="sidebar-foot">
            <span className="foot-status">本地存储 · 无云同步</span>
            <SkinPicker />
          </div>
        </aside>

        <main className="main">
          <WhirlAscii />
          <div className="pasture-stars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <header className="plate">
            <div className="plate-row">
              <span className="plate-kicker">
                Section {pad(activeIndex + 1)} / {pad(plugins.length)}
              </span>
              {activePlugin?.version && (
                <span className="plate-version">v{activePlugin.version}</span>
              )}
            </div>
            <h1>{activePlugin?.name ?? 'Fiffel'}</h1>
            <p>{activePlugin?.description ?? '在 plugins 目录新增工具即可扩展'}</p>
            <span className="plate-rule" />
          </header>

          <div className="page" key={active || 'empty'}>
            {ActiveView ? (
              <ActiveView />
            ) : (
              <div className="empty">
                <span className="empty-mark" aria-hidden="true" />
                <span>在 plugins 目录新增工具即可扩展</span>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
