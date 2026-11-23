export interface PromptEntry {
  id: string
  title: string
  emoji: string
  tags: string[]
  updatedDate: string
  version: string
  content: string
  updatedAt: number
}

export interface PromptVaultData {
  prompts: PromptEntry[]
}

export interface ExportResult {
  savedTo: string | null
  promptCount: number
}
