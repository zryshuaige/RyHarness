/**
 * 主进程能力的类型化入口。
 *
 * 渲染层默认按「浏览器也能跑」设计（vite dev、渲染层单测都没有 preload），所以
 * 这里的能力一律**可选**：拿不到桥就返回 false，由调用方给出可执行的替代提示，
 * 绝不假装成功。桥的形状由 electron/preload.ts 的 contextBridge 决定。
 */
export interface DesktopBridge {
  appName: string
  /** 用系统文件管理器打开目录；resolve 的空串表示成功（Electron shell.openPath 约定）。 */
  openPath?: (targetPath: string) => Promise<string>
}

declare global {
  interface Window {
    ryagentDesktop?: DesktopBridge
  }
}

function bridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return window.ryagentDesktop
}

/** 是否运行在带主进程桥的桌面壳里。 */
export function hasDesktopBridge(): boolean {
  return bridge() !== undefined
}

/** 打开本地目录；不支持或失败返回 false。 */
export async function openInFileManager(targetPath: string): Promise<boolean> {
  const openPath = bridge()?.openPath
  if (openPath === undefined) return false
  try {
    return (await openPath(targetPath)) === ''
  } catch {
    return false
  }
}

/** 复制文本到剪贴板；不可用返回 false。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
