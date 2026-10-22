// @vitest-environment jsdom

/**
 * 通知的三道闸：全局免打扰 / 窗口在前台 / 会话被静音。
 *
 * 「静音」此前是个空承诺：渲染层把 muted 写进服务端、服务端持久化并回传、
 * 列表上也画了「已静音」角标并压掉未读徽标——唯独主进程的通知路径从不读
 * 这个标记。用户为了躲一个吵闹的群而静音，系统通知照样弹。
 *
 * 静音集合不额外打后端：会话列表本来就每 5 秒扫一次（ PresenceMonitor 的
 * discover），扫描时顺手把 muted 的会话 id 收进来即可。
 *
 * @module @ryharness/desktop/tests/notify-mute
 */

import type { WsEvent } from '@ryharness/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MinimalSocket } from '../electron/main.ts'
import { PresenceMonitor } from '../electron/main.ts'

vi.mock('electron', () => {
  return {
    app: {
      getPath: () => {
        return 'C:/tmp/ryharness'
      },
      getAppPath: () => {
        return 'C:/app'
      },
      getVersion: () => {
        return '0.1.0'
      },
      getLoginItemSettings: () => {
        return { openAtLogin: false }
      },
      setLoginItemSettings: () => {},
      setAppUserModelId: () => {},
      requestSingleInstanceLock: () => {
        return true
      },
      whenReady: () => {
        return Promise.resolve()
      },
      on: () => {},
      quit: () => {},
      exit: () => {},
    },
    BrowserWindow: class {},
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
    Tray: class {},
    Notification: { isSupported: () => true },
    nativeImage: {
      createFromPath: () => {
        return { isEmpty: () => false, resize: () => ({ isEmpty: () => false }) }
      },
      createEmpty: () => {
        return { isEmpty: () => true }
      },
    },
    ipcMain: { handle: () => {} },
    dialog: {},
    screen: {},
    shell: {},
  }
})

/** 会话列表扫描的返回（第二个会话静音）。 */
const CONVERSATIONS = [
  { id: 'loud', muted: false },
  { id: 'quiet', muted: true },
]

let sockets: Map<string, MinimalSocket> = new Map()
let replies: { agentName: string; text: string }[] = []
let dnd = false
let focused = false

beforeEach(() => {
  sockets = new Map()
  replies = []
  dnd = false
  focused = false
  // 只桩掉会话列表这一个接口：形状上不需要断言成完整的 Response，
  // 也不该用 `as unknown as` 把它掰成那样（类型逃逸棘轮盯着这一条）。
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string) => {
      return {
        ok: true,
        json: async () => {
          return { conversations: CONVERSATIONS }
        },
      }
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeMonitor(onState?: (state: { unread: number }) => void): PresenceMonitor {
  return new PresenceMonitor({
    baseUrl: 'http://127.0.0.1:32100',
    isFocused: () => {
      return focused
    },
    isDnd: () => {
      return dnd
    },
    onState: (state) => {
      onState?.({ unread: state.unread })
    },
    onReply: (reply) => {
      replies.push(reply)
    },
    createSocket: (url) => {
      const conversationId = new URL(url).searchParams.get('conversationId') ?? ''
      const socket: MinimalSocket = { onmessage: null, onclose: null, close: () => {} }
      sockets.set(conversationId, socket)
      return socket
    },
  })
}

/** 等一次会话列表扫描落地（discover 是异步的）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 5)
  })
}

/** 让某个会话里的某位 agent 说完一整轮。 */
function speakTurn(conversationId: string, turnIndex: number): void {
  const events: WsEvent[] = [
    { type: 'message-start', conversationId, senderId: 'ryen', senderName: 'Ryen', turnIndex },
    { type: 'text-delta', conversationId, senderId: 'ryen', text: '说完了' },
    { type: 'message-done', conversationId, senderId: 'ryen', turnIndex },
  ]
  // 每个会话各连各的 WS：事件只投给这个会话自己的那条连接。
  const socket = sockets.get(conversationId)
  for (const event of events) socket?.onmessage?.({ data: JSON.stringify(event) })
}

describe('通知的三道闸', () => {
  it('未静音的会话照常弹通知', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await settle()
    speakTurn('loud', 1)
    expect(replies.length).toBe(1)
    expect(replies[0]?.text).toContain('说完了')
    monitor.stop()
  })

  it('静音的会话不弹通知', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await settle()
    speakTurn('quiet', 1)
    expect(replies.length).toBe(0)
    monitor.stop()
  })

  it('全局免打扰开着时一律不弹', async () => {
    dnd = true
    const monitor = makeMonitor()
    monitor.start()
    await settle()
    speakTurn('loud', 1)
    expect(replies.length).toBe(0)
    monitor.stop()
  })

  it('窗口在前台时不弹（既有行为，不被静音改动带偏）', async () => {
    focused = true
    const monitor = makeMonitor()
    monitor.start()
    await settle()
    speakTurn('loud', 1)
    expect(replies.length).toBe(0)
    monitor.stop()
  })

  it('静音的会话连未读都不累计（静音的约定是"不弹未读"）', async () => {
    const states: { unread: number }[] = []
    const watched = makeMonitor((state) => {
      states.push(state)
    })
    watched.start()
    await settle()
    speakTurn('quiet', 1)
    expect(states.at(-1)?.unread).toBe(0)
    watched.stop()
  })
})
