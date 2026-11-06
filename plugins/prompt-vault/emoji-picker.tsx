import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { EMOJI_GROUPS } from './emoji-data'
import './emoji-picker.css'

interface EmojiPickerProps {
  value: string
  onChange: (emoji: string) => void
}

interface PanelPosition {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
}

const PANEL_WIDTH = 336
const PANEL_HEIGHT = 320

export default function EmojiPicker({ value, onChange }: EmojiPickerProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [groupIndex, setGroupIndex] = useState(0)
  const [position, setPosition] = useState<PanelPosition | null>(null)

  const openPanel = (): void => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
    const below = window.innerHeight - rect.bottom
    const above = rect.top
    const openUp = below < PANEL_HEIGHT && above > below
    const available = openUp ? above - 12 : below - 12

    setPosition({
      left,
      width,
      maxHeight: Math.min(PANEL_HEIGHT, Math.max(180, available)),
      top: openUp ? undefined : rect.bottom + 6,
      bottom: openUp ? window.innerHeight - rect.top + 6 : undefined
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return

    const close = (): void => setOpen(false)
    const handlePointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const handleScroll = (event: Event): void => {
      const target = event.target as Node | null
      if (target && panelRef.current?.contains(target)) return
      setOpen(false)
    }

    window.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('keydown', handleKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open])

  useEffect(() => {
    if (open) gridRef.current?.scrollTo({ top: 0 })
  }, [groupIndex, open])

  const panelStyle: CSSProperties | undefined = position
    ? {
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        top: position.top,
        bottom: position.bottom
      }
    : undefined

  return (
    <div className="prompt-emoji-picker">
      <button
        ref={triggerRef}
        type="button"
        className="prompt-emoji-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) setOpen(false)
          else openPanel()
        }}
      >
        <span className={value ? 'prompt-emoji-trigger-value' : 'prompt-emoji-trigger-empty'}>
          {value || '选择图标'}
        </span>
        <span className="prompt-emoji-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            className="prompt-emoji-panel"
            style={panelStyle}
            role="dialog"
            aria-label="选择图标"
          >
            <div className="prompt-emoji-tabs" role="tablist">
              {EMOJI_GROUPS.map((group, index) => (
                <button
                  key={group.label}
                  type="button"
                  role="tab"
                  aria-selected={index === groupIndex}
                  className={`prompt-emoji-tab${index === groupIndex ? ' is-on' : ''}`}
                  onClick={() => setGroupIndex(index)}
                >
                  {group.label}
                </button>
              ))}
            </div>

            <div
              ref={gridRef}
              className="prompt-emoji-grid"
              role="listbox"
              aria-label={`${EMOJI_GROUPS[groupIndex].label}图标`}
            >
              {EMOJI_GROUPS[groupIndex].emojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={emoji === value}
                  className={`prompt-emoji-cell${emoji === value ? ' is-on' : ''}`}
                  onClick={() => {
                    onChange(emoji)
                    setOpen(false)
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>

            <div className="prompt-emoji-foot">
              <button
                type="button"
                className="prompt-emoji-clear"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
              >
                清除图标
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
