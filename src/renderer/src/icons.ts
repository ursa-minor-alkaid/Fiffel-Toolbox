import type { LucideIcon } from 'lucide-react'
import {
  AppWindow,
  Blocks,
  BookOpen,
  Bot,
  Boxes,
  CodeXml,
  Database,
  FileText,
  FolderOpen,
  Globe,
  Grid3x3,
  Image,
  Inbox,
  KeyRound,
  Layers,
  Mail,
  Palette,
  Search,
  Server,
  Settings,
  Sparkles,
  Terminal,
  Video,
  Wallet,
  WandSparkles
} from 'lucide-react'

/** 插件清单 icon 字段的取值，新增图标时在这里登记 */
export const PLUGIN_ICONS: Record<string, LucideIcon> = {
  'app-window': AppWindow,
  blocks: Blocks,
  book: BookOpen,
  bot: Bot,
  boxes: Boxes,
  code: CodeXml,
  database: Database,
  'file-text': FileText,
  folder: FolderOpen,
  globe: Globe,
  grid: Grid3x3,
  image: Image,
  inbox: Inbox,
  'key-round': KeyRound,
  layers: Layers,
  mail: Mail,
  palette: Palette,
  search: Search,
  server: Server,
  settings: Settings,
  sparkles: Sparkles,
  terminal: Terminal,
  video: Video,
  wallet: Wallet,
  wand: WandSparkles
}

export function pluginIcon(name?: string): LucideIcon | undefined {
  return name ? PLUGIN_ICONS[name] : undefined
}
