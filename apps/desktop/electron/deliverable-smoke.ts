import { BrowserWindow } from 'electron'

export interface DeliverableWindow {
  webContents: {
    session: {
      clearStorageData(options: { storages: string[] }): Promise<void>
    }
    loadFile(path: string): Promise<void>
    executeJavaScript(script: string): Promise<unknown>
    reload(): void
  }
  hide(): void
}

function createWindow(): DeliverableWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'ryharness-capture-deliverable',
    },
  })
}

export async function verifyGeneratedApp(
  path: string,
  windowFactory: () => DeliverableWindow = createWindow,
): Promise<void> {
  const window = windowFactory()
  try {
    await window.webContents.session.clearStorageData({ storages: ['localstorage'] })
    await window.webContents.loadFile(path)
    const total = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#amount').value = '12.5'
      document.querySelector('#add').click()
      return document.querySelector('#total').textContent
    })()`)
    if (total !== '12.5') throw new Error(`记账产物点击后的汇总不对：${total}`)
    await window.webContents.reload()
    const restored = await window.webContents.executeJavaScript(`document.querySelector('#total').textContent`)
    if (restored !== '12.5') throw new Error(`记账产物刷新后的汇总不对：${restored}`)
    console.log('[deliverable] 真实窗口：记一笔 → 汇总 12.5 → 刷新后仍在 ✓')
  } finally {
    // 主窗口还没创建，关闭唯一窗口会让 Electron 提前退出；验证窗随截图进程一起回收。
    window.hide()
  }
}
