import { useEffect, useRef, useState } from 'react'
import { SKINS, applySkin, findSkin, readStoredSkin, type SkinId } from './skins'

export default function SkinPicker(): JSX.Element {
  const [skin, setSkin] = useState<SkinId>(readStoredSkin)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    applySkin(skin)
  }, [skin])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const current = findSkin(skin)

  const choose = (id: SkinId): void => {
    setSkin(id)
    setOpen(false)
  }

  return (
    <div className="skin-switch" ref={rootRef}>
      <button
        className="skin-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="更换界面皮肤"
      >
        <span className="skin-trigger-name">
          <span
            className="skin-swatch"
            style={{
              background: current.swatch[0],
              borderColor: current.swatch[1],
              boxShadow: `inset 0 0 0 3px ${current.swatch[2]}`
            }}
          />
          {current.name}
        </span>
        <span className="skin-trigger-caret">{open ? '▾' : '▴'}</span>
      </button>

      {open && (
        <div className="skin-menu" role="listbox" aria-label="皮肤列表">
          {SKINS.map((item) => (
            <button
              key={item.id}
              className={`skin-menu-item${item.id === skin ? ' active' : ''}`}
              role="option"
              aria-selected={item.id === skin}
              onClick={() => choose(item.id)}
              title={item.hint}
            >
              <span
                className="skin-swatch"
                style={{
                  background: item.swatch[0],
                  borderColor: item.swatch[1],
                  boxShadow: `inset 0 0 0 3px ${item.swatch[2]}`
                }}
              />
              <span className="skin-menu-text">
                <span className="skin-menu-name">{item.name}</span>
                <span className="skin-menu-hint">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
