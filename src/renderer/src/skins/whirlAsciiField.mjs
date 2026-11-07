const FIELD_RAMP = '.:-=+*#%@'

/**
 * 全屏 ASCII 字符场。
 * 极坐标在创建时预计算，每帧只做三角函数合成与字符映射，
 * 这样可以在铺满主区的同时把每帧开销控制在固定范围。
 */
export function createFieldRenderer({
  columns,
  rows,
  stepCols = 2,
  stepRows = 2,
  charAspect = 0.56
}) {
  const cols = Math.max(8, Math.floor(columns))
  const lineCount = Math.max(6, Math.floor(rows))
  let stepC = Math.max(1, Math.floor(stepCols))
  let stepR = Math.max(1, Math.floor(stepRows))

  // 超高分辨率下自动加大采样间隔，把字符场总量收在固定预算内。
  const SAMPLE_BUDGET = 24000
  let growCols = true
  while (Math.floor(cols / stepC) * Math.floor(lineCount / stepR) > SAMPLE_BUDGET) {
    if (growCols) stepC += 1
    else stepR += 1
    growCols = !growCols
  }

  const sampleCols = Math.max(4, Math.floor(cols / stepC))
  const sampleRows = Math.max(3, Math.floor(lineCount / stepR))

  const total = sampleCols * sampleRows
  const ripplePhase = new Float32Array(total)
  const petalPhase = new Float32Array(total)
  const driftPhase = new Float32Array(total)
  const angles = new Float32Array(total)
  const centerCol = (sampleCols - 1) * 0.6
  const centerRow = (sampleRows - 1) * 0.46

  // 横向与纵向的字符格尺寸不同，按字符宽高比换算成视觉等距坐标。
  const rowScale = stepR / (stepC * Math.max(0.2, charAspect))
  let maxRadius = 1

  for (let row = 0; row < sampleRows; row += 1) {
    const dy = (row - centerRow) * rowScale
    for (let col = 0; col < sampleCols; col += 1) {
      const dx = col - centerCol
      const index = row * sampleCols + col
      const radius = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)
      angles[index] = angle
      ripplePhase[index] = radius
      // 与时间无关的相位在这里一次算完，每帧只保留一次减法。
      petalPhase[index] = angle * 3 + radius * 5.6
      driftPhase[index] = col * 0.11 + row * 0.27
      if (radius > maxRadius) maxRadius = radius
    }
  }

  const radiusScale = 9.2 / maxRadius
  for (let index = 0; index < total; index += 1) {
    ripplePhase[index] *= radiusScale
  }

  return {
    columns: sampleCols,
    rows: sampleRows,
    stepCols: stepC,
    stepRows: stepR,
    /**
     * 返回按采样行组织的字符，行内字符数量为采样列数。
     * 时间单位为秒，图案速度与帧率无关。
     */
    render(time) {
      const lines = new Array(sampleRows)
      const rippleTime = time * 1.25
      const petalTime = time * 0.42
      const driftTime = time * 0.62
      const sweepTime = time * 0.55

      for (let row = 0; row < sampleRows; row += 1) {
        const chars = new Array(sampleCols)
        const rowStart = row * sampleCols
        for (let col = 0; col < sampleCols; col += 1) {
          const index = rowStart + col
          const ripple = Math.sin(ripplePhase[index] - rippleTime)
          const petals = Math.sin(petalPhase[index] + petalTime)
          const drift = Math.sin(driftPhase[index] - driftTime)
          let value = ripple * 0.44 + petals * 0.28 + drift * 0.22

          // 一条缓慢旋转的窄亮弧，为静态波纹增加方向感。
          let sweep = Math.cos(angles[index] - sweepTime)
          if (sweep > 0) {
            sweep *= sweep
            sweep *= sweep
            sweep *= sweep
            value += sweep * 0.62
          }

          const level = (value + 0.94) / 1.88
          if (level <= 0.56) {
            chars[col] = ' '
            continue
          }

          const step = Math.min(
            FIELD_RAMP.length - 1,
            Math.floor(((level - 0.56) / 0.44) * FIELD_RAMP.length)
          )
          chars[col] = FIELD_RAMP[step]
        }
        lines[row] = chars.join('')
      }

      return lines
    }
  }
}
