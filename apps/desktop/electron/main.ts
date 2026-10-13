/**
 * Electron 主进程：内嵌启动 @ryagent/server（随机端口），创建窗口。
 * 开发模式加载 Vite dev server（RYAGENT_DEV_SERVER_URL），生产模式由主进程
 * 自己的回环 HTTP server 伺服渲染层构建产物（同源加载、并行分片、可缓存）。
 *
 * 启动顺序：**窗口先行**——whenReady 立刻建窗并开始加载渲染层（先显示骨架），
 * @ryagent/server（WAL 恢复/迁移，慢盘 50–200ms+）并行启动，就绪后把 API 地址
 * 推给渲染层。菜单栏 autoHide（macOS 保留应用菜单）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RyAgentServer } from '@ryagent/server'
import { app, BrowserWindow, dialog, Menu, screen } from 'electron'
import { runCapture } from './capture.ts'
import { RENDERER_MOUNT, RendererAssets } from './renderer-assets.ts'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 启动时解析 .env（KEY=VALUE，环境变量优先，绝不覆盖已存在的 process.env）。
 * 候选路径按序查找：RYAGENT_ENV_FILE → userData/.env → 应用目录/.env →
 * 仓库根（dev 模式 ../../.env）→ cwd/.env。保证 Electron 内嵌 server 能
 * 读到 SILICONFLOW_API_KEY 等配置。
 */
function loadDotEnvIntoProcess(): void {
  const candidates = [
    process.env.RYAGENT_ENV_FILE,
    join(app.getPath('userData'), '.env'),
    join(app.getAppPath(), '.env'),
    join(app.getAppPath(), '..', '..', '.env'),
    join(process.cwd(), '.env'),
  ].filter((p): p is string => {
    return typeof p === 'string' && p.length > 0
  })
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (match === null || match[1] === undefined) continue
      const value = (match[2] ?? '').replace(/^["']|["']$/g, '')
      if (value.length > 0 && process.env[match[1]] === undefined) {
        process.env[match[1]] = value
      }
    }
    return
  }
}

loadDotEnvIntoProcess()

/** 平台菜单：macOS 保留系统约定的应用菜单；其他平台整条隐藏（autoHideMenuBar）。 */
function applyPlatformMenu(): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  )
}

/**
 * 建窗口并开始加载渲染层。不 await——调用方与 server 启动并行。
 * `pageUrl` 是渲染层入口；生产模式不带 ?api=（后端可能还没就绪，由 pushApiBase 补）。
 */
/** 窗口最小尺寸（DIP）；与设计规范的窄屏下限一致。 */
const MIN_WIDTH = 1024
const MIN_HEIGHT = 680

/**
 * 开窗尺寸与位置：设计稿按 1320×840，但 150% 缩放的小屏工作区可能只有 1100 DIP 宽，
 * 固定尺寸会让窗口超出屏幕、右侧内容被裁掉（内容按视口宽度布局，视口比屏幕宽）。
 * 这里按主显示器工作区收敛，并保证不小于 minWidth/minHeight。
 *
 * 注意：本机 1.5× 缩放下 Electron 的 workAreaSize 返回的是**物理像素**（1707），
 * 而窗口 bounds 是 DIP——两者混用会让自动居中把窗口放到屏幕外。所以先用
 * dipToScreenPoint 探测坐标单位再统一换算，位置也自己算，不依赖 Electron 居中。
 */
function fitToWorkArea(desired: { width: number; height: number }): {
  width: number
  height: number
  x: number
  y: number
} {
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const probe = screen.dipToScreenPoint({ x: 100, y: 100 })
  const unit = Math.abs(probe.x - 100) < 0.5 ? 1 : scale
  const work = {
    width: Math.round(display.workAreaSize.width / unit),
    height: Math.round(display.workAreaSize.height / unit),
  }
  const width = Math.min(desired.width, Math.max(MIN_WIDTH, work.width - 32))
  const height = Math.min(desired.height, Math.max(MIN_HEIGHT, work.height - 32))
  return {
    width,
    height,
    x: Math.max(0, Math.round((work.width - width) / 2)),
    y: Math.max(0, Math.round((work.height - height) / 4)),
  }
}

function createWindow(pageUrl: string): BrowserWindow {
  const fit = fitToWorkArea({ width: 1320, height: 840 })
  const window = new BrowserWindow({
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#FAF7F2',
    title: 'RyAgent',
    icon: join(here, '../assets/icon-256.png'),
    // 首帧画完再显示，避免加载期的白/空窗口闪烁（加载期的骨架由渲染层自己画）。
    show: false,
    // 隐藏 File/Edit/View/Window/Help 原生菜单栏（macOS 由 applyPlatformMenu 保留）。
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => {
    window.show()
  })
  window.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[renderer] load failed: ${description} (${code})`)
  })
  void window.loadURL(pageUrl)
  return window
}

/** 等待首屏加载结束（截图模式依赖这个契约；失败也算结束，避免永久挂起）。 */
function whenLoaded(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoadingMainFrame()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const settle = (): void => {
      resolve()
    }
    window.webContents.once('did-finish-load', settle)
    window.webContents.once('did-fail-load', settle)
  })
}

/** 后端就绪后把 API 地址推给渲染层（contextIsolation 下不用 preload 注入）。
 *  页面还在加载时先等 did-finish-load——否则脚本会落在旧的 about:blank 文档上。 */
function pushApiBase(window: BrowserWindow, apiBase: string): void {
  const payload = JSON.stringify(apiBase)
  const script =
    `window.__RYAGENT_API_BASE__=${payload};` +
    `window.dispatchEvent(new CustomEvent('ryagent:api-base',{detail:${payload}}));`
  const send = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.executeJavaScript(script).catch((error: unknown) => {
      console.error('[renderer] failed to push api base:', error)
    })
  }
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', send)
    // 兜底：加载失败/超时也要送达（渲染层有全局变量 + 事件双通道）。
    setTimeout(send, 3000)
    return
  }
  send()
}

async function main(): Promise<void> {
  const isCapture = process.env.RYAGENT_CAPTURE === '1'
  // 单实例锁：第二个实例直接退出，由首实例聚焦已有窗口。
  // 截图模式（RYAGENT_CAPTURE=1）是独立进程，不参与锁。
  if (!isCapture && !app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }

  await app.whenReady()
  applyPlatformMenu()

  const devServerUrl = process.env.RYAGENT_DEV_SERVER_URL
  // 渲染层资源服务：与后端无关，先就绪，窗口才能立刻开始加载。
  const assets =
    devServerUrl === undefined || devServerUrl.length === 0
      ? await RendererAssets.start(join(here, '../renderer/dist'))
      : undefined
  const startServer = (): Promise<RyAgentServer> => {
    return RyAgentServer.create({
      // 端口 0 = 随机空闲端口；要固定端口可设 RYAGENT_PORT。
      port: Number(process.env.RYAGENT_PORT ?? '0') || 0,
      host: '127.0.0.1',
      dataDir: process.env.RYAGENT_DATA_DIR ?? join(app.getPath('userData'), 'ryagent-data'),
    })
  }

  if (isCapture) {
    // 截图用可见窗口：隐藏/offscreen 窗口的 capturePage 会挂起不返回。
    // 演示数据要写进 store，所以截图模式仍先起 server 再建窗。
    // here 是打包产物目录（main/），capture.png 写到应用根目录便于查找。
    const server = await startServer()
    const pageUrl =
      assets !== undefined
        ? `${assets.url}${RENDERER_MOUNT}?api=${encodeURIComponent(server.url)}`
        : `${devServerUrl}?api=${encodeURIComponent(server.url)}`
    await runCapture(server, join(here, '..'), async () => {
      const win = createWindow(pageUrl)
      await whenLoaded(win)
      return win
    })
    app.exit(0)
    return
  }

  // 窗口先行：server 在后台启动，渲染层先出骨架，就绪后再喂数据。
  // 两种模式都不把 api 写进 URL（窗口加载时后端可能还没起来），统一走 pushApiBase。
  const pageUrl = assets !== undefined ? `${assets.url}${RENDERER_MOUNT}` : `${devServerUrl ?? ''}`
  const window = createWindow(pageUrl)
  let readyServer: RyAgentServer
  try {
    readyServer = await startServer()
  } catch (error) {
    dialog.showErrorBox('RyAgent 启动失败', error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  // 后端就绪：API 地址推给渲染层（窗口可能还在加载；渲染层另有全局变量兜底，
  // 事件早于监听注册也不会丢）。
  pushApiBase(window, readyServer.url)

  app.on('second-instance', () => {
    // 第二实例已退出，这里把首实例窗口拉到前台。
    const win = BrowserWindow.getAllWindows()[0]
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.on('activate', () => {
    // macOS 点击 Dock 图标：复用已有 server 实例，只在窗口全关时重建窗口。
    if (BrowserWindow.getAllWindows().length === 0) {
      pushApiBase(createWindow(pageUrl), readyServer.url)
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  let quitting = false
  app.on('before-quit', (event) => {
    // 等 server 真正关闭（flush 落盘）后再退出，避免直接 app.quit() 丢数据。
    if (quitting) return
    quitting = true
    event.preventDefault()
    void readyServer
      .close()
      .catch(() => {})
      .then(() => {
        return assets?.close()
      })
      .finally(() => {
        app.exit(0)
      })
  })
}

void main()