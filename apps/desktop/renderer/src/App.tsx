import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { matchShortcut, SEARCH_FOCUS_EVENT } from '../../shared/shortcuts.ts'
import type { AgentDef, AgentTemplate, Conversation, ProviderInfo, ProviderPreset } from './api.ts'
import { ApiClient } from './api.ts'
import type { ArtifactTarget } from './components/ArtifactPreview.tsx'
import { ArtifactPreview } from './components/ArtifactPreview.tsx'
import { Cat } from './components/Cat.tsx'
import { ChatView } from './components/ChatView.tsx'
import { ConfirmDialog } from './components/ConfirmDialog.tsx'
import { ContactsPage, CreateAgentModal } from './components/ContactsPage.tsx'
import { ConversationList } from './components/ConversationList.tsx'
import { ErrorBoundary, reportRenderCrash } from './components/ErrorBoundary.tsx'
import { GroupSettingsModal } from './components/GroupSettingsModal.tsx'
import type { IconName } from './components/Icon.tsx'
import { Icon } from './components/Icon.tsx'
import { MePage } from './components/MePage.tsx'
import { PluginsPage } from './components/PluginsPage.tsx'
import { RightPanel } from './components/RightPanel.tsx'
import { RyVibePage } from './components/RyVibePage.tsx'
import { ToastHost } from './components/ToastHost.tsx'
import { DEMO_CONVERSATION_PREFIX, WelcomeHome, type WelcomeTarget } from './components/WelcomeHome.tsx'
import { agentById } from './lib/agents.ts'
import { useApiBase } from './lib/boot.ts'
import { markFirstInteractive } from './lib/boot-trace.ts'
import type { Command } from './lib/commands.ts'
import { openInFileManager, reportTheme } from './lib/desktop.ts'
import { errorDetail, humanError } from './lib/error-text.ts'
import { type AffinityTier, affinityTier, normalizePersona } from './lib/persona.ts'
import { readSetting, writeSetting } from './lib/storage.ts'
import { toast } from './lib/toast.ts'
import type { TurnErrorTarget } from './lib/turn-errors.ts'
import { withViewTransition } from './lib/view-transition.ts'
import { ConversationCache } from './store.ts'

type Tab = 'chats' | 'vibe' | 'contacts' | 'plugins' | 'me'

type Theme = 'light' | 'dark'

/** 已读等高频刷新事件的合并窗口（ms）。 */
const REFRESH_DEBOUNCE_MS = 800

/**
 * 托盘「新对话」抛给渲染层的事件名。
 *
 * 主进程没有渲染层状态句柄，此前托盘替用户做了决定：切到通讯录 → 点 Ryen 的
 * 「发消息」，于是「开个小队」这条路从托盘出发永远不存在。现在由页面自己接：
 * 事件把窗口带回欢迎页，去向（跟 Ryen 聊 / 开个小队）由用户在上面选。
 * main.ts 的 NEW_CHAT_SCRIPT 只负责派发这个事件。
 */
export const NEW_CHAT_EVENT = 'ryharness:new-chat'
/**
 * 系统通知点击「落到那条会话」的事件名。
 *
 * 与 electron/main.ts 的 OPEN_CONVERSATION_EVENT 是同一个字符串（两边各自打包、
 * 只靠名字对齐，改一边必须改另一边）。detail 带目标会话 id：IM 的肌肉记忆是
 * 「点通知 → 落到那条聊天」，而不是窗口弹起来之后自己去翻是谁回了话。
 */
export const OPEN_CONVERSATION_EVENT = 'ryharness:open-conversation'
/**
 * 无存储时的兜底：跟随系统深浅色。此前一律硬回浅色，等于把系统设置反着来——
 * Windows 开着暗色的用户一进窗口就是一片奶油色，还得自己翻设置才发现能改。
 */
function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 导出供测试与 App 共用：口径必须与 renderer/index.html 的内联脚本一致。 */
export function loadTheme(): Theme {
  try {
    const stored = readSetting('ryharness-theme')
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // 隐私模式下 localStorage 不可用，继续往系统偏好上退。
  }
  return systemTheme()
}

/** 应用 documentElement 的 data-theme（供测试与 App 共用）。 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  // 原生标题栏的配色跟着换：主进程此前是每 400ms 问一次渲染层「现在什么主题」，
  // 现在改成切主题时推一声——那次跨进程往返只在真的切主题时发生。
  reportTheme(theme)
}

/** 右栏展开态的存储键：与 ryharness-theme 同一层，只归渲染层的界面偏好。 */
const PANEL_COLLAPSED_KEY = 'ryharness-panel-collapsed'
/** 左栏（会话列表）收起态的存储键：与右栏同一层，界面偏好而已。 */
const LIST_COLLAPSED_KEY = 'ryharness-list-collapsed'

/**
 * 右栏（信息板）默认收起。
 *
 * 整块面板是给「想看细节的人」准备的：群聊里一展开就是成员网格、调度轨迹、产物三段
 * 机制，而首屏真正要用的对话被挤到右边去。首启默认收起，用户按需展开。
 *
 * 存储里没有这个键 = 第一次启动，按收起走；一旦有过记录就以用户自己的选择为准——
 * 亲手展开过一次的人（正在盯产物、或习惯开着资料卡），下一次启动不该又被按回去。
 *
 * 导出供测试与 App 共用：读与写必须同一套口径。
 */
export function loadPanelCollapsed(): boolean {
  try {
    const stored = readSetting(PANEL_COLLAPSED_KEY)
    if (stored === '1') return true
    if (stored === '0') return false
  } catch {
    // 隐私模式下 localStorage 不可用，这一版就按默认的收起走。
  }
  return true
}

/**
 * 右栏改走覆盖式抽屉的断点（视口宽度 ≤ 这个值算窄）。
 *
 * 与 styles.css 里那条 @media (max-width: 1199px) 是同一个数：两处各写一份，迟早
 * 对不上，而对不上的表现很难查（按钮出现了、面板不出来）。
 */
export const NARROW_PANEL_MAX_WIDTH = 1199

/** 当前视口是不是窄窗。 */
export function isNarrowViewport(): boolean {
  if (typeof window === 'undefined') return false
  return window.innerWidth <= NARROW_PANEL_MAX_WIDTH
}

/**
 * 左栏（会话列表）默认**展开**。
 *
 * 与右栏相反：右栏是"给想看细节的人准备的附加信息"，首屏默认收起；左栏是
 * 应用的主导航（切会话、搜索、全文搜索命中都在这儿），默认收起等于把主
 * 导航藏起来。
 *
 * 存过就以用户自己的选择为准；没有记录 = 第一次启动，按展开走。
 *
 * 导出供测试与 App 共用：读与写必须同一套口径。
 */
export function loadListCollapsed(): boolean {
  try {
    const stored = readSetting(LIST_COLLAPSED_KEY)
    if (stored === '1') return true
    if (stored === '0') return false
  } catch {
    // 隐私模式下 localStorage 不可用，这一版就按默认的展开走。
  }
  return false
}

const RAIL_TABS: { key: Tab; icon: IconName; label: string; beta?: boolean }[] = [
  { key: 'chats', icon: 'chat-bubble', label: '聊天' },
  // RyVibe 放在「聊天」下面、「通讯录」上面：它是**动手做东西**的入口，位置上紧挨
  // 聊天（那也是你和小队说话的地方），但它是一个独立页面，不是一条会话。
  { key: 'vibe', icon: 'sparkles', label: 'RyVibe', beta: true },
  { key: 'contacts', icon: 'users', label: '通讯录' },
  // 插件是「能力」而不是「设置」：它决定助理能做什么、哪些界面会出现在应用里，
  // 与供应商/主题这类偏好不是同一层。独立页签让开关不必藏在「我的」页深处。
  { key: 'plugins', icon: 'blocks', label: '插件' },
  // 「我的」是用户自己的页面，不是 Ryen。品牌猫只出现在两处：栏顶 logo 与 Ryen 的
  // 头像位——它是产品标识，不是导航图标；挂在导航里既和旁边 20px 的线性图标不是一个
  // 重量，16px 下也糊成一小团。
  { key: 'me', icon: 'user', label: '我的' },
]

/**
 * 一次亲密度跨档：该告诉用户的是"谁、和谁的关系变了、变成了什么"。
 *
 * 判定挂在**档位**而不是分数上：内核每轮都涨（nextAffinity 的轮次增益），按分数报
 * 「又涨了 N 分」等于每隔几轮弹一次，正是养成产品最容易变成噪音的做法；档位只有四档，
 * 一位 agent 一辈子最多跨三次——稀有才有分量。
 */
export interface AffinityMilestone {
  agentId: string
  name: string
  affinity: number
  tier: AffinityTier
  /** 升档（true）还是掉档（false）。 */
  up: boolean
}

/**
 * 比出这一轮跨档了谁（纯函数，供测试直接断言）。
 *
 * previous 是上一次看到的「agentId → 亲密度」。第一次见到的人不产生跨档——那不是关系
 * 变了，只是数据到齐了。用户手改人格把亲密度调高/调低同样不算：那是他自己的操作，
 * 不是「聊出来的」，壳里用 turnEnded 闸门把这类变化挡在外面。
 */
export function affinityMilestones(
  previous: ReadonlyMap<string, number>,
  agents: readonly AgentDef[],
): AffinityMilestone[] {
  const out: AffinityMilestone[] = []
  for (const agent of agents) {
    const before = previous.get(agent.id)
    if (before === undefined) continue
    const affinity = normalizePersona(agent.persona).affinity
    const from = affinityTier(before)
    const tier = affinityTier(affinity)
    if (from.key === tier.key) continue
    out.push({ agentId: agent.id, name: agent.name, affinity, tier, up: tier.max > from.max })
  }
  return out
}

/** 后端就绪前的骨架屏（复用既有样式类，不新增 CSS）。 */
function BootSkeleton() {
  return (
    <div className="app-shell" aria-busy="true">
      <div className="chat-view">
        <div className="chat-scroll">
          <div className="chat-col">
            <p className="chat-hint">正在启动本地服务…</p>
            {[72, 56, 88, 64].map((width, _index) => (
              <div className="skeleton-item" key={width}>
                <span className="skeleton" style={{ width, height: 16, borderRadius: 8 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 启动失败的「现象 + 下一步」。`fetch failed` / `HTTP 500` 是网络层的原话，
 * 不该是用户第一眼读到的东西；原始串收进错误页的「详情」。
 */
export function startupFailureHint(error: string): string {
  if (/fetch failed|failed to fetch|econnrefused|enotfound|network|offline|timed? ?out/i.test(error)) {
    return '本机服务没有响应。它可能还没启动，或者刚启动就退出了。'
  }
  if (/\bHTTP 5\d\d\b/i.test(error)) return '本机服务内部出错了，重启应用通常能恢复。'
  if (/\bHTTP 401\b|unauthorized/i.test(error)) return '本机服务的访问凭据对不上，重启应用会重新发放。'
  return '本机服务暂时不可用。'
}

export function App() {
  // 主进程窗口先行启动：后端就绪前先渲染骨架。
  const apiBase = useApiBase()
  const [api, setApi] = useState<ApiClient | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('chats')
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  /** 供应商预设目录：首屏「先挑一家」用。 */
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [modal, setModal] = useState<'agent' | 'group' | undefined>(undefined)
  /** 正在预览的产物。气泡里的文件卡与右栏的产物行共用这一个出口。 */
  const [preview, setPreview] = useState<ArtifactTarget | undefined>(undefined)
  const openPreview = useCallback((file: ArtifactTarget) => {
    setPreview(file)
  }, [])
  /** 正在改设置的群（群设置弹窗）；建群走 modal='group'。 */
  const [editingGroup, setEditingGroup] = useState<Conversation | undefined>(undefined)
  /** 待确认删除的 agent（确认弹窗内完成，避免 window.confirm 割裂界面）。 */
  const [deletingAgent, setDeletingAgent] = useState<AgentDef | undefined>(undefined)
  /** 新建 agent 时的初始模板（通讯录模板轨带入）。 */
  const [agentTemplateKey, setAgentTemplateKey] = useState<string | undefined>(undefined)
  /** 非空 = 编辑既有 agent。 */
  const [editingAgent, setEditingAgent] = useState<AgentDef | undefined>(undefined)
  const [panelCollapsed, setPanelCollapsed] = useState(loadPanelCollapsed)
  const [listCollapsed, setListCollapsed] = useState(loadListCollapsed)
  /**
   * 窄窗判定：视口宽度不够时右栏改走**覆盖式抽屉**。
   *
   * 此前是"整块 display:none"——记忆、手册、待办、调度轨迹在这个宽度下**一个入口
   * 都没有**：内容还在服务端，界面上既看不到也打不开。改成抽屉后内容照旧，只是不再
   * 占固定的一列（那一列在这个宽度下会把消息挤到不可读）。
   *
   * 断点与 styles.css 里的 @media 是同一个数：两处各写一份，迟早会对不上，
   * 对不上的表现是"按钮出现了但面板不出来"。
   */
  const [narrow, setNarrow] = useState(isNarrowViewport)
  /** 窄窗下抽屉的开关（宽窗时忽略：那时右栏常驻，开关由 panelCollapsed 管）。 */
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  /**
   * 欢迎页发出的首条消息，交给 ChatView 在「订阅已建立」之后发出去。
   * 这里直接 postMessage 的话，202 之前服务端就已经开始推这一轮的事件，而 ChatView
   * 此刻还没挂载——首屏那句话的事件全落在订阅建立之前，用户看到的是"发了没反应"。
   */
  const [pendingSend, setPendingSend] = useState<{ conversationId: string; text: string } | undefined>(undefined)
  /**
   * 亲密度外显：上一次看到的每位 agent 的分数 + 「刚刚跑完一轮」的闸门。
   *
   * 闸门的作用是把「关系变了」与「用户自己改了设置」分开：只有聊天真的跑完一轮
   * （ChatView 的 onTurnEnd）才允许报喜，手改人格里的滑杆不弹。
   */
  const affinitySeen = useRef(new Map<string, number>())
  const turnEnded = useRef(false)
  // 注意：App **不**订阅 chat store——流式 token 的 40ms 通知不应该带动整棵树重渲染。
  // 右栏在 RightPanel.tsx 内自行 useChat(store)。
  //
  // 会话缓存：切会话不重挂聊天区，而是换一个桶（store + 已加载历史 + 滚动锚点 + 草稿）。
  // 详见 store.ts 的 ConversationCache；这个壳只负责把当前会话的桶交出去。
  const [cache] = useState(() => {
    return new ConversationCache()
  })

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    if (apiBase === undefined) return
    setApi(new ApiClient(apiBase))
  }, [apiBase])

  // 展开态跟着用户走（首启那次写入的是默认值，无害）。存不上只是下次启动回到默认，
  // 不影响这一次的操作——因此这里吞掉失败，与 changeTheme 的持久化同一口径。
  useEffect(() => {
    try {
      writeSetting(PANEL_COLLAPSED_KEY, panelCollapsed ? '1' : '0')
    } catch {
      // 忽略持久化失败。
    }
  }, [panelCollapsed])

  const togglePanel = useCallback(() => {
    setPanelCollapsed((v) => {
      return !v
    })
  }, [])

  /**
   * 视口宽窄变化：窄了就把抽屉关掉（宽窗下右栏本来就在流程里，界面上的开关没有
   * 对应物，留着会让窗口一放大就凭空多出一层遮罩）。
   */
  useEffect(() => {
    const onResize = (): void => {
      setNarrow((prev) => {
        const next = isNarrowViewport()
        if (next === prev) return prev
        if (!next) setDrawerOpen(false)
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  /** 窄窗抽屉的开关。宽窗时这个动作交给右栏自己的收起键。 */
  const toggleDrawer = useCallback(() => {
    setDrawerOpen((v) => {
      return !v
    })
  }, [])

  /**
   * 错误条/失败横幅上「去配 Key、去改 agent」的跳转：聊天页与 RyVibe 共用同一份
   * 接线，两个页面给的下一步才是同一条路。重试类动作不经过这里（各页就地做）。
   */
  const navigateFromError = useCallback((target: TurnErrorTarget): void => {
    if (target === 'retry') return
    if (target === 'contacts') {
      setTab('contacts')
      return
    }
    setTab('me')
    // 供应商区块在「我的」页中段：直接跳过去，省得用户再滚一遍。
    requestAnimationFrame(() => {
      document.getElementById('provider-settings')?.scrollIntoView({ block: 'center' })
    })
  }, [])

  /** Esc 关掉抽屉：抽屉盖着聊天区，不给一个键盘出口就等于把它锁住。 */
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [drawerOpen])

  // 左栏的收起态同样跟着用户走：窄窗口下左栏会被媒体查询挤窄，手动收起
  // 是把宽度还给聊天区的唯一办法（CSS 里 .list-panel-toggle 的位置就写在
  // 搜索框右侧那一格）。
  useEffect(() => {
    try {
      writeSetting(LIST_COLLAPSED_KEY, listCollapsed ? '1' : '0')
    } catch {
      // 忽略持久化失败。
    }
  }, [listCollapsed])

  const toggleList = useCallback(() => {
    setListCollapsed((v) => {
      return !v
    })
  }, [])

  const changeTheme = useCallback(
    (next: Theme): void => {
      if (next === theme) return
      // 走 View Transition 的 root 交叉淡化：浏览器对翻色前后的界面各拍一张快照，
      // 在两张快照之间做 cross-fade。此前用 body.theme-animating 把全局 transition
      // 关掉再硬翻——净效果是 0ms 硬切（全屏颜色差值不会被补间成彩虹，但也没有
      // 任何过渡）。快照 cross-fade 天然不做逐元素颜色补间：整屏是一次性的
      // 图像叠化，所以「不彩虹」与「有补间」能同时成立。
      //
      // 关键：DOM 变更必须在 withViewTransition 的回调里**同步**完成（浏览器靠
      // 回调结束这一刻的 DOM 拍旧快照）。applyTheme 是同步的，直接改 dataset；
      // setTheme 只负责让 React 状态跟上，随后那个 useEffect 再补一次同样的
      // applyTheme（幂等，无副作用）。
      withViewTransition(() => {
        applyTheme(next)
        setTheme(next)
      })
      try {
        writeSetting('ryharness-theme', next)
      } catch {
        // 忽略持久化失败。
      }
    },
    [theme],
  )

  /**
   * `/` 命令面板的命令表。
   *
   * 刻意只放**本机动作**：新建会话、切主题、跳页签、打开工作区目录。不发明新的
   * 后端命令语义——面板看起来能做很多事、实际只能做前端动作，是最让人失望的一种
   * "功能"。
   */
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'new-chat',
        label: '新对话',
        hint: 'Ctrl+N',
        run: () => {
          window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT))
        },
      },
      {
        id: 'theme-dark',
        label: '切到深色主题',
        run: () => {
          changeTheme('dark')
        },
      },
      {
        id: 'theme-light',
        label: '切到浅色主题',
        run: () => {
          changeTheme('light')
        },
      },
    ]
    for (const [index, entry] of RAIL_TABS.entries()) {
      list.push({
        id: `tab-${entry.key}`,
        label: `切到${entry.label}`,
        hint: `Ctrl+${index + 1}`,
        run: () => {
          setTab(entry.key)
        },
      })
    }
    list.push({
      id: 'open-workspace',
      label: '打开工作区目录',
      run: () => {
        if (api === undefined) return
        void api
          .workspace()
          .then((info) => {
            return openInFileManager(info.path)
          })
          .then((opened) => {
            if (opened) return
            toast.error('没能打开工作区目录')
          })
          .catch(() => {
            toast.error('没能打开工作区目录')
          })
      },
    })
    return list
  }, [api, changeTheme])

  const runRefresh = useCallback(
    async (client: ApiClient): Promise<void> => {
      // 四个接口各自结算，不是一荣俱荣。此前是一个 Promise.all：其中任意一个抖
      // 一下（/api/templates 500、一次超时）就把整个应用替换成「连不上本机服务」
      // 全屏页——而这次刷新每轮对话结束、每次标记已读都会触发，也就是说用户在
      // 正常使用中会被随机弹出主界面。失败的那一项保留上一次的旧值继续渲染，
      // 首屏（此前没有任何数据）才升级成整屏错误页。
      const [agentRes, templateRes, providerRes, conversationRes, presetRes] = await Promise.allSettled([
        client.listAgents(),
        client.templates(),
        client.providers(),
        client.conversations(),
        // 供应商预设目录：首屏要靠它让用户**自己挑一家**，而不是默认点名某一家。
        client.providerPresets(),
      ])
      if (agentRes.status === 'fulfilled') {
        setAgents((prev) => {
          return sameList(prev, agentRes.value.agents) ? prev : agentRes.value.agents
        })
        cache.setAgentNames(
          new Map(
            agentRes.value.agents.map((a) => {
              return [a.id, a.name]
            }),
          ),
        )
      }
      if (templateRes.status === 'fulfilled') {
        setTemplates((prev) => {
          return sameList(prev, templateRes.value.templates) ? prev : templateRes.value.templates
        })
      }
      if (providerRes.status === 'fulfilled') {
        setProviders((prev) => {
          return sameList(prev, providerRes.value.providers) ? prev : providerRes.value.providers
        })
      }
      if (presetRes.status === 'fulfilled') {
        // 老服务端或异常回包里可能没有 presets 字段：兜一个空数组，别让首屏白屏。
        setPresets(presetRes.value.presets ?? [])
      }
      if (conversationRes.status === 'fulfilled') {
        setConversations((prev) => {
          return sameList(prev, conversationRes.value.conversations) ? prev : conversationRes.value.conversations
        })
      }
      const failures = [agentRes, templateRes, providerRes, conversationRes].filter((result) => {
        return result.status === 'rejected'
      })
      if (failures.length === 0) {
        setLoadError(undefined)
      } else {
        // 首屏一份数据都没拿到，才是真的连不上；此时报错文案才有意义。
        const first = failures[0] as PromiseRejectedResult
        if (agentRes.status === 'rejected' && templateRes.status === 'rejected') {
          // 这里是**原文**：它要喂给 startupFailureHint 判现象（那边按 HTTP 状态与
          // fetch 原话正则），并且只出现在错误页折起来的「详情」里。
          setLoadError(errorDetail(first.reason) ?? '未知原因')
        } else {
          // 只挂了一项：应用还能用，说一声就好，不该把界面整个收走。
          toast.error(`有些内容没刷新出来：${humanError(first.reason, '稍后会自动重试')}`)
        }
      }
      // 首屏「可交互」：首份数据到手这一刻，列表、通讯录、右栏才是真能点的。
      // 打点本身幂等，后续刷新重复调只是空转。
      markFirstInteractive()
      setListLoading(false)
    },
    [cache],
  )

  /** 全量刷新：并发调用合并为一次，飞行中再来请求只排一次尾随刷新。 */
  const refreshGate = useRef<{ inflight: Promise<void> | null; queued: boolean }>({
    inflight: null,
    queued: false,
  })
  const apiRef = useRef<ApiClient | undefined>(api)
  apiRef.current = api
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    const client = apiRef.current
    if (client === undefined) return
    const gate = refreshGate.current
    if (gate.inflight !== null) {
      gate.queued = true
      await gate.inflight
      return
    }
    gate.inflight = runRefresh(client).finally(() => {
      const g = refreshGate.current
      g.inflight = null
      if (g.queued) {
        g.queued = false
        void refreshRef.current?.()
      }
    })
    await gate.inflight
  }, [runRefresh])
  refreshRef.current = refresh

  /** 尾随合并：已读等高频事件在窗口内只发一次全量刷新。 */
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleRefresh = useCallback((): void => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      void refresh()
    }, REFRESH_DEBOUNCE_MS)
  }, [refresh])

  useEffect(() => {
    if (api === undefined) return
    void refresh()
  }, [api, refresh])

  /**
   * 关系进展的外显：档位变了就说一句。
   *
   * 之前亲密度只在两处看得到——通讯录卡片与右栏资料卡，而右栏默认收起。于是"聊得越多
   * 越熟"这件产品的第一卖点在聊天过程中完全没有反馈。
   *
   * 只报升档：掉档几乎都来自用户自己刚点的那一下 👎（那里已经有一条"已告诉它哪里不对"
   * 的反馈），再补一句掉档提示只是把同一个动作说两遍；掉档后的分数照旧在聊天头部的
   * 徽标与右栏里看得见，没有被藏起来。
   */
  useEffect(() => {
    if (agents.length === 0) return
    const milestones = turnEnded.current ? affinityMilestones(affinitySeen.current, agents) : []
    turnEnded.current = false
    for (const agent of agents) affinitySeen.current.set(agent.id, normalizePersona(agent.persona).affinity)
    for (const milestone of milestones) {
      if (!milestone.up) continue
      toast.success(`${milestone.name} 跟你的关系近了一步：${milestone.tier.label}（亲密度 ${milestone.affinity}/100）`)
    }
  }, [agents])

  /**
   * 当前会话的「会话 + 桶」。
   *
   * 绑在一起是因为切会话时它们必须同生共死：桶的身份一变，聊天区换订阅对象即可，
   * 而草稿、滚动锚点、已加载的历史都留在桶里（此前 `key={active.id}` 让整棵重挂，
   * 顺带把用户没发出去的那句话一起扔掉）。
   */
  const active = useMemo(() => {
    const conversation = conversations.find((c) => {
      return c.id === activeId
    })
    if (conversation === undefined) return undefined
    return { conversation, bucket: cache.bucket(conversation.id) }
  }, [activeId, cache, conversations])
  const ryen = agentById(agents, 'ryen')

  /** 会话已读：本地把未读数归零（markRead 响应已带 lastReadSeq），不再发 4 个 HTTP。 */
  const markConversationRead = useCallback((conversationId: string): void => {
    setConversations((prev) => {
      const index = prev.findIndex((c) => {
        return c.id === conversationId
      })
      if (index < 0) return prev
      const target = prev[index]!
      if ((target.unreadCount ?? 0) === 0) return prev
      const next = prev.slice()
      next[index] = { ...target, unreadCount: 0 }
      return next
    })
  }, [])

  /** 与 agent 的单聊：找已有 direct 会话，没有就建。 */
  const openDirectChat = async (agentId: string): Promise<void> => {
    if (api === undefined) return
    const existing = conversations.find((c) => {
      return c.kind === 'direct' && c.memberAgentIds.length === 1 && c.memberAgentIds[0] === agentId
    })
    setPendingSend(undefined)
    if (existing !== undefined) {
      setActiveId(existing.id)
      setTab('chats')
      return
    }
    try {
      const { conversation } = await api.createConversation({ kind: 'direct', agentId })
      setConversations((prev) => {
        return [conversation, ...prev]
      })
      setActiveId(conversation.id)
      setTab('chats')
    } catch (error) {
      // 这里是一次业务失败（agent 刚被删、并发、400/404），不是服务没起来。
      // 掀掉整个窗口只会让用户以为软件崩了，却什么都没得到——同类失败在
      // startChat 里走的就是 toast。留在当前页面上说一声为什么。
      toast.error(`没能打开对话：${humanError(error, '再试一次')}`)
    }
  }

  /**
   * 欢迎页输入框/建议 chip 的回车：打开（或创建）与某位助理的单聊，并把这句交给它发。
   *
   * 不传 agentId 时落到 Ryen；团队栏点了别的助理就带 agentId，让「跟谁聊」真的生效，
   * 而不是文案换了、消息仍旧进 Ryen 的单聊。
   */
  const startDirectChat = async (text: string, agentId: string | undefined): Promise<void> => {
    if (api === undefined) return
    const targetAgentId = agentId ?? ryen?.id
    if (targetAgentId === undefined) return
    try {
      const existing = conversations.find((c) => {
        return c.kind === 'direct' && c.memberAgentIds.length === 1 && c.memberAgentIds[0] === targetAgentId
      })
      const conversationId =
        existing !== undefined
          ? existing.id
          : (await api.createConversation({ kind: 'direct', agentId: targetAgentId })).conversation.id
      if (existing === undefined) await refresh()
      // 三件事必须同批落地：会话切过去（ChatView 挂载并建立 WS 订阅）、切到聊天页、
      // 把这句话挂上。缺一个，ChatView 挂载时看到的就不是这条待发消息。
      setActiveId(conversationId)
      setTab('chats')
      setPendingSend({ conversationId, text })
    } catch (error) {
      toast.error(`没能发出这句话：${humanError(error, '这句话还没发出去，再点一次发送')}`)
    }
  }

  /**
   * 多 agent 场景的去处：落到已存在的小队群，没有就建一个，然后把这句话交给它。
   *
   * 首屏那枚写着「我们三个」的 chip 此前往落 Ryen 的单聊——文案与行为不一致，
   * 用户以为群里还有两位在等回答。这里保证群场景一定落在 kind='group' 的会话上。
   * 示例会话不算「已存在的小队」：那是产品演示，把用户的第一句话写进去等于污染它。
   */
  const startGroupChat = async (text: string): Promise<void> => {
    if (api === undefined) return
    const squad = agents.map((a) => {
      return a.id
    })
    if (squad.length < 2) {
      toast.error('小队至少要两位 agent——先去通讯录新建一位，再回来一起聊。')
      return
    }
    try {
      const existing = conversations.find((c) => {
        return (
          c.kind === 'group' &&
          !c.title.startsWith(DEMO_CONVERSATION_PREFIX) &&
          squad.every((id) => {
            return c.memberAgentIds.includes(id)
          })
        )
      })
      let conversationId: string
      if (existing !== undefined) {
        conversationId = existing.id
      } else {
        const { conversation } = await api.createConversation({
          kind: 'group',
          memberAgentIds: squad,
          dispatcherAgentId: ryen?.id ?? squad[0],
          title: '小队',
        })
        conversationId = conversation.id
        await refresh()
      }
      setActiveId(conversationId)
      setTab('chats')
      setPendingSend({ conversationId, text })
    } catch (error) {
      toast.error(`没能把小队叫起来：${humanError(error, '小队没能开场，再试一次')}`)
    }
  }

  /** 欢迎页发话：去向由用户在页面上选（跟 Ryen 聊 / 开个小队），这里只负责落到会话。 */
  const startChat = async (text: string, target: WelcomeTarget): Promise<void> => {
    if (target.kind === 'group') {
      await startGroupChat(text)
      return
    }
    await startDirectChat(text, target.agentId)
  }

  /** 托盘「新对话」：回到欢迎页，让用户自己选跟 Ryen 聊还是开个小队。 */
  useEffect(() => {
    const onNewChat = (): void => {
      setPendingSend(undefined)
      setActiveId(undefined)
      setTab('chats')
    }
    window.addEventListener(NEW_CHAT_EVENT, onNewChat)
    return () => {
      window.removeEventListener(NEW_CHAT_EVENT, onNewChat)
    }
  }, [])

  /**
   * 通知点击：切到聊天页并选中那条会话（事件 detail 带会话 id，来源见
   * main.ts 的 openConversationScript）。
   *
   * 监听器处理完事件会把 data-ryharness-open-conversation 盖成目标 id——主进程
   * 的重试脚本拿它当落地判据，事件只有被 React 处理过那边才会停发。
   */
  useEffect(() => {
    const onOpenConversation = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      const id = event.detail
      if (typeof id !== 'string' || id.length === 0) return
      setPendingSend(undefined)
      setActiveId(id)
      setTab('chats')
      document.documentElement.dataset.ryharnessOpenConversation = id
    }
    window.addEventListener(OPEN_CONVERSATION_EVENT, onOpenConversation)
    return () => {
      window.removeEventListener(OPEN_CONVERSATION_EVENT, onOpenConversation)
    }
  }, [])

  /**
   * 全局快捷键：**一条**处理器，不散落各处。
   *
   * - `Ctrl/Cmd+K` → 聚焦左栏搜索框（搜索框在会话列表里，用事件搭桥）
   * - `Ctrl/Cmd+N` → 新对话（复用托盘那条事件，两处一个口径）
   * - `Ctrl/Cmd+1..4` → 切页签（顺序即导航栏的顺序）
   *
   * 判定口径在 shared/shortcuts.ts（与 Electron 菜单读同一份），这里只管分派。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const matched = matchShortcut(event, RAIL_TABS.length)
      if (matched === undefined) return
      if (matched.id === 'focus-search') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent(SEARCH_FOCUS_EVENT))
        return
      }
      if (matched.id === 'new-chat') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT))
        return
      }
      const index = (matched.tab ?? 0) - 1
      const next = RAIL_TABS[index]
      if (next === undefined) return
      event.preventDefault()
      setTab(next.key)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  if (api === undefined) return <BootSkeleton />

  if (loadError !== undefined) {
    return (
      <div className="app-error">
        <h2>连不上 RyHarness 的本机服务</h2>
        <p>{startupFailureHint(loadError)}</p>
        <p>点下面的「重试」再连一次；还是不行就重启应用，或确认桌面服务已经启动。</p>
        <details style={{ margin: '12px 0', textAlign: 'left' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-sm)' }}>详情</summary>
          <code
            style={{
              display: 'block',
              marginTop: 4,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-xs)',
            }}
          >
            {loadError}
          </code>
        </details>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setLoadError(undefined)
            setListLoading(true)
            void refresh()
          }}
        >
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {/* 栏 1：72px icon rail */}
      <nav className="rail" aria-label="主导航">
        <span className="rail-logo" aria-hidden="true">
          <Cat size={40} />
        </span>
        {RAIL_TABS.map((item) => (
          <button
            type="button"
            key={item.key}
            className={`rail-tab ${tab === item.key ? 'is-active' : ''}`}
            aria-current={tab === item.key ? 'page' : undefined}
            // Beta 页签的无障碍名与悬停提示里都带上「Beta」：页面上那个小圆点是图形，
            // 读屏与鼠标用户不能只靠它知道这是个预览中的功能。
            aria-label={item.beta === true ? `${item.label}（Beta，还在打磨）` : undefined}
            title={item.beta === true ? `${item.label}（Beta，还在打磨，边界会变）` : undefined}
            onClick={() => {
              setTab(item.key)
            }}
          >
            <span className="rail-icon" aria-hidden="true">
              {/* 四个页签同一套线性图标、同一档尺寸。品牌猫只留在栏顶 logo 与 Ryen 的
                  头像位——它是产品标识，混进导航既不是同一个图形语言，在 20px 槽位里
                  也压不住旁边两个描边图标。 */}
              <Icon name={item.icon} size={20} />
              {/* Beta 标记：图标右上角一枚小圆点。
                  写成「Beta」两个字时，这个页签就比别的高一行、整块底色也比别的高，
                  左栏看上去是歪的；而且那个词比它标注的「RyVibe」还抢眼。
                  词留给页面标题（那里有地方摆），导航里只留一枚安静的点，
                  悬停提示里说清楚。 */}
              {item.beta === true && <span className="rail-beta-dot" />}
            </span>
            {item.label}
          </button>
        ))}
        <span className="rail-spacer" />
        <button
          type="button"
          className="rail-icon-btn"
          title={theme === 'light' ? '切换到暗色' : '切换到浅色'}
          aria-label={theme === 'light' ? '切换到暗色' : '切换到浅色'}
          onClick={() => {
            changeTheme(theme === 'light' ? 'dark' : 'light')
          }}
        >
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={20} />
        </button>
        <button
          type="button"
          className="rail-icon-btn"
          title="我的 / 设置"
          aria-label="我的 / 设置"
          onClick={() => {
            setTab('me')
          }}
        >
          <Icon name="gear" size={20} />
        </button>
      </nav>

      {/* 栏 2：列表栏（聊天 tab）或空（通讯录/插件/我的为整页） */}
      {tab === 'chats' && (
        <aside className={listCollapsed ? 'list-panel is-collapsed' : 'list-panel'}>
          <ConversationList
            conversations={conversations}
            agents={agents}
            activeId={activeId}
            loading={listLoading}
            collapsed={listCollapsed}
            onToggleCollapsed={toggleList}
            onSelect={(id) => {
              setActiveId(id)
              // 用户改主意去别的会话：欢迎页那条待发消息就此作废，不在别处冒出来。
              setPendingSend(undefined)
            }}
            onGoContacts={() => {
              setTab('contacts')
            }}
            onEditGroup={(conversation) => {
              setEditingGroup(conversation)
            }}
            // 宿主自己的 ApiClient：列表自己 new 一个的话，置顶/静音/删除会绕过
            // 壳的刷新与错误处理。onChanged 让操作后的真值重新落到列表上。
            api={api}
            onChanged={() => {
              void refresh()
            }}
            onJumpToMessage={(conversationId) => {
              // 定位本身由 ConversationList 抛 ryharness:scroll-to-message 并用
              // scrollIntoView 兜底；壳这头只负责把目标会话摆到台面上。
              setTab('chats')
              setActiveId(conversationId)
              setPendingSend(undefined)
            }}
          />
        </aside>
      )}

      {/* 栏 3：内容区。局部兜底边界：聊天区或整页崩了，rail 与列表栏仍然在，用户还能
          切会话、切页签自救（resetKeys 一变就清错误态并重挂），不必对着一屏空白去重启。
          onError 把崩溃记进本地日志：这一层崩得最多，没有它就只剩用户手点复制。 */}
      <ErrorBoundary
        resetKeys={[tab, activeId ?? '']}
        title="这块页面没画出来"
        hint="左侧导航与会话列表还在，换一个会话或页签就会自动重画；也可以直接点「重试」。"
        onError={reportRenderCrash}
      >
        {tab === 'chats' ? (
          active !== undefined ? (
            <ChatView
              api={api}
              conversation={active.conversation}
              agents={agents}
              bucket={active.bucket}
              onRead={() => {
                markConversationRead(active.conversation.id)
                // 列表里的预览/时间戳仍可能过期，用尾随合并刷新兜底（切会话再快也只发一次）。
                scheduleRefresh()
              }}
              onSeen={() => {
                // 这一轮的发言就摆在眼前，角标不该再涨。只本地归零，不重拉清单：
                // 同一轮末尾 onTurnEnd 那次刷新会带回服务端已经压平的真值。
                markConversationRead(active.conversation.id)
              }}
              {...(pendingSend === undefined ? {} : { pendingSend })}
              onPendingSendDone={() => {
                setPendingSend(undefined)
                // 列表里的预览/未读此刻已经过期（消息刚出去），尾随合并刷新一次。
                scheduleRefresh()
              }}
              onTurnEnd={() => {
                // 亲密度每轮都在涨：不重拉的话，头部的「你们有多熟」与右栏的档位要等到
                // 下次切会话才变。尾随合并刷新，别让每个 token 都去拉一次清单。
                turnEnded.current = true
                scheduleRefresh()
              }}
              onPreview={openPreview}
              commands={commands}
              {...(narrow
                ? {
                    onTogglePanel: toggleDrawer,
                    panelOpen: drawerOpen,
                  }
                : {})}
              onSwitchConversation={(id) => {
                // "从这里分支"分出的新会话：切过去，并让列表重拉一次（列表里还没有它）。
                setActiveId(id)
                setPendingSend(undefined)
                scheduleRefresh()
              }}
              onNavigate={navigateFromError}
              onAffinityChange={() => {
                // 👍/👎 已经动了亲密度（服务端按 nextAffinity 加权）：同一路重拉，让
                // 头部徽标、通讯录卡片与右栏当场跟上新分数；也算一次「聊出来的」变化，
                // 跨档提示照样可以报。
                turnEnded.current = true
                scheduleRefresh()
              }}
            />
          ) : (
            <section className="chat-view">
              <div className="chat-scroll">
                <WelcomeHome
                  ryen={ryen}
                  agents={agents}
                  conversations={conversations}
                  providers={providers}
                  providersLoading={listLoading}
                  presets={presets}
                  onSaveApiKey={async (providerId, apiKey) => {
                    await api.setApiKey(providerId, apiKey)
                    await refresh()
                  }}
                  onSaveProviderKey={async (preset, apiKey) => {
                    // 这家还没建过路由就先建一条（带 key），建过就只补 key。
                    const existing = providers.find((provider) => {
                      return provider.id === preset.id
                    })
                    if (existing === undefined) {
                      await api.createProvider({
                        displayName: preset.displayName,
                        protocol: preset.protocol,
                        baseUrl: preset.baseUrl,
                        models: preset.models,
                        apiKey,
                        presetId: preset.id,
                      })
                    } else {
                      await api.setApiKey(existing.id, apiKey)
                    }
                    await refresh()
                  }}
                  onSend={(text, target) => {
                    void startChat(text, target)
                  }}
                  onOpenConversation={(id) => {
                    setActiveId(id)
                  }}
                />
              </div>
            </section>
          )
        ) : tab === 'vibe' ? (
          // RyVibe 是独立页面：它不开在聊天页里（那会让人以为这就是一条会话），
          // 但结果落在真实的群会话里——「在聊天里继续」就能跳过去接着追问。
          <section className="chat-view">
            <div className="chat-scroll">
              <RyVibePage
                api={api}
                providers={providers}
                providersLoading={listLoading}
                onOpenConversation={(id) => {
                  setTab('chats')
                  setActiveId(id)
                }}
                onOpenAgent={(agentId) => {
                  void openDirectChat(agentId)
                }}
                onNavigate={navigateFromError}
              />
            </div>
          </section>
        ) : tab === 'contacts' ? (
          <ContactsPage
            agents={agents}
            templates={templates}
            loading={listLoading}
            onCreateAgent={(templateKey) => {
              setAgentTemplateKey(templateKey)
              setEditingAgent(undefined)
              setModal('agent')
            }}
            onEditAgent={(agent) => {
              setEditingAgent(agent)
              setAgentTemplateKey(undefined)
              setModal('agent')
            }}
            onDeleteAgent={(agent) => {
              setDeletingAgent(agent)
            }}
            onCreateGroup={() => {
              setModal('group')
            }}
            onChat={(agentId) => {
              void openDirectChat(agentId)
            }}
          />
        ) : tab === 'plugins' ? (
          <PluginsPage api={api} />
        ) : (
          <MePage
            api={api}
            ryen={ryen}
            providers={providers}
            theme={theme}
            onThemeChange={changeTheme}
            onRyenPatched={() => {
              void refresh()
            }}
            onOpenPlugins={() => {
              setTab('plugins')
            }}
          />
        )}
      </ErrorBoundary>

      {tab === 'chats' && active !== undefined && (
        <RightPanel
          api={api}
          store={active.bucket.store}
          conversation={active.conversation}
          agents={agents}
          conversations={conversations}
          fileUrl={(name) => {
            return api.fileUrl(name)
          }}
          collapsed={panelCollapsed}
          overlay={narrow}
          open={narrow ? drawerOpen : !panelCollapsed}
          onPreview={openPreview}
          onToggle={narrow ? toggleDrawer : togglePanel}
          onOpenPlugins={() => {
            setTab('plugins')
          }}
        />
      )}

      {/* 窄窗抽屉的遮罩：点它就收起。抽屉盖着聊天区，没有这个出口，用户只能把
          窗口拉宽才能继续打字——那不是"窄屏适配"，是把窄屏用户赶走。 */}
      {narrow && drawerOpen && (
        <button
          type="button"
          className="panel-scrim"
          aria-label="收起信息板"
          onClick={() => {
            setDrawerOpen(false)
          }}
        />
      )}

      {modal === 'agent' && (
        <CreateAgentModal
          templates={templates}
          providers={providers}
          api={api}
          agents={agents}
          {...(agentTemplateKey === undefined ? {} : { initialTemplateKey: agentTemplateKey })}
          {...(editingAgent === undefined ? {} : { editing: editingAgent })}
          onClose={() => {
            setModal(undefined)
            setEditingAgent(undefined)
            setAgentTemplateKey(undefined)
          }}
          onOpenProviderSettings={() => {
            // 音色行里的「配置云端音色」：关掉编辑器、切到「我的」并滚到供应商区块。
            setModal(undefined)
            setEditingAgent(undefined)
            setAgentTemplateKey(undefined)
            setTab('me')
            setTimeout(() => {
              document.getElementById('provider-settings')?.scrollIntoView({ block: 'start' })
            }, 0)
          }}
          onSubmit={async (input) => {
            if (editingAgent === undefined) await api.createAgent(input)
            else await api.patchAgent(editingAgent.id, input)
            await refresh()
          }}
        />
      )}
      {modal === 'group' && (
        <GroupSettingsModal
          mode="create"
          agents={agents}
          onClose={() => {
            setModal(undefined)
          }}
          onSubmit={async (input) => {
            const { conversation } = await api.createConversation({ kind: 'group', ...input })
            await refresh()
            setActiveId(conversation.id)
            setTab('chats')
          }}
        />
      )}
      {editingGroup !== undefined && (
        <GroupSettingsModal
          mode="settings"
          agents={agents}
          conversation={editingGroup}
          onClose={() => {
            setEditingGroup(undefined)
          }}
          onSubmit={async (input) => {
            const { conversation } = await api.patchGroup(editingGroup.id, input)
            // 换调度员目前服务端还不落这个字段：拿回包里的真值比对，别替它宣布成功。
            if (input.dispatcherAgentId !== undefined && conversation.dispatcherAgentId !== input.dispatcherAgentId) {
              const now = conversation.dispatcherAgentId
              toast.error(
                now === undefined
                  ? '群名与成员已保存；调度员没改成——当前服务端还不支持改已有群的调度员。'
                  : `群名与成员已保存；调度员仍是 ${agentById(agents, now)?.name ?? now}（当前服务端还不支持改已有群的调度员）。`,
              )
            } else {
              toast.success('群设置已保存')
            }
            await refresh()
          }}
        />
      )}
      {deletingAgent !== undefined && (
        <ConfirmDialog
          title={`删除「${deletingAgent.name}」？`}
          body={`「${deletingAgent.name}」会从通讯录里消失，它此前的聊天记录仍留在历史会话中。删除后不可恢复：即使重新建一个同名 agent，那也是一个全新的它，记忆与经验都不会回来。`}
          onCancel={() => {
            setDeletingAgent(undefined)
          }}
          onConfirm={async () => {
            await api.deleteAgent(deletingAgent.id)
            await refresh()
            setDeletingAgent(undefined)
            toast.success(`「${deletingAgent.name}」已删除`)
          }}
        />
      )}
      {preview !== undefined && (
        <ArtifactPreview
          api={api}
          target={preview}
          onClose={() => {
            setPreview(undefined)
          }}
        />
      )}
      {/* toast 宿主：会话打开时由 ChatView 挂在输入区上沿（composer 变高不会压住发送键），
          其余页面（欢迎页 / 通讯录 / 插件 / 我的）由这里兜底——保存、删除的反馈不能只有
          聊天页看得见。任何时刻只有一个宿主在屏上。 */}
      {!(tab === 'chats' && active !== undefined) && <ToastHost />}
    </div>
  )
}

/** 列表内容没变就保持旧引用：省掉一次整树重渲染（refresh 会重复触发）。 */
function sameList<T>(prev: readonly T[], next: readonly T[]): boolean {
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) return false
  }
  return true
}
