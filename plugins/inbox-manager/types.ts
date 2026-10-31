export interface InboxRow {
  path: string
  drive: string
  name: string
  modified: number
  fileCount: number | null
  totalSize: number | null
  note: string
  pinned: boolean
}

export interface InboxSettings {
  esPath: string
  exactMatch: boolean
  extraRoots: string[]
}

export interface DiagnoseResult {
  ok: boolean
  esPath: string
  version: string
  message: string
}

export interface SearchResult {
  rows: InboxRow[]
  source: 'everything' | 'fallback'
  message: string
  esPath: string
}
