const RAMP = ' .:-=+*#%@'
const CAMERA_DISTANCE = 4.6
const VIEW_HEIGHT = 3.6
const EPSILON = 0.0001
const TAU = Math.PI * 2

export const ROTATION_SECONDS = 32

function ellipsoid(cx, cy, cz, rx, ry, rz, kind, angle = 0) {
  return {
    cx,
    cy,
    cz,
    rx,
    ry,
    rz,
    kind,
    cos: Math.cos(angle),
    sin: Math.sin(angle)
  }
}

// 三个椭圆体形成果身；两个减法体分别形成顶部果窝与右侧缺口。
const SHAPES = [
  ellipsoid(0, -0.17, 0, 0.82, 0.85, 0.76, 'body'),
  ellipsoid(-0.28, 0.27, 0, 0.61, 0.66, 0.67, 'body'),
  ellipsoid(0.28, 0.27, 0, 0.61, 0.66, 0.67, 'body'),
  ellipsoid(0, 0.94, 0, 0.28, 0.24, 0.82, 'cut'),
  ellipsoid(0.91, 0.28, 0, 0.43, 0.43, 1.1, 'cut'),
  ellipsoid(0.03, 1.02, 0, 0.045, 0.3, 0.045, 'stem', -0.18),
  ellipsoid(0.31, 1.12, 0, 0.32, 0.105, 0.055, 'leaf', 0.48)
]

function insideEllipsoid(shape, x, y, z) {
  const px = x - shape.cx
  const py = y - shape.cy
  const pz = (z - shape.cz) / shape.rz
  const lx = (shape.cos * px + shape.sin * py) / shape.rx
  const ly = (-shape.sin * px + shape.cos * py) / shape.ry
  return lx * lx + ly * ly + pz * pz <= 1
}

function insideSolid(x, y, z) {
  if (insideEllipsoid(SHAPES[5], x, y, z) || insideEllipsoid(SHAPES[6], x, y, z)) {
    return true
  }

  const inBody =
    insideEllipsoid(SHAPES[0], x, y, z) ||
    insideEllipsoid(SHAPES[1], x, y, z) ||
    insideEllipsoid(SHAPES[2], x, y, z)

  return (
    inBody &&
    !insideEllipsoid(SHAPES[3], x, y, z) &&
    !insideEllipsoid(SHAPES[4], x, y, z)
  )
}

function addIntersections(shape, id, ox, oy, oz, dx, dy, dz, times, ids, count) {
  const px = ox - shape.cx
  const py = oy - shape.cy
  const pz = (oz - shape.cz) / shape.rz

  const lx = (shape.cos * px + shape.sin * py) / shape.rx
  const ly = (-shape.sin * px + shape.cos * py) / shape.ry
  const ldx = (shape.cos * dx + shape.sin * dy) / shape.rx
  const ldy = (-shape.sin * dx + shape.cos * dy) / shape.ry
  const ldz = dz / shape.rz

  const a = ldx * ldx + ldy * ldy + ldz * ldz
  const b = 2 * (lx * ldx + ly * ldy + pz * ldz)
  const c = lx * lx + ly * ly + pz * pz - 1
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0 || a === 0) return count

  const root = Math.sqrt(discriminant)
  const first = (-b - root) / (2 * a)
  const second = (-b + root) / (2 * a)
  if (first > EPSILON) {
    times[count] = first
    ids[count] = id
    count += 1
  }
  if (second > EPSILON && second !== first) {
    times[count] = second
    ids[count] = id
    count += 1
  }
  return count
}

/** 按真实经过的时间计算角度，帧率波动不会改变旋转速度。 */
export function appleAngle(elapsedSeconds) {
  return ((elapsedSeconds % ROTATION_SECONDS) / ROTATION_SECONDS) * TAU
}

/**
 * 创建可复用的透视射线渲染器。charAspect 为字符宽度与行高之比，
 * 终端通常为 0.5，浏览器使用实际等宽字体测量值。
 */
export function createAppleRenderer({ columns, rows, charAspect = 0.5 }) {
  const cols = Math.max(8, Math.floor(columns))
  const lineCount = Math.max(6, Math.floor(rows))
  const total = cols * lineCount
  const directions = new Float64Array(total * 3)
  const times = new Float64Array(SHAPES.length * 2)
  const ids = new Uint8Array(SHAPES.length * 2)
  const physicalAspect = (cols * charAspect) / lineCount

  for (let row = 0; row < lineCount; row += 1) {
    const v = (0.5 - (row + 0.5) / lineCount) * VIEW_HEIGHT
    for (let col = 0; col < cols; col += 1) {
      const u = ((col + 0.5) / cols - 0.5) * VIEW_HEIGHT * physicalAspect
      const length = Math.hypot(u, v, CAMERA_DISTANCE)
      const offset = (row * cols + col) * 3
      directions[offset] = u / length
      directions[offset + 1] = v / length
      directions[offset + 2] = -CAMERA_DISTANCE / length
    }
  }

  function shadeRay(ox, oy, oz, dx, dy, dz, lightX, lightY, lightZ) {
    let count = 0
    for (let id = 0; id < SHAPES.length; id += 1) {
      count = addIntersections(SHAPES[id], id, ox, oy, oz, dx, dy, dz, times, ids, count)
    }
    if (count === 0) return ''

    // 交点很少，插入排序比逐像素分配数组和通用排序更稳定。
    for (let i = 1; i < count; i += 1) {
      const time = times[i]
      const id = ids[i]
      let j = i - 1
      while (j >= 0 && times[j] > time) {
        times[j + 1] = times[j]
        ids[j + 1] = ids[j]
        j -= 1
      }
      times[j + 1] = time
      ids[j + 1] = id
    }

    let inside = false
    for (let i = 0; i < count; i += 1) {
      const time = times[i]
      const after = insideSolid(ox + dx * (time + EPSILON), oy + dy * (time + EPSILON), oz + dz * (time + EPSILON))
      if (!inside && after) {
        const shape = SHAPES[ids[i]]
        const hx = ox + dx * time - shape.cx
        const hy = oy + dy * time - shape.cy
        const hz = (oz + dz * time - shape.cz) / (shape.rz * shape.rz)
        const lx = (shape.cos * hx + shape.sin * hy) / (shape.rx * shape.rx)
        const ly = (-shape.sin * hx + shape.cos * hy) / (shape.ry * shape.ry)

        let nx = shape.cos * lx - shape.sin * ly
        let ny = shape.sin * lx + shape.cos * ly
        let nz = hz
        if (shape.kind === 'cut') {
          nx = -nx
          ny = -ny
          nz = -nz
        }
        const normalLength = Math.hypot(nx, ny, nz) || 1
        nx /= normalLength
        ny /= normalLength
        nz /= normalLength

        const diffuse = Math.max(0, nx * lightX + ny * lightY + nz * lightZ)
        const facing = Math.max(0, -(nx * dx + ny * dy + nz * dz))
        const light = Math.min(1, 0.12 + diffuse * 0.82 + (1 - facing) * 0.08)

        if (shape.kind === 'stem') return '|'
        if (shape.kind === 'leaf') return diffuse > 0.45 ? '*' : ':'
        return RAMP[Math.min(RAMP.length - 1, Math.max(1, Math.round(light * (RAMP.length - 1))))]
      }
      inside = after
    }
    return ''
  }

  return {
    columns: cols,
    rows: lineCount,
    render(angle) {
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const ox = -sin * CAMERA_DISTANCE
      const oy = 0
      const oz = cos * CAMERA_DISTANCE

      // 光源固定在观察空间的左前上方，物体旋转时明暗随法线变化。
      const lightLength = Math.hypot(-0.45, 0.72, 0.52)
      const worldLightX = -0.45 / lightLength
      const worldLightY = 0.72 / lightLength
      const worldLightZ = 0.52 / lightLength
      const lightX = cos * worldLightX - sin * worldLightZ
      const lightY = worldLightY
      const lightZ = sin * worldLightX + cos * worldLightZ

      const lines = new Array(lineCount)
      let hits = 0
      let minCol = cols
      let maxCol = -1
      let minRow = lineCount
      let maxRow = -1

      for (let row = 0; row < lineCount; row += 1) {
        const chars = new Array(cols)
        for (let col = 0; col < cols; col += 1) {
          const offset = (row * cols + col) * 3
          const dx = cos * directions[offset] - sin * directions[offset + 2]
          const dy = directions[offset + 1]
          const dz = sin * directions[offset] + cos * directions[offset + 2]
          const char = shadeRay(ox, oy, oz, dx, dy, dz, lightX, lightY, lightZ) || ' '
          chars[col] = char
          if (char !== ' ') {
            hits += 1
            if (col < minCol) minCol = col
            if (col > maxCol) maxCol = col
            if (row < minRow) minRow = row
            if (row > maxRow) maxRow = row
          }
        }
        lines[row] = chars.join('')
      }

      return {
        text: lines.join('\n'),
        hits,
        minCol,
        maxCol,
        minRow,
        maxRow
      }
    }
  }
}
