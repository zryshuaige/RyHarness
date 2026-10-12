/**
 * Electron 主进程：内嵌启动 @ryagent/server（随机端口），创建窗口。
 * 开发模式加载 Vite dev server（RYAGENT_DEV_SERVER_URL），生产模式
 * serve 渲染层构建产物（renderer/dist）。
 */
import { join, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { RyAgentServer } from '@ryagent/server'
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
  ].filter((p): p is string => { return typeof p === 'string' && p.length > 0 })
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

async function createWindow(apiBase: string, show = true): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    show,
    backgroundColor: '#FAF7F2',
    title: 'RyAgent',
    icon: join(here, '../assets/icon-256.png'),
    webPreferences: {
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 截图模式用离屏渲染，避免依赖可见窗口的合成器状态。
      ...show ? {} : { offscreen: true },
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
  await app.whenReady()

  const server = await RyAgentServer.create({
    // 端口 0 = 随机空闲端口；要固定端口可设 RYAGENT_PORT。
    port: Number(process.env.RYAGENT_PORT ?? '0') || 0,
    host: '127.0.0.1',
    dataDir: process.env.RYAGENT_DATA_DIR ?? join(app.getPath('userData'), 'ryagent-data'),
  })

  await createWindow(server.url)

  if (process.env.RYAGENT_CAPTURE === '1') {
    await runCapture(server, here, () => { return createWindow(server.url, false) })
    app.exit(0)
    return
  }

  app.on('activate', () => {
    // macOS 点击 Dock 图标：复用已有 server 实例，只在窗口全关时重建窗口。
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow(server.url)
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => {
    void server.close()
  })
}

void main()
