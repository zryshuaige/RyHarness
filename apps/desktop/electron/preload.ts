/**
 * Preload：当前实现把 API 地址放在窗口 URL query 里，渲染层直接读取，
 * preload 只保留接口形状（后续加敏感能力时从这里暴露）。
 */
import { contextBridge } from 'electron'

const bridge = {
  appName: 'RyAgent',
}

contextBridge.exposeInMainWorld('ryagentDesktop', bridge)
