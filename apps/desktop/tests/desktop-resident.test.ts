// @vitest-environment jsdom

/**
 * 桌面主进程的常驻能力：托盘状态、开机自启、首启演示会话、在场监听。
 *
 * electron 在 Node 测试里不是真 Electron，这里换成可控替身（只保证模块可导入、
 * 登录项开关可断言）；被测逻辑本身——种子数据、状态文案、事件判定——不碰
 * Electron API，所以替身不会掩盖真实行为。
 */
import type { WsEvent } from '@ryharness/server'
import { SessionStore } from '@ryharness/session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MinimalSocket, PresenceState } from '../electron/main.ts'
import {
  DEMO_TITLE_PREFIX,
  isAutoLaunchEnabled,
  NEW_CHAT_SCRIPT,
  PresenceMonitor,
  seedFirstLaunchDemo,
  setAutoLaunch,
  trayStatusText,
  websocketUrl,
} from '../electron/main.ts'
import { DEMO_CONVERSATION_PREFIX } from '../renderer/src/components/WelcomeHome.tsx'

// vi.mock 的工厂在 main.ts 被 import 时就跑，必须用 hoisted 才拿得到这里的对象。
const { loginItem } = vi.hoisted(() => {
  return { loginItem: { openAtLogin: false } }
})

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
        return loginItem
      },
      setLoginItemSettings: (settings: { openAtLogin: boolean }) => {
        loginItem.openAtLogin = settings.openAtLogin
      },
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
      getVersion_: () => {
        return '0.1.0'
      },
    },
    BrowserWindow: class {},
    Menu: {
      buildFromTemplate: (template: unknown) => {
        return template
      },
      setApplicationMenu: () => {},
    },
    Tray: class {},
    Notification: {
      isSupported: () => {
        return true
      },
    },
    nativeImage: {
      createFromPath: () => {
        return {
          isEmpty: () => {
            return false
          },
          resize: () => {
            return { isEmpty: () => false }
          },
        }
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

function storeWithTeam(): SessionStore {
  const store = new SessionStore(':memory:')
  for (const [id, name] of [
    ['ryen', 'Ryen'],
    ['ryen-team-coding', '阿码'],
    ['ryen-team-organizer', '阿屉'],
  ] as const) {
    store.upsertAgent({
      id,
      name,
      systemPrompt: '你是测试用的人设。',
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V3',
      tools: [],
      isBuiltin: true,
    })
  }
  return store
}

/** 消息正文（存储层的 contentBlocks 是 unknown[]，按文本块取）。 */
function messageText(message: { contentBlocks: unknown[] } | undefined): string {
  const blocks = message?.contentBlocks ?? []
  return blocks
    .map((block) => {
      return (block as { text?: string }).text ?? ''
    })
    .join('\n')
}

describe('首启演示会话', () => {
  let store: SessionStore | undefined

  beforeEach(() => {
    store = storeWithTeam()
  })

  afterEach(() => {
    store?.close()
    store = undefined
  })

  it('种出一条三人接力群：标题标明示例、调度员是 Ryen、消息与调度事件齐全', () => {
    const result = seedFirstLaunchDemo(store as unknown as SessionStore)
    const conversation = store?.listConversations(1)[0]
    expect(result.memberIds).toEqual(['ryen', 'ryen-team-coding', 'ryen-team-organizer'])
    expect(conversation?.title.startsWith(DEMO_TITLE_PREFIX)).toBe(true)
    expect(conversation?.kind).toBe('group')
    expect(conversation?.memberAgentIds).toHaveLength(3)
    expect(conversation?.dispatcherAgentId).toBe('ryen')

    const messages = store?.listMessages(conversation?.id ?? '', { limit: 50 }) ?? []
    // 首条必须自报家门：演示不是用户的真实历史。
    expect(messages[0]?.senderType).toBe('system')
    expect(messageText(messages[0])).toContain('示例会话')
    expect(
      messages.filter((message) => {
        return message.senderType === 'agent'
      }),
    ).toHaveLength(3)
    // 用户的原话里点了名，接力才有来由。
    expect(messages[1]?.mentions).toEqual(['ryen-team-organizer'])

    const relays = store?.listDispatchEvents(conversation?.id ?? '') ?? []
    expect(relays).toHaveLength(2)
    expect(relays[0]?.reason).toBe('default-dispatcher')
    expect(relays[1]?.reason).toBe('relay @阿屉')
  })

  it('标题前缀与首屏判定同一个字面量（示例会话在首屏能被认出来）', () => {
    expect(DEMO_TITLE_PREFIX).toBe(DEMO_CONVERSATION_PREFIX)
    const store2 = store as unknown as SessionStore
    seedFirstLaunchDemo(store2)
    expect(store2.listConversations(1)[0]?.title.startsWith(DEMO_CONVERSATION_PREFIX)).toBe(true)
  })

  it('已经开过口的库不再插队，删掉示例后也不会被种回来', () => {
    const seeded = seedFirstLaunchDemo(store as unknown as SessionStore)
    expect(seeded.conversationId).toBeDefined()
    // 第二次：库里已经有会话（示例自己也算），不再种。
    expect(seedFirstLaunchDemo(store as unknown as SessionStore).conversationId).toBeUndefined()
    expect(store?.listConversations(10)).toHaveLength(1)

    store?.deleteConversation(seeded.conversationId ?? '')
    expect(store?.listConversations(10)).toHaveLength(0)
  })

  it('小队凑不齐三个就不硬造（不凭空生成不存在的 agent）', () => {
    const lonely = new SessionStore(':memory:')
    lonely.upsertAgent({
      id: 'ryen',
      name: 'Ryen',
      systemPrompt: 'p',
      provider: 'siliconflow',
      model: 'm',
      tools: [],
      isBuiltin: true,
    })
    expect(seedFirstLaunchDemo(lonely)).toEqual({ memberIds: [] })
    expect(lonely.listConversations(10)).toHaveLength(0)
    lonely.close()
  })
})

describe('托盘状态文案', () => {
  const idle: PresenceState = { busy: new Map(), unread: 0 }

  it('空闲、有活、在等人看，三种状态说清楚', () => {
    expect(trayStatusText('RyHarness', idle)).toContain('待命中')
    expect(trayStatusText('RyHarness', { busy: new Map([['c1', new Set(['阿码'])]]), unread: 0 })).toContain(
      '阿码正在回复',
    )
    expect(trayStatusText('RyHarness', { busy: new Map([['c1', new Set(['阿码'])]]), unread: 2 })).toContain(
      '阿码正在回复',
    )
    expect(trayStatusText('RyHarness', { busy: new Map(), unread: 3 })).toContain('3 条新回复')
  })

  it('多个助理同时在跑时说数量，不逐个点名', () => {
    const text = trayStatusText('RyHarness', {
      busy: new Map([
        ['c1', new Set(['阿码'])],
        ['c2', new Set(['阿屉'])],
      ]),
      unread: 0,
    })
    expect(text).toContain('2 位助理')
  })

  it('一个群会话里三位 agent 接力时也算「多位助理」', () => {
    const text = trayStatusText('RyHarness', {
      busy: new Map([['c1', new Set(['阿码', '小美', '老张'])]]),
      unread: 0,
    })
    expect(text).toContain('3 位助理')
  })
})

describe('在场监听的 WS 地址', () => {
  it('http 换 ws、https 换 wss，并带上会话 id', () => {
    expect(websocketUrl('http://127.0.0.1:32100', 'c-1')).toBe('ws://127.0.0.1:32100/ws?conversationId=c-1')
    expect(websocketUrl('https://127.0.0.1:8443/base', 'c 2')).toBe('wss://127.0.0.1:8443/ws?conversationId=c+2')
  })
})

describe('开机自启开关', () => {
  it('读得到当前状态，写入后立刻回显', () => {
    loginItem.openAtLogin = false
    expect(isAutoLaunchEnabled()).toBe(false)
    setAutoLaunch(true)
    expect(loginItem.openAtLogin).toBe(true)
    expect(isAutoLaunchEnabled()).toBe(true)
    setAutoLaunch(false)
    expect(isAutoLaunchEnabled()).toBe(false)
  })
})

describe('在场监听：托盘与通知的信号源', () => {
  const sockets: MinimalSocket[] = []
  let states: PresenceState[] = []
  let replies: { agentName: string; text: string }[] = []
  let focused = false

  function makeMonitor(): PresenceMonitor {
    return new PresenceMonitor({
      baseUrl: 'http://127.0.0.1:32100',
      isFocused: () => {
        return focused
      },
      onState: (state) => {
        states.push(state)
      },
      onReply: (reply) => {
        replies.push(reply)
      },
      createSocket: (url) => {
        expect(url).toContain('/ws?conversationId=')
        const socket: MinimalSocket = {
          onmessage: null,
          onclose: null,
          close: () => {},
        }
        sockets.push(socket)
        return socket
      },
    })
  }

  function push(event: WsEvent): void {
    for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify(event) })
  }

  /** 绕过契约直接塞一条原始推送：专测服务端违约或脏数据时主进程会不会崩。 */
  function pushRaw(data: string): void {
    for (const socket of sockets) socket.onmessage?.({ data })
  }

  beforeEach(() => {
    sockets.length = 0
    states = []
    replies = []
    focused = false
    loginItem.openAtLogin = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return { ok: true, json: async () => ({ conversations: [{ id: 'c1' }] }) } as unknown as Response
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('扫到会话就订阅；agent 一开口就进「在忙」', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    push({
      type: 'message-start',
      conversationId: 'c1',
      senderId: 'ryen-team-coding',
      senderName: '阿码',
      turnIndex: 3,
    })
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['阿码']))
    monitor.stop()
  })

  it('失焦时生成完成 → 弹通知并累计未读；回到前台就不再打扰', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a1', senderName: '阿码', turnIndex: 3 })
    push({ type: 'text-delta', conversationId: 'c1', senderId: 'a1', text: '巷口那家' })
    push({ type: 'text-delta', conversationId: 'c1', senderId: 'a1', text: '可以少辣。' })
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a1', turnIndex: 3 })
    expect(replies).toEqual([{ agentName: '阿码', text: '巷口那家可以少辣。' }])
    expect(states.at(-1)?.unread).toBe(1)
    expect(states.at(-1)?.busy.size).toBe(0)

    // 同一会话再来一轮：窗口在前台，只更新托盘、不通知。
    focused = true
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a1', senderName: '阿码', turnIndex: 4 })
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a1', turnIndex: 4 })
    expect(replies).toHaveLength(1)
    expect(states.at(-1)?.unread).toBe(1)

    monitor.markSeen()
    expect(states.at(-1)?.unread).toBe(0)
    monitor.stop()
  })

  /**
   * 群聊一轮由好几位 agent 接力，后端给它们发的是**同一个 turnIndex**（见
   * apps/server/src/app.ts 的 chatGroup 分支）。每条 message-done 都收口一次的话，
   * 一轮会弹三条通知：头一条带着正文，后两条正文已被清空 → 「这一轮没有文字」，
   * 未读一轮 +3。
   */
  it('群聊一轮三名 agent 各发一次 message-done：只收口一次，一条通知一条未读', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a1', senderName: '阿码', turnIndex: 7 })
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a2', senderName: '小美', turnIndex: 7 })
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['阿码', '小美']))

    push({ type: 'text-delta', conversationId: 'c1', senderId: 'a1', text: '巷口那家' })
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a1', turnIndex: 7 })
    // 第一位说完：这一轮还没结束，不通知也不计未读。
    expect(replies).toHaveLength(0)
    expect(states.at(-1)?.unread).toBe(0)
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['小美']))

    push({ type: 'message-start', conversationId: 'c1', senderId: 'a3', senderName: '老张', turnIndex: 7 })
    push({ type: 'text-delta', conversationId: 'c1', senderId: 'a2', text: '可以少辣。' })
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a2', turnIndex: 7 })
    push({ type: 'text-delta', conversationId: 'c1', senderId: 'a3', text: '再加个汤。' })
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a3', turnIndex: 7 })

    expect(replies).toEqual([{ agentName: '阿码、小美、老张', text: '巷口那家\n可以少辣。\n再加个汤。' }])
    expect(states.at(-1)?.unread).toBe(1)
    expect(states.at(-1)?.busy.size).toBe(0)
    monitor.stop()
  })

  it('派工与工具事件记在同一条轮次上；queued 是用户排队，不点亮托盘', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    // 用户第二条消息在排队：没有轮次在跑时它什么也不是。
    push({ type: 'queued', conversationId: 'c1', senderId: 'user' })
    expect(states).toHaveLength(0)

    // 派工：小美还没开口，这一轮已经在跑，托盘先亮起来。
    push({
      type: 'dispatch',
      conversationId: 'c1',
      fromAgent: 'ryen',
      toAgent: 'a2',
      reason: '这家店你去',
      turnIndex: 7,
    })
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['a2']))

    // 工具事件落在同一条轮次上，不新起一轮（它没 message-start 也算在干活）。
    push({
      type: 'tool-call-start',
      conversationId: 'c1',
      senderId: 'a2',
      callId: 't1',
      name: 'search',
      arguments: '{}',
    })
    push({
      type: 'tool-result',
      conversationId: 'c1',
      senderId: 'a2',
      callId: 't1',
      name: 'search',
      isError: false,
      content: 'ok',
    })
    push({
      type: 'produce-card',
      conversationId: 'c1',
      senderId: 'a2',
      callId: 't2',
      card: { path: 'F:/out/map.png', name: 'map.png', size: 1024, mime: 'image/png' },
    })
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['a2']))

    // 真名到了之后换成名字；这一轮随后正常收口，只通知一次。
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a2', senderName: '小美', turnIndex: 7 })
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['小美']))
    push({ type: 'text-delta', conversationId: 'c1', senderId: 'a2', text: '这家 8 分。' })
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a2', turnIndex: 7 })
    expect(replies).toEqual([{ agentName: '小美', text: '这家 8 分。' }])
    expect(states.at(-1)?.unread).toBe(1)
    expect(states.at(-1)?.busy.size).toBe(0)
    monitor.stop()
  })

  it('中途才连上 WS（漏掉 message-start）也能收口，不会卡在「正在回复」', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    // 只有增量、没有 message-start：先记在占位轮次上。
    push({ type: 'text-delta', conversationId: 'c1', senderId: 'a1', text: '这条是中途接上的' })
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['a1']))
    // message-done 带的是真实 turnIndex，收口照样认（否则托盘永远亮着）。
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a1', turnIndex: 12 })
    expect(replies).toEqual([{ agentName: 'a1', text: '这条是中途接上的' }])
    expect(states.at(-1)?.busy.size).toBe(0)
    monitor.stop()
  })

  it('缺字段的推送整条丢掉：不收口、不通知，也不把托盘带崩', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    // 契约里 message-start / message-done 都带 turnIndex，缺了就是脏数据。
    pushRaw(JSON.stringify({ type: 'message-start', conversationId: 'c1', senderId: 'a1', senderName: '阿码' }))
    pushRaw(JSON.stringify({ type: 'message-done', conversationId: 'c1', senderId: 'a1' }))
    // 产物卡片字段不对，同样丢掉。
    pushRaw(
      JSON.stringify({ type: 'produce-card', conversationId: 'c1', senderId: 'a1', callId: 't1', card: { path: 1 } }),
    )
    // 服务端将来新增的事件类型：不认识就不猜，更不能把监听带崩。
    pushRaw(JSON.stringify({ type: 'brand-new-event', conversationId: 'c1', senderId: 'a1' }))
    expect(states).toHaveLength(0)
    expect(replies).toHaveLength(0)

    // 脏的收尾事件也不能顺手把在跑的那轮收掉——那等于凭空捏造一条通知。
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a1', senderName: '阿码', turnIndex: 5 })
    pushRaw(JSON.stringify({ type: 'message-done', conversationId: 'c1', senderId: 'a1' }))
    expect(replies).toHaveLength(0)
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['阿码']))
    // 真正合规的那条收尾照样生效。
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a1', turnIndex: 5 })
    expect(replies).toHaveLength(1)
    expect(states.at(-1)?.busy.size).toBe(0)
    monitor.stop()
  })

  it('新一轮开跑时，上一轮丢掉收尾事件的残留记账被丢掉', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a1', senderName: '阿码', turnIndex: 9 })
    // 这一轮的收尾没来（断线丢的、或被当成脏数据丢了），托盘还亮着。
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a2', senderName: '小美', turnIndex: 10 })
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['小美']))
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a2', turnIndex: 10 })
    expect(states.at(-1)?.busy.size).toBe(0)
    expect(replies).toEqual([{ agentName: '小美', text: '这一轮没有文字' }])
    monitor.stop()
  })

  it('断线清掉残缺的轮次记账：断线前那一轮不再补通知', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a1', senderName: '阿码', turnIndex: 9 })
    expect(states.at(-1)?.busy.get('c1')).toEqual(new Set(['阿码']))
    // 断线期间事件整段丢失：残缺的记账不能拿来收口，更不能据此弹通知。
    sockets[0]?.onclose?.()
    push({ type: 'message-done', conversationId: 'c1', senderId: 'a1', turnIndex: 9 })
    expect(replies).toHaveLength(0)
    monitor.stop()
  })

  it('主动「已停止」不算故障，不弹通知；真正的错误才提醒', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    push({ type: 'message-start', conversationId: 'c1', senderId: 'a1', senderName: '阿码', turnIndex: 6 })
    push({ type: 'error', conversationId: 'c1', message: '已停止生成', code: 'ABORTED' })
    expect(replies).toHaveLength(0)
    expect(states.at(-1)?.busy.size).toBe(0)

    push({ type: 'error', conversationId: 'c1', message: '模型没有返回内容', code: 'INTERNAL' })
    expect(replies).toEqual([{ agentName: 'RyHarness', text: '模型没有返回内容' }])
    monitor.stop()
  })

  it('用户自己发消息不算「有人在忙」，脏数据也不会把监听带崩', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    push({ type: 'message-start', conversationId: 'c1', senderId: 'user', senderName: '用户', turnIndex: 5 })
    // 用户发言与脏数据都不该让托盘动起来：状态一次都不该被刷新。
    expect(states).toHaveLength(0)
    pushRaw('not-json')
    pushRaw('{"type":123}')
    expect(states).toHaveLength(0)
    monitor.stop()
  })

  it('stop 之后断开全部订阅，不再重连', async () => {
    const monitor = makeMonitor()
    monitor.start()
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    const before = sockets.length
    monitor.stop()
    sockets[0]?.onclose?.()
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(sockets).toHaveLength(before)
  })
})

describe('托盘「新对话」', () => {
  /**
   * 托盘不再替用户决定跟谁聊：脚本只派发事件，渲染层自己回到欢迎页，
   * 「跟 Ryen 聊 / 开个小队」由用户在上面对话框里选。判据是欢迎页真的在屏上。
   */
  it('派发新对话事件，等欢迎页渲染出来才算落地', async () => {
    document.body.innerHTML = '<div class="chat-view"></div>'
    let received = 0
    const listener = (): void => {
      received += 1
      // 渲染层收到事件后把自己切回无选中会话的欢迎页。
      if (document.querySelector('.welcome') !== null) return
      const welcome = document.createElement('div')
      welcome.className = 'welcome'
      document.body.appendChild(welcome)
    }
    window.addEventListener('ryharness:new-chat', listener)
    try {
      // biome-ignore lint/security/noGlobalEval: 脚本本身就是给渲染层 executeJavaScript 用的
      const landed = eval(NEW_CHAT_SCRIPT) as Promise<boolean>
      expect(await landed).toBe(true)
      expect(received).toBeGreaterThan(0)
    } finally {
      window.removeEventListener('ryharness:new-chat', listener)
    }
  })

  it('渲染层没接上事件时如实回报失败，不假装已经开聊', { timeout: 15000 }, async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div class="chat-view"></div>'
    try {
      // biome-ignore lint/security/noGlobalEval: 同上
      const landed = eval(NEW_CHAT_SCRIPT) as Promise<boolean>
      await vi.advanceTimersByTimeAsync(20 * 150)
      expect(await landed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
