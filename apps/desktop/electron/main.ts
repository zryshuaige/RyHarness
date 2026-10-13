/**
 * Electron 主进程：内嵌启动 @ryagent/server（随机端口），创建窗口。
 * 开发模式加载 Vite dev server（RYAGENT_DEV_SERVER_URL），生产模式
 * serve 渲染层构建产物（renderer/dist）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RyAgentServer } from '@ryagent/server'
import { app, BrowserWindow } from 'electron'
import { runCapture } from './capture.ts'

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

async function createWindow(apiBase: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#FAF7F2',
    title: 'RyAgent',
    icon: join(here, '../assets/icon-256.png'),
    webPreferences: {
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // 通过 query 把 API 地址交给渲染层（contextIsolation 下不走全局变量）。
  const devServerUrl = process.env.RYAGENT_DEV_SERVER_URL
  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    await window.loadURL(`${devServerUrl}${devServerUrl.includes('?') ? '&' : '?'}api=${encodeURIComponent(apiBase)}`)
  } else {
    await window.loadFile(join(here, '../renderer/dist/index.html'), {
      search: `?api=${encodeURIComponent(apiBase)}`,
    })
  }
  return window
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

  const server = await RyAgentServer.create({
    // 端口 0 = 随机空闲端口；要固定端口可设 RYAGENT_PORT。
    port: Number(process.env.RYAGENT_PORT ?? '0') || 0,
    host: '127.0.0.1',
    dataDir: process.env.RYAGENT_DATA_DIR ?? join(app.getPath('userData'), 'ryagent-data'),
  })

  if (isCapture) {
    // 截图用可见窗口：隐藏/offscreen 窗口的 capturePage 会挂起不返回。
    // here 是打包产物目录（main/），capture.png 写到应用根目录便于查找。
    await runCapture(server, join(here, '..'), () => {
      return createWindow(server.url)
    })
    app.exit(0)
    return
  }

  await createWindow(server.url)

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
      void createWindow(server.url)
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
    void server.close().finally(() => {
      app.exit(0)
    })
  })
}

void main()
