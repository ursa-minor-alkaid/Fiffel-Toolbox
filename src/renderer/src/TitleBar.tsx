import { useEffect, useState } from 'react'

/** 自绘标题栏，替代系统边框，使皮肤可以覆盖整窗 */
export default function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    const sync = async (): Promise<void> => {
      const state = await window.fiffel.windowState().catch(() => null)
      if (alive && state) setMaximized(state.maximized)
    }
    void sync()
    const off = window.fiffel.onWindowState((state) => setMaximized(state.maximized))
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <div
      className="titlebar"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('.titlebar-controls')) return
        void window.fiffel.windowAction('maximize')
      }}
    >
      <span className="titlebar-title">Fiffel</span>
      <div className="titlebar-drag" />
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          title="最小化"
          aria-label="最小化"
          onClick={() => void window.fiffel.windowAction('minimize')}
        >
          <span className="titlebar-glyph minimize" />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void window.fiffel.windowAction('maximize')}
        >
          <span className={`titlebar-glyph ${maximized ? 'restore' : 'maximize'}`} />
        </button>
        <button
          type="button"
          className="titlebar-btn close"
          title="关闭"
          aria-label="关闭"
          onClick={() => void window.fiffel.windowAction('close')}
        >
          <span className="titlebar-glyph close" />
        </button>
      </div>
    </div>
  )
}
