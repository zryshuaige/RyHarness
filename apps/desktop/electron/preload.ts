/**
 * Preload：API 地址走窗口 URL query / executeJavaScript 注入，preload 只暴露
 * 渲染层确实需要的主进程能力（contextIsolation 下唯一的安全通道）。
 *
 * 桥面刻意保持小：不给 ipcRenderer 本身，只给「一个能调用的函数」和一个「能说一声
 * 的通道」。主题这条是"说一声"型（单向推送），不是回调型——主进程不需要反过来问
 * 渲染层什么。
 */
import { contextBridge, ipcRenderer } from 'electron'

const bridge = {
  appName: 'RyHarness',
  /** 用系统文件管理器打开目录；resolve 空串表示成功（shell.openPath 约定）。 */
  openPath: (targetPath: string): Promise<string> => {
    return ipcRenderer.invoke('ryharness:open-path', targetPath)
  },
  /**
   * 告诉主进程当前主题（原生标题栏要跟着换配色）。
   *
   * 单向推送：主进程不需要再反过来问渲染层。取值只有 light / dark，其余一律丢掉。
   */
  setTheme: (theme: string): void => {
    if (theme !== 'light' && theme !== 'dark') return
    ipcRenderer.send('ryharness:theme', theme)
  },
}

contextBridge.exposeInMainWorld('ryharnessDesktop', bridge)
