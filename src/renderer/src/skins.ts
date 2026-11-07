export type SkinId = 'terminal' | 'cosmos' | 'frost' | 'paper' | 'whirl' | 'pasture'

export interface Skin {
  id: SkinId
  name: string
  hint: string
  /** 预览色块：底色 + 主描边 + 强调色 */
  swatch: [string, string, string]
}

export const SKIN_KEY = 'fiffel:skin'
export const LEGACY_SKIN_KEY = 'toolbox:skin'
export const LEGACY_THEME_KEY = 'toolbox:theme'

export const SKINS: Skin[] = [
  {
    id: 'terminal',
    name: '终端绿',
    hint: 'CRT 终端 · 磷光单色 · 无阴影',
    swatch: ['#030805', '#7dffb0', '#ffdf6e']
  },
  {
    id: 'cosmos',
    name: '深空',
    hint: '复古未来 · 宇宙朋克 · 轨道索引',
    swatch: ['#06070c', '#e6a09b', '#d6c2b2']
  },
  {
    id: 'frost',
    name: '冰霜',
    hint: '钴蓝冷光 · 细线网格 · 角标准星',
    swatch: ['#d8e8f6', '#1467d8', '#54c7f0']
  },
  {
    id: 'paper',
    name: '纸本',
    hint: '印刷读物 · 衬线字 · 墨线分隔',
    swatch: ['#f4efe3', '#2f4858', '#a33f3f']
  },
  {
    id: 'whirl',
    name: '旋白',
    hint: '灰白实验 · 字符动效 · 毛玻璃',
    swatch: ['#f1f1ee', '#1b1b19', '#a9a9a2']
  },
  {
    id: 'pasture',
    name: '牧场',
    hint: '像素牧场 · 草甸青 · 暮色粉 · 插画背景',
    swatch: ['#fbf6e6', '#2c5450', '#7fae4f']
  }
]

export const DEFAULT_SKIN: SkinId = 'whirl'

export function isSkinId(value: unknown): value is SkinId {
  return SKINS.some((skin) => skin.id === value)
}

export function findSkin(id: SkinId): Skin {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0]
}

/** 从 localStorage 读取皮肤，兼容改名前的键与旧版明暗主题键 */
export function readStoredSkin(): SkinId {
  try {
    const stored = localStorage.getItem(SKIN_KEY) ?? localStorage.getItem(LEGACY_SKIN_KEY)
    if (isSkinId(stored)) return stored
    if (localStorage.getItem(LEGACY_THEME_KEY) === 'light') return 'paper'
  } catch {
    /* 隐私模式下忽略读取失败 */
  }
  const attr = document.documentElement.dataset.skin
  return isSkinId(attr) ? attr : DEFAULT_SKIN
}

/** 各皮肤对应的窗口底色，用于无边框窗口的背景同步 */
const WINDOW_BG: Record<SkinId, string> = {
  terminal: '#030805',
  cosmos: '#06070c',
  frost: '#d8e8f6',
  paper: '#f4efe3',
  whirl: '#f1f1ee',
  pasture: '#efe7d3'
}

export function applySkin(id: SkinId): void {
  document.documentElement.dataset.skin = id
  try {
    localStorage.setItem(SKIN_KEY, id)
    localStorage.removeItem(LEGACY_SKIN_KEY)
    localStorage.removeItem(LEGACY_THEME_KEY)
  } catch {
    /* 隐私模式下忽略持久化失败 */
  }
  void window.fiffel?.setWindowBg(WINDOW_BG[id] ?? WINDOW_BG[DEFAULT_SKIN])
}
