import type { PluginContext, PluginMainModule } from '../../src/shared/types'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export interface WebApp {
  id: string
  name: string
  file: string
  dir: string
  addedAt: number
  missing: boolean
}

export interface StorageOp {
  op: 'set' | 'remove' | 'clear'
  key?: string
  value?: string
}

const APP_NAMESPACE = 'apps'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

const newId = (): string => `a${crypto.randomBytes(6).toString('hex')}`

/** 序列化进 <script> 时避免提前闭合标签与行分隔符问题 */
const asScriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '')

/**
 * 注入的适配层：用内存对象顶替 localStorage，
 * 初始值来自服务端快照，写入合并后异步回传主进程。
 */
function buildShim(appId: string, snapshot: Record<string, string>): string {
  return `<script>(function(){
  "use strict";
  var ID = ${asScriptJson(appId)};
  var seed = ${asScriptJson(snapshot)};

  function createStore(initial, onFlush) {
    var data = {};
    for (var k in initial) { if (Object.prototype.hasOwnProperty.call(initial, k)) data[k] = String(initial[k]); }
    var store = {
      getItem: function(k) {
        k = String(k);
        return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
      },
      setItem: function(k, v) {
        k = String(k); v = String(v);
        var old = store.getItem(k);
        if (old === v) return;
        data[k] = v;
        emit(k, old, v);
        onFlush({ op: "set", key: k, value: v });
      },
      removeItem: function(k) {
        k = String(k);
        if (!Object.prototype.hasOwnProperty.call(data, k)) return;
        var old = data[k];
        delete data[k];
        emit(k, old, null);
        onFlush({ op: "remove", key: k });
      },
      clear: function() {
        var keys = Object.keys(data);
        data = {};
        onFlush({ op: "clear" });
        for (var i = 0; i < keys.length; i++) emit(keys[i], null, null);
      },
      key: function(i) {
        var keys = Object.keys(data);
        i = Number(i);
        return i >= 0 && i < keys.length ? keys[i] : null;
      }
    };
    function emit(key, oldValue, newValue) {
      try {
        window.dispatchEvent(new StorageEvent("storage", {
          key: key, oldValue: oldValue, newValue: newValue,
          url: location.href, storageArea: store
        }));
      } catch (e) {}
    }
    Object.defineProperty(store, "length", { get: function(){ return Object.keys(data).length; } });
    Object.defineProperty(store, "__tbx", { value: true, enumerable: false });
    return store;
  }

  var queue = [];
  var timer = null;
  function post() {
    if (!queue.length) return;
    var ops = queue;
    queue = [];
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __tbx: 1, appId: ID, ops: ops }, "*");
      }
    } catch (e) {}
  }
  function enqueue(op) {
    queue.push(op);
    if (timer) return;
    timer = setTimeout(function(){ timer = null; post(); }, 60);
  }

  var local = createStore(seed, enqueue);
  var session = createStore({}, function(){});

  function define(name, value) {
    try {
      Object.defineProperty(window, name, { configurable: true, get: function(){ return value; }, set: function(){} });
    } catch (e) {
      try { window[name] = value; } catch (e2) {}
    }
  }
  define("localStorage", local);
  define("sessionStorage", session);

  window.addEventListener("pagehide", post);
  window.addEventListener("beforeunload", post);
  document.addEventListener("visibilitychange", function(){
    if (document.visibilityState === "hidden") post();
  });
  setInterval(post, 1500);

  /* 焦点在页面内时，Esc 也能退出沉浸模式 */
  window.addEventListener("keydown", function(event){
    if (event.key !== "Escape") return;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __tbx: 4, appId: ID }, "*");
      }
    } catch (e) {}
  });
})();</script>`
}

/**
 * 页面运行探针：捕获运行期错误、未处理的 Promise 拒绝、资源加载失败与控制台告警，
 * 转发给宿主展示，避免页面出错后没有任何反馈。
 */
function buildProbe(appId: string): string {
  return `<script>(function(){
  "use strict";
  var ID = ${asScriptJson(appId)};
  var MAX = 1800;
  var lastMessage = "";
  var lastAt = 0;

  function clip(value) {
    var text;
    if (typeof value === "string") text = value;
    else if (value && typeof value.stack === "string") text = value.stack;
    else if (value && typeof value.message === "string") text = value.message;
    else {
      try { text = JSON.stringify(value); } catch (e) { text = String(value); }
    }
    if (typeof text !== "string") text = String(value);
    return text.length > MAX ? text.slice(0, MAX) + " ..." : text;
  }

  function send(level, message) {
    var body = clip(message);
    var now = Date.now();
    if (body === lastMessage && now - lastAt < 800) return;
    lastMessage = body;
    lastAt = now;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __tbx: 2, appId: ID, level: level, message: body, at: now }, "*");
      }
    } catch (e) {}
  }

  window.addEventListener("error", function(event) {
    var target = event.target;
    if (target && target !== window && target.tagName) {
      var src = target.currentSrc || target.src || target.href || "";
      send("error", "资源加载失败 " + target.tagName.toLowerCase() + " " + src);
      return;
    }
    var where = event.filename ? " (" + event.filename + ":" + (event.lineno || 0) + ")" : "";
    var stack = event.error && event.error.stack ? "\\n" + event.error.stack : "";
    send("error", (event.message || "脚本错误") + where + stack);
  }, true);

  window.addEventListener("unhandledrejection", function(event) {
    send("error", "未处理的 Promise 拒绝 " + clip(event.reason));
  });

  var nativeError = console.error;
  var nativeWarn = console.warn;
  console.error = function() {
    var parts = [];
    for (var i = 0; i < arguments.length; i += 1) parts.push(clip(arguments[i]));
    send("error", parts.join(" "));
    return nativeError.apply(console, arguments);
  };
  console.warn = function() {
    var parts = [];
    for (var i = 0; i < arguments.length; i += 1) parts.push(clip(arguments[i]));
    return nativeWarn.apply(console, arguments);
  };
})();</script>`
}

function injectShim(html: string, appId: string, snapshot: Record<string, string>): string {
  const injected = buildShim(appId, snapshot) + buildProbe(appId)
  const head = html.match(/<head[^>]*>/i)
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length
    return html.slice(0, at) + injected + html.slice(at)
  }
  return injected + html
}

async function storedApps(ctx: PluginContext): Promise<Omit<WebApp, 'missing'>[]> {
  return ctx.storage.get<Omit<WebApp, 'missing'>[]>(APP_NAMESPACE, [])
}

async function readApps(ctx: PluginContext): Promise<WebApp[]> {
  const stored = await storedApps(ctx)
  return Promise.all(
    stored.map(async (app) => {
      let missing = false
      try {
        await fs.access(app.file)
      } catch {
        missing = true
      }
      return { ...app, missing }
    })
  )
}

const dataKey = (appId: string): string => `data_${appId}`

/* ---------- 存储数据目录 ---------- */

const STORAGE_DIR_KEY = 'storageDir'

interface StorageInfo {
  dir: string
  fileCount: number
}

interface DataFile {
  id: string
  name: string
  file: string
  updatedAt: number
  data: Record<string, string>
}

const defaultStorageDir = (ctx: PluginContext): string =>
  path.join(ctx.userDataPath, 'webapp-data')

async function resolveStorageDir(ctx: PluginContext): Promise<string> {
  const configured = await ctx.storage.get<string>(STORAGE_DIR_KEY, '')
  const dir = configured.trim() ? path.resolve(configured.trim()) : defaultStorageDir(ctx)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const dataFilePath = (dir: string, appId: string): string => path.join(dir, `${appId}.json`)

async function countDataFiles(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir)
    return entries.filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}

async function writeDataFile(
  dir: string,
  app: Pick<WebApp, 'id' | 'name' | 'file'>,
  data: Record<string, string>
): Promise<void> {
  const payload: DataFile = {
    id: app.id,
    name: app.name,
    file: app.file,
    updatedAt: Date.now(),
    data
  }
  await fs.writeFile(dataFilePath(dir, app.id), JSON.stringify(payload, null, 2), 'utf-8')
}

/** 读取应用数据；文件不存在时把旧版存储迁移到文件 */
async function readAppData(ctx: PluginContext, app: WebApp): Promise<Record<string, string>> {
  const dir = await resolveStorageDir(ctx)
  try {
    const raw = await fs.readFile(dataFilePath(dir, app.id), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DataFile>
    if (parsed && typeof parsed.data === 'object' && parsed.data) return parsed.data
    return {}
  } catch {
    const legacy = await ctx.storage.get<Record<string, string>>(dataKey(app.id), {})
    if (Object.keys(legacy).length) {
      await writeDataFile(dir, app, legacy)
      await ctx.storage.set(dataKey(app.id), {})
    }
    return legacy
  }
}

/** 把已有数据文件复制到新目录，目标已存在的文件不覆盖 */
async function copyDataFiles(source: string, target: string): Promise<void> {
  if (source === target) return
  let entries: string[]
  try {
    entries = await fs.readdir(source)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const to = path.join(target, name)
    try {
      await fs.access(to)
      continue
    } catch {
      /* 目标不存在，可以复制 */
    }
    try {
      await fs.copyFile(path.join(source, name), to)
    } catch {
      /* 单个文件失败不影响整体切换 */
    }
  }
}

async function storageInfoOf(ctx: PluginContext): Promise<StorageInfo> {
  const dir = await resolveStorageDir(ctx)
  return { dir, fileCount: await countDataFiles(dir) }
}

/** 切换存储目录：先把旧目录的 json 复制过去，再写配置 */
async function switchStorageDir(ctx: PluginContext, target: string): Promise<StorageInfo> {
  const source = await resolveStorageDir(ctx)
  const next = path.resolve(target)
  await fs.mkdir(next, { recursive: true })
  await copyDataFiles(source, next)
  await ctx.storage.set(STORAGE_DIR_KEY, next === defaultStorageDir(ctx) ? '' : next)
  return { dir: next, fileCount: await countDataFiles(next) }
}

async function serve(request: Request, ctx: PluginContext): Promise<Response> {
  const url = new URL(request.url)
  const appId = url.hostname.toLowerCase()
  const apps = await readApps(ctx)
  const app = apps.find((item) => item.id === appId)
  if (!app) return new Response('应用未登记', { status: 404 })

  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (!relative) relative = path.basename(app.file)

  const target = path.resolve(app.dir, relative)
  if (target !== app.dir && !target.startsWith(app.dir + path.sep)) {
    return new Response('越权访问', { status: 403 })
  }

  let buffer: Buffer
  try {
    buffer = await fs.readFile(target)
  } catch {
    return new Response('文件不存在', { status: 404 })
  }

  const ext = path.extname(target).toLowerCase()
  if (ext === '.html' || ext === '.htm') {
    return new Response(injectShim(buffer.toString('utf-8'), appId, await readAppData(ctx, app)), {
      headers: {
        'content-type': MIME['.html'],
        'cache-control': 'no-store'
      }
    })
  }

  return new Response(new Uint8Array(buffer), {
    headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' }
  })
}

function mergeOps(current: Record<string, string>, ops: StorageOp[]): Record<string, string> {
  const next = { ...current }
  for (const op of ops) {
    if (op.op === 'clear') {
      for (const key of Object.keys(next)) delete next[key]
      continue
    }
    if (typeof op.key !== 'string') continue
    if (op.op === 'set') next[op.key] = String(op.value ?? '')
    else if (op.op === 'remove') delete next[op.key]
  }
  return next
}

/** 同一应用的写入串行化，避免多批 ops 并发读改写丢更新 */
const writeChains = new Map<string, Promise<unknown>>()

function serialize<T>(appId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(appId) ?? Promise.resolve()
  const next = previous.then(task, task)
  writeChains.set(
    appId,
    next.catch(() => undefined)
  )
  return next
}

const mod: PluginMainModule = {
  manifest: {
    id: 'webapp',
    name: 'HTML 应用',
    icon: 'app-window',
    description: '为没有后端的 HTML 页面提供本地存储与运行面板',
    version: '0.2.0',
    protocols: [
      {
        scheme: 'tbx',
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    ]
  },

  protocolHandlers: {
    tbx: (request, ctx) => serve(request, ctx)
  },

  handlers: {
    async list(_args, ctx): Promise<WebApp[]> {
      return readApps(ctx)
    },

    /** 源文件时间戳与体积，前端轮询判断文件是否被外部编辑 */
    async stat(args, ctx): Promise<{ missing: boolean; mtime: number; size: number }> {
      const { id } = (args ?? {}) as { id?: string }
      const app = (await storedApps(ctx)).find((item) => item.id === id)
      if (!app) return { missing: true, mtime: 0, size: 0 }
      try {
        const info = await fs.stat(app.file)
        return { missing: false, mtime: info.mtimeMs, size: info.size }
      } catch {
        return { missing: true, mtime: 0, size: 0 }
      }
    },

    async add(args, ctx): Promise<WebApp[]> {
      const { file } = (args ?? {}) as { file?: string }
      const picked = file ?? (await ctx.pickFile([{ name: 'HTML', extensions: ['html', 'htm'] }]))
      if (!picked) return readApps(ctx)
      if (!/\.html?$/i.test(picked)) throw new Error('只能登记 .html 或 .htm 文件')

      const absolute = path.resolve(picked)
      const apps = await readApps(ctx)
      if (apps.some((app) => app.file.toLowerCase() === absolute.toLowerCase())) return apps

      const app = {
        id: newId(),
        name: path.basename(absolute).replace(/\.html?$/i, ''),
        file: absolute,
        dir: path.dirname(absolute),
        addedAt: Date.now()
      }
      await ctx.storage.set(APP_NAMESPACE, [...apps.map(({ missing, ...rest }) => rest), app])
      return readApps(ctx)
    },

    /** 按前端拖拽后的顺序重排登记列表 */
    async reorder(args, ctx): Promise<WebApp[]> {
      const { ids } = (args ?? {}) as { ids?: string[] }
      const apps = await readApps(ctx)
      const byId = new Map(apps.map((app) => [app.id, app]))
      const next: Omit<WebApp, 'missing'>[] = []

      for (const id of Array.isArray(ids) ? ids : []) {
        const app = byId.get(id)
        if (!app) continue
        const { missing, ...rest } = app
        next.push(rest)
        byId.delete(id)
      }

      for (const app of byId.values()) {
        const { missing, ...rest } = app
        next.push(rest)
      }

      await ctx.storage.set(APP_NAMESPACE, next)
      return readApps(ctx)
    },

    async remove(args, ctx): Promise<WebApp[]> {
      const { id, deleteData = false } = (args ?? {}) as { id: string; deleteData?: boolean }
      const apps = await readApps(ctx)
      await ctx.storage.set(
        APP_NAMESPACE,
        apps.filter((app) => app.id !== id).map(({ missing, ...rest }) => rest)
      )
      if (deleteData) {
        const dir = await resolveStorageDir(ctx)
        await fs.rm(dataFilePath(dir, id), { force: true })
        await ctx.storage.set(dataKey(id), {})
      }
      return readApps(ctx)
    },

    async rename(args, ctx): Promise<WebApp[]> {
      const { id, name } = (args ?? {}) as { id: string; name: string }
      const apps = await readApps(ctx)
      const target = apps.find((app) => app.id === id)
      const renamed = name.trim() || target?.name || ''
      await ctx.storage.set(
        APP_NAMESPACE,
        apps.map((app) => {
          const { missing, ...rest } = app
          return app.id === id ? { ...rest, name: renamed } : rest
        })
      )
      if (target) {
        const dir = await resolveStorageDir(ctx)
        const data = await readAppData(ctx, target)
        await writeDataFile(dir, { ...target, name: renamed }, data)
      }
      return readApps(ctx)
    },

    async readData(args, ctx): Promise<Record<string, string>> {
      const { id } = (args ?? {}) as { id: string }
      const app = (await readApps(ctx)).find((item) => item.id === id)
      if (!app) return {}
      return readAppData(ctx, app)
    },

    async applyOps(args, ctx): Promise<{ count: number }> {
      const { id, ops } = (args ?? {}) as { id: string; ops: StorageOp[] }
      const apps = await readApps(ctx)
      const app = apps.find((item) => item.id === id)
      if (!app) throw new Error('应用未登记')
      return serialize(id, async () => {
        const current = await readAppData(ctx, app)
        const next = mergeOps(current, Array.isArray(ops) ? ops : [])
        const dir = await resolveStorageDir(ctx)
        await writeDataFile(dir, app, next)
        return { count: Object.keys(next).length }
      })
    },

    async clearData(args, ctx): Promise<{ count: number }> {
      const { id } = (args ?? {}) as { id: string }
      const app = (await readApps(ctx)).find((item) => item.id === id)
      return serialize(id, async () => {
        const dir = await resolveStorageDir(ctx)
        if (app) await writeDataFile(dir, app, {})
        await ctx.storage.set(dataKey(id), {})
        return { count: 0 }
      })
    },

    async exportAll(_args, ctx): Promise<{ savedTo: string | null; appCount: number }> {
      const apps = await readApps(ctx)
      const exported = await Promise.all(
        apps.map(async (app) => ({
          name: app.name,
          file: app.file,
          data: await readAppData(ctx, app)
        }))
      )
      const stamp = new Date().toISOString().slice(0, 10)
      const saved = await ctx.saveFile(
        `html-apps-${stamp}.json`,
        JSON.stringify({ exportedAt: new Date().toISOString(), apps: exported }, null, 2),
        [{ name: 'JSON', extensions: ['json'] }]
      )
      return { savedTo: saved, appCount: apps.length }
    },

    /** 导出单个应用的存储数据 */
    async exportOne(args, ctx): Promise<{ savedTo: string | null; keyCount: number }> {
      const { id } = (args ?? {}) as { id: string }
      const app = (await readApps(ctx)).find((item) => item.id === id)
      if (!app) throw new Error('应用未登记')
      const data = await readAppData(ctx, app)
      const stamp = new Date().toISOString().slice(0, 10)
      const safe = app.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'html-app'
      const saved = await ctx.saveFile(
        `${safe}-${stamp}.json`,
        JSON.stringify(
          { exportedAt: new Date().toISOString(), name: app.name, file: app.file, data },
          null,
          2
        ),
        [{ name: 'JSON', extensions: ['json'] }]
      )
      return { savedTo: saved, keyCount: Object.keys(data).length }
    },

    async reveal(args, ctx): Promise<boolean> {
      const { id } = (args ?? {}) as { id: string }
      const apps = await readApps(ctx)
      const app = apps.find((item) => item.id === id)
      if (!app) throw new Error('应用未登记')
      const error = await ctx.openPath(app.dir)
      if (error) throw new Error(error)
      return true
    },

    /** 当前存储数据目录与文件数 */
    async storageInfo(_args, ctx): Promise<StorageInfo> {
      return storageInfoOf(ctx)
    },

    /** 打开存储数据目录 */
    async openStorage(_args, ctx): Promise<StorageInfo> {
      const info = await storageInfoOf(ctx)
      const error = await ctx.openPath(info.dir)
      if (error) throw new Error(error)
      return info
    },

    /** 更换存储数据目录；取消选择时返回 null */
    async chooseStorage(_args, ctx): Promise<StorageInfo | null> {
      const picked = await ctx.pickDirectory()
      if (!picked) return null
      return switchStorageDir(ctx, picked)
    },

    /** 恢复默认存储数据目录 */
    async resetStorage(_args, ctx): Promise<StorageInfo> {
      return switchStorageDir(ctx, defaultStorageDir(ctx))
    }
  }
}

export default mod
