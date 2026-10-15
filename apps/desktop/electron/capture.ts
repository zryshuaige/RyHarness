/**
 * 截图模式（RYAGENT_CAPTURE=1 时由 main.ts 调用）：
 * 服务启动后造演示数据、可见窗口加载渲染层、capturePage 存 capture.png。
 * （必须用可见窗口：隐藏/offscreen 窗口的 capturePage 会挂起不返回。）
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RyAgentServer } from '@ryagent/server'
import type { BrowserWindow } from 'electron'

export async function runCapture(
  server: RyAgentServer,
  here: string,
  createWindow: () => Promise<BrowserWindow>,
): Promise<void> {
  // 演示数据：Coding Agent + 群 + 两条消息，让三栏都有内容。
  // 消息直接写 store（不走 POST /messages——那会触发 agent turn，
  // 无 mock 适配器时产生 NO_ADAPTER 错误气泡，有 key 时甚至打真实 API）。
  // 走 HTTP 的两发要带 token：桌面端的后端默认是鉴权的。
  const post = async (path: string, payload: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(server.apiToken === undefined ? {} : { authorization: `Bearer ${server.apiToken}` }),
      },
      body: JSON.stringify(payload),
    })
    return (await response.json()) as Record<string, unknown>
  }
  const created = await post('/api/agents', { templateKey: 'coding', name: 'CodeBot' })
  const coder = created.agent as { id: string }
  const conv = await post('/api/conversations', {
    kind: 'group',
    memberAgentIds: ['ryen', coder.id],
    title: '产品三人组',
  })
  const conversation = conv.conversation as { id: string }
  server.store.appendMessage({
    conversationId: conversation.id,
    senderType: 'user',
    contentBlocks: [{ type: 'text', text: '大家好，这是界面截图测试' }],
  })
  server.store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '收到喵——我是 Ryen，这是截图模式的演示消息。' }],
    turnIndex: 1,
  })
  console.log('[capture] seed done')

  // createWindow 内部已 await loadFile/loadURL（did-finish-load 已发生），
  // 这里不能再等该事件（监听注册晚于触发会永久挂起），只留渲染 settle 时间。
  const window = await createWindow()
  window.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message)
  })
  window.webContents.on('did-fail-load', (_e, code, text) => {
    console.log('[capture] fail-load', code, text)
  })
  await new Promise((resolve) => {
    return setTimeout(resolve, 3500)
  })
  const image = await window.webContents.capturePage()
  writeFileSync(join(here, 'capture.png'), image.toPNG())
  console.log('[capture] saved capture.png')
  await window.close()
}
