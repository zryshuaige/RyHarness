/**
 * Preload：API 地址走窗口 URL query / executeJavaScript 注入，preload 只暴露
 * 渲染层确实需要的主进程能力（contextIsolation 下唯一的安全通道）。
 */
import { contextBridge, ipcRenderer } from 'electron'

const bridge = {
  appName: 'RyAgent',
  /** 用系统文件管理器打开目录；resolve 空串表示成功（shell.openPath 约定）。 */
  openPath: (targetPath: string): Promise<string> => {
    return ipcRenderer.invoke('ryagent:open-path', targetPath)
  },
}

contextBridge.exposeInMainWorld('ryagentDesktop', bridge)
