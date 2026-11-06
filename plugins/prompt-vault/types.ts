export interface PromptEntry {
  id: string
  title: string
  emoji: string
  tags: string[]
  role: string
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
