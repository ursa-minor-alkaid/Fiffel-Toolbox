import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { registerPlugin, attachIpc, attachProtocols, registerSchemePrivileges } from './plugin-host'
import type { PluginMainModule } from '../shared/types'

const WINDOW_BG = '#f1f1ee'
const APP_NAME = 'Fiffel'
const ICON_FILE = 'fiffel.ico'
const TRAY_ICON_FILE = 'icon.png'

/** 改名前的用户数据目录，用于一次性迁移 */
const LEGACY_USER_DATA = 'toolbox'

/** 主窗口与托盘常驻引用，避免被垃圾回收 */
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 只有从托盘菜单退出时才真正关闭窗口 */
let quitting = false

app.setName(APP_NAME)

/**
 * 改名后 userData 目录会变成 Fiffel。首次启动时把旧目录里真正有用的数据复制过来：
 * 插件存储 data、HTML 应用数据 webapp-data、渲染层 localStorage。
 * Electron 启动时可能已经建好空目录，因此用标记文件判断是否迁移过。
 */
async function migrateUserData(): Promise<void> {
  const target = app.getPath('userData')
  const legacy = path.join(app.getPath('appData'), LEGACY_USER_DATA)
  const marker = path.join(target, '.migrated-from-toolbox')
  if (target.toLowerCase() === legacy.toLowerCase()) return

  try {
    await fs.access(marker)
    return
  } catch {
    /* 尚未迁移，继续 */
  }

  await fs.mkdir(target, { recursive: true })

  // safeStorage 的主密钥存在 Local State，必须一并迁移，否则旧密文无法解密
  try {
    await fs.access(path.join(legacy, 'Local State'))
    await fs.copyFile(path.join(legacy, 'Local State'), path.join(target, 'Local State'))
  } catch {
    /* 旧目录没有 Local State，跳过 */
  }

  const items = ['data', 'webapp-data', 'Local Storage']
  let copied = false
  for (const item of items) {
    const from = path.join(legacy, item)
    try {
      await fs.access(from)
    } catch {
      continue
    }
    try {
      await fs.cp(from, path.join(target, item), {
        recursive: true,
        force: false,
        errorOnExist: false
      })
      copied = true
    } catch (err) {
      console.error(`迁移 ${item} 失败`, err)
    }
  }

  try {
    await fs.writeFile(marker, copied ? 'copied' : 'empty', 'utf-8')
  } catch {
    /* 标记写入失败不影响运行 */
  }
}

/** 约定：plugins/<id>/main.ts 默认导出 { manifest, handlers } */
const discovered = import.meta.glob<PluginMainModule>('../../plugins/*/main.ts', { eager: true })

function loadPlugins(): void {
  for (const [file, mod] of Object.entries(discovered)) {
    try {
      const plugin = (mod as { default?: PluginMainModule }).default
      if (!plugin) throw new Error('缺少默认导出')
      registerPlugin(plugin)
    } catch (err) {
      console.error(`加载插件失败: ${file}`, err)
    }
  }
}

// 协议特权必须在 app ready 之前声明，因此插件加载提前到模块顶层
loadPlugins()
registerSchemePrivileges()

function createWindow(): BrowserWindow {
  const iconPath = path.join(app.getAppPath(), ICON_FILE)
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: WINDOW_BG,
    title: APP_NAME,
    icon: iconPath,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // 关闭按钮只收进托盘，退出走托盘菜单
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })

  const pushState = (): void => {
    win.webContents.send('fiffel:window-state-changed', { maximized: win.isMaximized() })
  }
  win.on('maximize', pushState)
  win.on('unmaximize', pushState)

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  return win
}

/** 托盘图标优先用 ico 取清晰的多尺寸图，缺失时退回 png */
function resolveTrayIcon(): Electron.NativeImage {
  for (const name of [ICON_FILE, TRAY_ICON_FILE]) {
    const image = nativeImage.createFromPath(path.join(app.getAppPath(), name))
    if (!image.isEmpty()) return image
  }
  return nativeImage.createEmpty()
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 彻底退出：关闭窗口、销毁托盘，插件占用的进程随主进程一起结束 */
function quitApp(): void {
  quitting = true
  tray?.destroy()
  tray = null
  app.quit()
}

function createTray(): void {
  if (tray) return
  tray = new Tray(resolveTrayIcon())
  tray.setToolTip(`${APP_NAME} · 左键显示，右键退出`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主界面', click: () => showMainWindow() },
      { type: 'separator' },
      { label: `退出 ${APP_NAME}`, click: () => quitApp() }
    ])
  )
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

/** 自绘标题栏：窗口控制与底色同步，使皮肤可以完整覆盖整个窗口 */
function attachWindowControls(): void {
  const senderWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle('fiffel:window', (event, action: string) => {
    const win = senderWindow(event)
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })

  ipcMain.handle('fiffel:set-window-bg', (event, color: string) => {
    const win = senderWindow(event)
    if (!win) return
    if (/^#[0-9a-f]{6}$/i.test(color)) win.setBackgroundColor(color)
  })

  ipcMain.handle('fiffel:window-state', (event) => {
    const win = senderWindow(event)
    return { maximized: win?.isMaximized() ?? false, fullscreen: win?.isFullScreen() ?? false }
  })
}

// 快捷方式可能被重复点击，只保留一个实例并聚焦已有窗口
const hasLock = app.requestSingleInstanceLock()

if (!hasLock) {
  app.quit()
} else {
  // 迁移必须在 Chromium 初始化加密密钥之前开始，否则 Local State 的覆盖不会生效
  const migration = migrateUserData()

  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    await migration
    attachProtocols()
    attachIpc()
    attachWindowControls()
    createWindow()
    createTray()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showMainWindow()
    })
  })
}

// 系统层面的退出（关机、任务管理器、Cmd+Q）与托盘退出同等对待
app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
