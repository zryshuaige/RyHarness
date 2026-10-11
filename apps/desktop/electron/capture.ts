/**
 * 截图模式（RYAGENT_CAPTURE=1 时由 main.ts 调用）：
 * 服务启动后造演示数据、隐藏窗口加载渲染层、capturePage 存 capture.png。
 */
import type { BrowserWindow } from 'electron'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RyAgentServer } from '@ryagent/server'

export async function runCapture(server: RyAgentServer, here: string, createWindow: () => Promise<BrowserWindow>): Promise<void> {
  const dataDir = join(tmpdir(), `ryagent-capture-${Date.now()}`)
  // 演示数据：Coding Agent + 群 + 一条用户消息，让三栏都有内容。
  await fetch(`${server.url}/api/agents/ryen`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'mock' }) })
  const coder = await (await fetch(`${server.url}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateKey: 'coding', name: 'CodeBot', provider: 'mock', model: 'mock' }) })).json() as { agent: { id: string } }
  const conv = await (await fetch(`${server.url}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'group', memberAgentIds: ['ryen', coder.agent.id], title: '产品三人组' }) })).json() as { conversation: { id: string } }
  await fetch(`${server.url}/api/conversations/${conv.conversation.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '大家好，这是界面截图测试' }) })
  console.log('[capture] seed done')

  const window = await createWindow()
  window.webContents.on('console-message', (_event, _level, message) => { console.log('[renderer]', message) })
  window.webContents.on('did-fail-load', (_e, code, text) => { console.log('[capture] fail-load', code, text) })
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => { resolve() })
  })
  await new Promise((resolve) => { return setTimeout(resolve, 3500) })
  const image = await window.webContents.capturePage()
  writeFileSync(join(here, 'capture.png'), image.toPNG())
  console.log('[capture] saved capture.png')
  await window.close()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
}
