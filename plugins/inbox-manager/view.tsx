import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePlugin, formatSize, formatTime } from '../../src/renderer/src/utils'

interface InboxRow {
  path: string
  drive: string
  name: string
  modified: number
  fileCount: number | null
  totalSize: number | null
  note: string
  pinned: boolean
}

interface SearchResult {
  rows: InboxRow[]
  source: 'everything' | 'fallback'
  message: string
  esPath: string
}

interface Entry {
  name: string
  isDir: boolean
  size: number
  modified: number
}

type SortKey = 'path' | 'modified' | 'fileCount' | 'totalSize'

export default function InboxView(): JSX.Element {
  const { invoke } = usePlugin('inbox-manager')
  const [rows, setRows] = useState<InboxRow[]>([])
  const [source, setSource] = useState<'everything' | 'fallback'>('everything')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [exact, setExact] = useState(true)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string>('')
  const [entries, setEntries] = useState<{ items: Entry[]; total: number } | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('modified')
  const [asc, setAsc] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [esPath, setEsPath] = useState('')
  const [roots, setRoots] = useState('')
  const [diag, setDiag] = useState('')
  const [esPathUsed, setEsPathUsed] = useState('')
  const [noteTarget, setNoteTarget] = useState<InboxRow | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const statQueue = useRef<Set<string>>(new Set())

  const runSearch = useCallback(async () => {
    setLoading(true)
    setEntries(null)
    setSelected('')
    statQueue.current.clear()
    try {
      const result = await invoke<SearchResult>('search', { exact })
      setRows(result.rows)
      setSource(result.source)
      setMessage(result.message)
      setEsPathUsed(result.esPath ?? '')
      void fillStats(result.rows)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exact, invoke])

  const fillStats = useCallback(
    async (list: InboxRow[]) => {
      for (const row of list) {
        if (statQueue.current.has(row.path)) continue
        statQueue.current.add(row.path)
        try {
          const stats = await invoke<{ count: number; size: number }>('statFolder', { path: row.path })
          setRows((current) =>
            current.map((item) =>
              item.path === row.path
                ? { ...item, fileCount: stats.count, totalSize: stats.size }
                : item
            )
          )
        } catch {
          setRows((current) =>
            current.map((item) =>
              item.path === row.path ? { ...item, fileCount: -1, totalSize: -1 } : item
            )
          )
        }
      }
    },
    [invoke]
  )

  useEffect(() => {
    void runSearch()
    void invoke<{ exactMatch: boolean; esPath: string; extraRoots: string[] }>('getSettings').then(
      (settings) => {
        setExact(settings.exactMatch)
        setEsPath(settings.esPath)
        setRoots(settings.extraRoots.join('\n'))
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selected) return
    void invoke<{ items: Entry[]; total: number }>('listEntries', { path: selected, limit: 200 })
      .then(setEntries)
      .catch(() => setEntries(null))
  }, [selected, invoke])

  const visible = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    const list = keyword ? rows.filter((row) => row.path.toLowerCase().includes(keyword)) : rows.slice()
    const dir = asc ? 1 : -1
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned)
      if (sortKey === 'path') return a.path.localeCompare(b.path) * dir
      const av = a[sortKey] ?? -1
      const bv = b[sortKey] ?? -1
      return (Number(av) - Number(bv)) * dir
    })
    return list
  }, [rows, filter, sortKey, asc])

  const openFolder = async (target: string): Promise<void> => {
    try {
      await invoke('openFolder', { path: target })
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const togglePin = async (row: InboxRow): Promise<void> => {
    await invoke('setPinned', { path: row.path, pinned: !row.pinned })
    setRows((current) =>
      current.map((item) => (item.path === row.path ? { ...item, pinned: !item.pinned } : item))
    )
  }

  const editNote = (row: InboxRow): void => {
    setNoteTarget(row)
    setNoteDraft(row.note)
  }

  const commitNote = async (): Promise<void> => {
    if (!noteTarget) return
    const note = noteDraft
    await invoke('setNote', { path: noteTarget.path, note })
    setRows((current) => current.map((item) => (item.path === noteTarget.path ? { ...item, note } : item)))
    setNoteTarget(null)
  }

  const runDiagnose = async (): Promise<void> => {
    const result = await invoke<{ ok: boolean; esPath: string; message: string }>('diagnose')
    setDiag(`${result.ok ? '✓' : '✗'} ${result.message}${result.esPath ? `（${result.esPath}）` : ''}`)
    if (result.esPath) setEsPath(result.esPath)
  }

  const saveSettings = async (): Promise<void> => {
    await invoke('setSettings', {
      esPath,
      exactMatch: exact,
      extraRoots: roots
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    })
    setShowSettings(false)
    void runSearch()
  }

  const header = (key: SortKey, label: string): JSX.Element => (
    <th
      onClick={() => {
        if (sortKey === key) setAsc(!asc)
        else {
          setSortKey(key)
          setAsc(false)
        }
      }}
    >
      {label}
      {sortKey === key ? (asc ? ' ↑' : ' ↓') : ''}
    </th>
  )

  const selectedRow = rows.find((row) => row.path === selected)

  return (
    <>
      <div className="toolbar">
        <button className="primary" onClick={() => void runSearch()} disabled={loading}>
          {loading ? '搜索中…' : '刷新'}
        </button>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={exact}
            style={{ width: 'auto' }}
            onChange={(e) => setExact(e.target.checked)}
          />
          <span className="dim">精确匹配</span>
        </label>
        <input
          placeholder="过滤路径…"
          value={filter}
          style={{ maxWidth: 260 }}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="spacer" />
        <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
          设置
        </button>
      </div>

      {showSettings && (
        <div className="banner info">
          <div className="form-grid">
            <div className="field full">
              <label>es.exe 路径（留空则从 PATH 和默认安装目录查找）</label>
              <input value={esPath} onChange={(e) => setEsPath(e.target.value)} placeholder="C:\Program Files\Everything\es.exe" />
            </div>
            <div className="field full">
              <label>降级扫描根目录（每行一个，仅在 Everything 不可用时生效）</label>
              <textarea rows={3} value={roots} onChange={(e) => setRoots(e.target.value)} placeholder={'D:\\\nE:\\'} />
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => void runDiagnose()}>检测 Everything</button>
            <button className="primary" onClick={() => void saveSettings()}>
              保存并重新搜索
            </button>
            {diag && <span className="dim">{diag}</span>}
          </div>
        </div>
      )}

      {message && <div className="banner">{message}</div>}

      <div className="content">
        <div className="split">
          <div className="table-wrap">
            <table>
              <colgroup>
                <col style={{ width: 30 }} />
                <col />
                <col style={{ width: 62 }} />
                <col style={{ width: 148 }} />
                <col style={{ width: 84 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 150 }} />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  {header('path', '路径')}
                  <th>盘</th>
                  {header('modified', '修改时间')}
                  {header('fileCount', '文件数')}
                  {header('totalSize', '大小')}
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.path}
                    className={row.path === selected ? 'selected' : ''}
                    onClick={() => setSelected(row.path)}
                    onDoubleClick={() => void openFolder(row.path)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setSelected(row.path)
                      setMenu({ path: row.path, x: e.clientX, y: e.clientY })
                    }}
                    title={row.path}
                  >
                    <td>{row.pinned ? '★' : ''}</td>
                    <td className="mono">{row.path}</td>
                    <td>{row.drive}</td>
                    <td>{formatTime(row.modified)}</td>
                    <td>{row.fileCount === null ? <span className="skeleton" /> : row.fileCount < 0 ? 'N/A' : row.fileCount}</td>
                    <td>{row.totalSize === null ? <span className="skeleton" /> : row.totalSize < 0 ? 'N/A' : formatSize(row.totalSize)}</td>
                    <td className="dim">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && !loading && (
              <div className="empty">
                {rows.length ? '过滤后没有匹配项' : '没有找到 inbox 文件夹'}
              </div>
            )}
          </div>

          <div className="preview">
            {selectedRow ? (
              <>
                <div className="preview-head">
                  <span className="mono">{selectedRow.path}</span>
                  <button className="ghost" onClick={() => void openFolder(selectedRow.path)}>
                    打开
                  </button>
                  <button className="ghost" onClick={() => void togglePin(selectedRow)}>
                    {selectedRow.pinned ? '取消置顶' : '置顶'}
                  </button>
                  <button className="ghost" onClick={() => void editNote(selectedRow)}>
                    备注
                  </button>
                  <button
                    className="ghost"
                    onClick={() => void navigator.clipboard.writeText(selectedRow.path)}
                  >
                    复制路径
                  </button>
                </div>
                {entries ? (
                  <>
                    {entries.items.map((item) => (
                      <div className="preview-row" key={item.name}>
                        <span className="mono">
                          {item.isDir ? '▸ ' : '  '}
                          {item.name}
                        </span>
                        <span className="dim">{item.isDir ? '' : formatSize(item.size)}</span>
                        <span className="dim">{formatTime(item.modified)}</span>
                      </div>
                    ))}
                    {entries.total > entries.items.length && (
                      <div className="preview-row dim">… 共 {entries.total} 项</div>
                    )}
                  </>
                ) : (
                  <div className="dim">加载中…</div>
                )}
              </>
            ) : (
              <div className="dim">选中一行查看内容预览</div>
            )}
          </div>
        </div>
      </div>

      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()} />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            <button onClick={() => { void openFolder(menu.path); setMenu(null) }}>打开文件夹</button>
            <button onClick={() => { void navigator.clipboard.writeText(menu.path); setMenu(null) }}>
              复制路径
            </button>
            <button onClick={() => { void togglePin(rows.find((r) => r.path === menu.path)!); setMenu(null) }}>
              {rows.find((r) => r.path === menu.path)?.pinned ? '取消置顶' : '置顶'}
            </button>
            <button
              onClick={() => {
                const row = rows.find((r) => r.path === menu.path)
                if (row) editNote(row)
                setMenu(null)
              }}
            >
              编辑备注
            </button>
          </div>
        </>
      )}

      {noteTarget && (
        <div className="modal-backdrop" onClick={() => setNoteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">备注</div>
            <div className="dim mono" style={{ marginBottom: 8, wordBreak: 'break-all' }}>
              {noteTarget.path}
            </div>
            <textarea rows={5} value={noteDraft} autoFocus onChange={(e) => setNoteDraft(e.target.value)} />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost" onClick={() => setNoteTarget(null)}>
                取消
              </button>
              <button className="primary" onClick={() => void commitNote()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="status">
        <span>
          共 {rows.length} 个 · 显示 {visible.length}
        </span>
        <span className={source === 'everything' ? 'dot-ok' : 'dot-warn'}>
          {source === 'everything' ? '索引来源：Everything' : '索引来源：目录遍历（降级）'}
        </span>
        {esPathUsed && <span className="dim mono">{esPathUsed}</span>}
      </div>
    </>
  )
}
