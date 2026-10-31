export interface PluginManifest {
  id: string
  name: string
  /** 侧边栏图标名，取值见 renderer/src/icons.ts 的 PLUGIN_ICONS */
  icon?: string
  description?: string
  version?: string
  /** 需要在 app ready 之前以特权方式注册的自定义协议 */
  protocols?: PluginProtocol[]
}

export interface PluginProtocol {
  scheme: string
  standard?: boolean
  secure?: boolean
  supportFetchAPI?: boolean
  corsEnabled?: boolean
  stream?: boolean
  bypassCSP?: boolean
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/** 插件在主进程侧可用的能力白名单 */
export interface PluginContext {
  storage: {
    get<T>(key: string, fallback: T): Promise<T>
    set(key: string, value: unknown): Promise<void>
  }
  secrets: {
    available(): boolean
    encrypt(plain: string): string
    decrypt(cipher: string): string
  }
  exec(file: string, args: string[], timeoutMs?: number): Promise<ExecResult>
  openPath(target: string): Promise<string>
  saveFile(
    defaultName: string,
    content: string,
    filters?: { name: string; extensions: string[] }[]
  ): Promise<string | null>
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
  pickDirectory(): Promise<string | null>
  userDataPath: string
  /** 应用根目录，用于定位随程序分发的外部工具 */
  appPath: string
}

export type PluginHandler = (args: any, ctx: PluginContext) => Promise<unknown> | unknown

/** 自定义协议处理函数，返回 Web Response */
export type ProtocolHandler = (request: Request, ctx: PluginContext) => Promise<Response>

/** 每个插件模块的约定导出：manifest + handlers */
export interface PluginMainModule {
  manifest: PluginManifest
  handlers: Record<string, PluginHandler>
  /** scheme 需同时出现在 manifest.protocols 中 */
  protocolHandlers?: Record<string, ProtocolHandler>
}
