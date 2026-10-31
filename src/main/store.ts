import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 每个插件一个命名空间的 JSON 存储，写入串行化 + 原子替换 */
export class JsonStore {
  private cache = new Map<string, unknown>()
  private chains = new Map<string, Promise<unknown>>()

  private dir(): string {
    return path.join(app.getPath('userData'), 'data')
  }

  private file(ns: string): string {
    return path.join(this.dir(), `${ns}.json`)
  }

  async read<T>(ns: string, fallback: T): Promise<T> {
    if (this.cache.has(ns)) return this.cache.get(ns) as T
    try {
      const raw = await fs.readFile(this.file(ns), 'utf-8')
      const parsed = JSON.parse(raw) as T
      this.cache.set(ns, parsed)
      return parsed
    } catch {
      this.cache.set(ns, fallback)
      return fallback
    }
  }

  write<T>(ns: string, value: T): Promise<void> {
    this.cache.set(ns, value)
    const prev = this.chains.get(ns) ?? Promise.resolve()
    const next = prev.then(async () => {
      await fs.mkdir(this.dir(), { recursive: true })
      const tmp = `${this.file(ns)}.tmp`
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
      await fs.rename(tmp, this.file(ns))
    })
    this.chains.set(ns, next.catch(() => undefined))
    return next
  }

  /** 用 mutator 修改命名空间下的对象，避免并发覆盖 */
  update<T extends Record<string, unknown>>(ns: string, mutator: (current: T) => T): Promise<T> {
    const prev = this.chains.get(ns) ?? Promise.resolve()
    const next = prev.then(async () => {
      const current = await this.read<T>(ns, {} as T)
      const updated = mutator(structuredClone(current))
      await this.write(ns, updated)
      return updated
    })
    this.chains.set(ns, next.catch(() => undefined))
    return next
  }
}
