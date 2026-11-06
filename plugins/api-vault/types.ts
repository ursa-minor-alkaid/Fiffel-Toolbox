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

export interface ApiVaultData {
  apis: ApiEntry[]
  encryptionAvailable: boolean
}

export interface ExportResult {
  savedTo: string | null
  apiCount: number
}
