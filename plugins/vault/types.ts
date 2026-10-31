export interface ApiEntry {
  id: string
  name: string
  provider: string
  baseUrl: string
  models: string[]
  keyCipher: string
  note: string
  updatedAt: number
}

export interface PromptEntry {
  id: string
  title: string
  category: string
  tags: string[]
  role: string
  content: string
  updatedAt: number
}

export interface VaultData {
  apis: ApiEntry[]
  prompts: PromptEntry[]
  encryptionAvailable: boolean
}

export interface ExportResult {
  savedTo: string | null
  apiCount: number
  promptCount: number
}
