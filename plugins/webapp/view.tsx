import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { usePlugin, formatSize } from '../../src/renderer/src/utils'
import { filePathOf } from '../../src/renderer/src/bridge'

interface WebApp {
  id: string
  name: string
  file: string
  dir: string
  addedAt: number
  missing: boolean
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
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [autoReload, setAutoReload] = useState<boolean>(readAutoReload)
  const [fullscreen, setFullscreen] = useState(false)
  const [railPinned, setRailPinned] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const paneRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const list = await invoke<WebApp[]>('list')
    setApps(list)
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
    setDragging(false)
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
    if (!dragging) setDragging(true)
  }

  const removeApp = async (): Promise<void> => {
    if (!active) return
    const deleteData = window.confirm(`删除「${active.name}」的登记，并同时清空它的存储数据？\n取消则保留数据。`)
    const list = await invoke<WebApp[]>('remove', { id: active.id, deleteData })
    setApps(list)
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

  const commitRename = async (): Promise<void> => {
    if (!renaming) return
    const list = await invoke<WebApp[]>('rename', { id: renaming.id, name: renameDraft })
    setApps(list)
    setRenaming(null)
  }

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
          className={`app-rail${railPinned ? ' is-pinned' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => void handleDrop(event)}
        >
          <button
            type="button"
            className="app-rail-trigger"
            title={`已登记 ${apps.length} 个页面`}
            aria-expanded={railPinned}
            onClick={() => setRailPinned((value) => !value)}
          >
            <span className="app-rail-label">已登记</span>
            <span className="app-rail-count">{apps.length}</span>
          </button>

          <div className="app-rail-flyout">
            <div className="app-rail-sheet">
              <div className="list-pane-head">
                <span className="dim">已登记 {apps.length} 个页面</span>
              </div>
              <div className={`drop-zone${dragging ? ' active' : ''}`}>
                拖入 .html 文件即可登记
              </div>
              {apps.map((app) => (
                <div
                  key={app.id}
                  className={`list-item${app.id === activeId ? ' active' : ''}`}
                  onClick={() => {
                    setActiveId(app.id)
                    setRailPinned(false)
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
              ))}
              {!apps.length && <div className="empty">还没有登记页面</div>}
            </div>
          </div>
        </div>

        <div
          className="webapp-pane"
          ref={paneRef}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragging(false)}
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
                <button
                  className="ghost"
                  onClick={() => {
                    setRenaming(active)
                    setRenameDraft(active.name)
                  }}
                >
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
                <button className="ghost" onClick={() => void removeApp()}>
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

      {renaming && (
        <div className="modal-backdrop" onClick={() => setRenaming(null)}>
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
              <button className="ghost" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button className="primary" onClick={() => void commitRename()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
