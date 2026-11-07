import { useEffect, useRef } from 'react'
import { appleAngle, createAppleRenderer, type AppleRenderer } from './whirlApple.mjs'
import { createFieldRenderer, type FieldRenderer } from './whirlAsciiField.mjs'

const BASE_FONT_SIZE = 10
const CHAR_SCALE = 2 / 3
const FONT_SIZE = BASE_FONT_SIZE * CHAR_SCALE
const LINE_RATIO = 1.08
const APPLE_SCALE = 1.6
const FLOAT_DISTANCE = 7
const FLOAT_SPEED = 0.84
const MAX_DPR = 1.25
const MAX_COLS = 120
const MAX_ROWS = 92
const LOW_MAX_COLS = 88
const LOW_MAX_ROWS = 58
const FONT_FAMILY =
  "'SFMono-Regular', 'JetBrains Mono', 'Consolas', 'Liberation Mono', 'Courier New', monospace"

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 读取旋白主题定义的字符颜色，未定义时回落到同一墨色。 */
function resolveInk(): string {
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue('--ascii-ink')
  return /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim() : '#1b1b19'
}

function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha.toFixed(3)})`
}

/** letterSpacing 属于较新的 Canvas 文本属性，用可选写入保持兼容。 */
function setLetterSpacing(context: CanvasRenderingContext2D, value: string): void {
  ;(context as unknown as { letterSpacing: string }).letterSpacing = value
}

/** 旋白主区的全屏 ASCII 场景：底层字符场加三维缺口苹果，其余皮肤保持零开销 */
export default function WhirlAscii(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLCanvasElement>(null)
  const appleRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const fieldCanvas = fieldRef.current
    const appleCanvas = appleRef.current
    if (!host || !fieldCanvas || !appleCanvas) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const lowPower = (navigator.hardwareConcurrency || 8) <= 4
    const appleInterval = lowPower ? 1000 / 15 : 1000 / 20
    const fieldInterval = lowPower ? 1000 / 5 : 1000 / 8
    const maxCols = lowPower ? LOW_MAX_COLS : MAX_COLS
    const maxRows = lowPower ? LOW_MAX_ROWS : MAX_ROWS
    const fieldStepCols = lowPower ? 4 : 3
    const fieldStepRows = lowPower ? 3 : 2

    let field: FieldRenderer | null = null
    let apple: AppleRenderer | null = null
    let fieldCtx: CanvasRenderingContext2D | null = null
    let appleCtx: CanvasRenderingContext2D | null = null

    let viewWidth = 0
    let viewHeight = 0
    let charW = 4
    let lineH = FONT_SIZE * LINE_RATIO
    let ink = '#1b1b19'

    let appleX = 0
    let appleY = 0
    let appleW = 0
    let appleH = 0

    let frame = 0
    let active = false
    let lastApple = 0
    let lastField = 0
    let startedAt = 0

    const prepare = (canvas: HTMLCanvasElement): CanvasRenderingContext2D | null => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const width = Math.max(1, Math.round(viewWidth * dpr))
      const height = Math.max(1, Math.round(viewHeight * dpr))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const context = canvas.getContext('2d')
      if (!context) return null
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      return context
    }

    const clearAll = (): void => {
      if (fieldCtx) fieldCtx.clearRect(0, 0, viewWidth, viewHeight)
      if (appleCtx) appleCtx.clearRect(0, 0, viewWidth, viewHeight)
    }

    const measure = (): void => {
      const rect = host.getBoundingClientRect()
      viewWidth = rect.width
      viewHeight = rect.height
      if (viewWidth < 48 || viewHeight < 48) {
        fieldCtx = prepare(fieldCanvas)
        appleCtx = prepare(appleCanvas)
        field = null
        apple = null
        clearAll()
        return
      }

      fieldCtx = prepare(fieldCanvas)
      appleCtx = prepare(appleCanvas)
      if (!fieldCtx || !appleCtx) {
        field = null
        apple = null
        return
      }

      appleCtx.font = `${FONT_SIZE}px ${FONT_FAMILY}`
      setLetterSpacing(appleCtx, '0px')
      charW = Math.max(2, appleCtx.measureText('0000000000').width / 10)
      lineH = FONT_SIZE * LINE_RATIO

      const columns = Math.max(8, Math.floor(viewWidth / charW))
      const rows = Math.max(6, Math.floor(viewHeight / lineH))
      field = createFieldRenderer({
        columns,
        rows,
        stepCols: fieldStepCols,
        stepRows: fieldStepRows,
        charAspect: charW / lineH
      })

      // 苹果沿用 1.6 倍目标尺寸，并按安全边距限制在窗口内。
      const shortSide = Math.min(viewWidth, viewHeight)
      const margin = Math.min(28, Math.max(12, shortSide * 0.04))
      const availableWidth = Math.max(1, viewWidth - margin * 2)
      const availableHeight = Math.max(1, viewHeight - margin * 2 - FLOAT_DISTANCE)
      let targetHeight = shortSide * 0.76 * APPLE_SCALE
      let targetWidth = targetHeight * 1.08
      const fit = Math.min(1, availableWidth / targetWidth, availableHeight / targetHeight)
      targetHeight *= fit
      targetWidth *= fit

      const gridCols = Math.max(24, Math.min(maxCols, Math.floor(targetWidth / charW)))
      const gridRows = Math.max(12, Math.min(maxRows, Math.floor(targetHeight / lineH)))

      apple = createAppleRenderer({
        columns: gridCols,
        rows: gridRows,
        charAspect: targetWidth / gridCols / (targetHeight / gridRows)
      })

      appleW = targetWidth
      appleH = targetHeight
      appleX = clamp(viewWidth * 0.74 - appleW / 2, margin, viewWidth - margin - appleW)
      appleY = clamp(
        viewHeight * 0.32 - appleH / 2,
        margin + FLOAT_DISTANCE,
        viewHeight - margin - appleH
      )

      ink = resolveInk()
      lastApple = 0
      lastField = 0
    }

    const drawField = (time: number): void => {
      if (!field || !fieldCtx) return
      const context = fieldCtx
      const lines = field.render(time)
      const cellHeight = lineH * field.stepRows

      context.clearRect(0, 0, viewWidth, viewHeight)
      context.font = `${FONT_SIZE}px ${FONT_FAMILY}`
      context.textBaseline = 'top'
      setLetterSpacing(context, `${(field.stepCols - 1) * charW}px`)

      for (let row = 0; row < lines.length; row += 1) {
        const band = 0.5 + 0.5 * Math.sin(row * 0.38 - time * 0.5)
        context.fillStyle = withAlpha(ink, 0.1 + band * 0.13)
        context.fillText(lines[row], 0, Math.round(row * cellHeight))
      }
      setLetterSpacing(context, '0px')
    }

    const drawApple = (time: number): void => {
      if (!apple || !appleCtx) return
      const context = appleCtx

      context.clearRect(
        appleX - 2,
        appleY - FLOAT_DISTANCE - 2,
        appleW + 4,
        appleH + FLOAT_DISTANCE + 4
      )
      context.font = `${FONT_SIZE}px ${FONT_FAMILY}`
      context.textBaseline = 'top'
      context.fillStyle = withAlpha(ink, 0.38)

      const spacing =
        appleW > apple.columns * charW && apple.columns > 1
          ? (appleW - apple.columns * charW) / (apple.columns - 1)
          : 0
      setLetterSpacing(context, `${spacing}px`)

      const floatY = -FLOAT_DISTANCE * (0.5 + 0.5 * Math.sin(time * FLOAT_SPEED - Math.PI / 2))
      const lines = apple.render(appleAngle(time)).text.split('\n')
      const cellHeight = appleH / apple.rows
      const top = Math.round(appleY + floatY)

      for (let row = 0; row < lines.length; row += 1) {
        context.fillText(lines[row], Math.round(appleX), Math.round(top + row * cellHeight))
      }
      setLetterSpacing(context, '0px')
    }

    const paint = (now: number): void => {
      frame = requestAnimationFrame(paint)
      if (!active || document.hidden) return
      if (!startedAt) startedAt = now
      const elapsed = (now - startedAt) / 1000

      if (now - lastField >= fieldInterval - 0.5) {
        lastField = now
        drawField(elapsed)
      }
      if (now - lastApple >= appleInterval - 0.5) {
        lastApple = now
        drawApple(elapsed)
      }
    }

    const stop = (): void => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      clearAll()
      field = null
      apple = null
    }

    const start = (): void => {
      stop()
      measure()
      if (!field || !apple) return

      if (reduced) {
        drawField(0)
        drawApple(0)
        return
      }

      startedAt = 0
      lastApple = 0
      lastField = 0
      frame = requestAnimationFrame(paint)
    }

    const syncSkin = (): void => {
      const on = document.documentElement.dataset.skin === 'whirl'
      if (on === active) return
      active = on
      if (on) start()
      else stop()
    }

    const observer = new MutationObserver(syncSkin)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] })

    const resizer = new ResizeObserver(() => {
      if (!active) return
      measure()
      if (!field || !apple) return

      if (reduced) {
        drawField(0)
        drawApple(0)
        return
      }

      if (!frame) {
        startedAt = 0
        lastApple = 0
        lastField = 0
        frame = requestAnimationFrame(paint)
      }
    })
    resizer.observe(host)

    const onVisible = (): void => {
      if (!document.hidden) {
        lastApple = 0
        lastField = 0
        startedAt = 0
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    syncSkin()

    return () => {
      observer.disconnect()
      resizer.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
      if (frame) cancelAnimationFrame(frame)
      field = null
      apple = null
    }
  }, [])

  return (
    <div className="whirl-ascii" ref={hostRef} aria-hidden="true">
      <canvas className="whirl-ascii-field" ref={fieldRef} />
      <canvas className="whirl-ascii-apple" ref={appleRef} />
    </div>
  )
}
