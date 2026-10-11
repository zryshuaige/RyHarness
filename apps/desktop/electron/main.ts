/**
 * Electron 主进程：内嵌启动 @ryagent/server（随机端口），创建窗口。
 * 开发模式加载 Vite dev server（RYAGENT_DEV_SERVER_URL），生产模式
 * serve 渲染层构建产物（renderer/dist）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { RyAgentServer } from '@ryagent/server'
import { runCapture } from './capture.ts'

const here = dirname(fileURLToPath(import.meta.url))

async function createWindow(apiBase: string, show = true): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    show,
    backgroundColor: '#fff7ed',
    title: 'RyAgent',
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
    if (BrowserWindow.getAllWindows().length === 0) {
      void RyAgentServer.create({ port: 0, host: '127.0.0.1', dataDir: process.env.RYAGENT_DATA_DIR ?? '' })
        .then((again) => { return createWindow(again.url) })
        .then((window) => { window.focus() })
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
