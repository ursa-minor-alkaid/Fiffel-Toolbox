import { safeStorage } from 'electron'

const PREFIX = 'enc:v1:'

export const secrets = {
  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  },

  encrypt(plain: string): string {
    if (!plain) return ''
    if (!this.available()) return PREFIX + 'plain:' + Buffer.from(plain, 'utf-8').toString('base64')
    return PREFIX + safeStorage.encryptString(plain).toString('base64')
  },

  decrypt(cipher: string): string {
    if (!cipher) return ''
    if (!cipher.startsWith(PREFIX)) return cipher
    const body = cipher.slice(PREFIX.length)
    if (body.startsWith('plain:')) {
      return Buffer.from(body.slice('plain:'.length), 'base64').toString('utf-8')
    }
    try {
      return safeStorage.decryptString(Buffer.from(body, 'base64'))
    } catch {
      return ''
    }
  }
}
