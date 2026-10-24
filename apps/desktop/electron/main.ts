/**
 * Electron 主进程：内嵌启动 @ryharness/server（固定端口，被占用时回退随机），创建窗口。
 * 开发模式加载 Vite dev server（RYHARNESS_DEV_SERVER_URL），生产模式由主进程
 * 自己的回环 HTTP server 伺服渲染层构建产物（同源加载、并行分片、可缓存）。
 *
 * 启动顺序：**窗口先行**——whenReady 立刻建窗并开始加载渲染层（先显示骨架），
 * @ryharness/server（WAL 恢复/迁移，慢盘 50–200ms+）并行启动，就绪后把 API 地址
 * 推给渲染层。菜单栏 autoHide（macOS 保留应用菜单）。
 *
 * 常驻：主进程自己订阅后端 WS（Node 22+ 内置 WebSocket）跟踪每个会话的进行中
 * 状态——托盘 tooltip 跟着变，生成完成且窗口不在前台时弹系统通知。关窗收进托盘，
 * 退出只认托盘菜单与 app 菜单，用户不会因为误关窗口丢掉正在跑的活。
 *
 * 产品名与版本不在代码里写死：一律经 readAppMeta() 从应用自己的 package.json 读，
 * 因此开发运行（`electron .`）与安装版显示的是同一个名字和版本号。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureSecretStore, RyHarnessServer, type WsEvent } from '@ryharness/server'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from 'electron'
import { NEW_CHAT_SHORTCUT, SEARCH_FOCUS_EVENT, SEARCH_SHORTCUT } from '../shared/shortcuts.ts'
import { clampBounds, readWindowBounds, WINDOW_STATE_FILE, writeWindowBounds } from '../shared/window-bounds.ts'
import { runCapture } from './capture.ts'
import { migrateLegacyDataDir } from './data-dir.ts'
import { RENDERER_MOUNT, RendererAssets } from './renderer-assets.ts'
import { allowedPermission, canOpenPath, dotEnvCandidates, envTokenAllowed, envValue } from './security.ts'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 应用图标按尺寸分级取用。每一档都是位图母版 assets/brand/mark.png 的**独立**缩放，
 * 不是拿 256 档降采样——降采样只会把上一档糊掉的结果再缩小一遍。
 *
 * 九档（含 favicon）一律整幅 + 同一个 0.245 圆角遮罩：没有裁窗，也不存在「这一档
 * 扣不扣圆角」的分支。裁脸与圆角在几何上互斥（理由与实测见
 * apps/desktop/docs/brand/icon.md），统一外轮廓比保五官更要紧。
 * tiers.json 因此只登记档位表、圆角与接线文件名，由 `pnpm gen:icon` 一并生成。
 *
 * 托盘只有 16/24 两个物理尺寸，直接喂对应档位；窗口与任务栏用 256 档。
 * 改品牌请改 assets/brand/ 再重新导出，不要在这里换图。
 */
const ICON_TIER = {
  tray: 'icon-16.png',
  trayHiDpi: 'icon-24.png',
  window: 'icon-256.png',
} as const

/** 窗口/任务栏喂给 Windows 的那份多档图标（与 exe 内嵌、开始菜单快捷方式同一份源）。 */
const WINDOW_ICON = 'icon.ico'

/**
 * 窗口图标落在哪：打包态走 asar **之外**的 resources/icon.ico，开发态走仓库里的
 * assets/icon.ico。两个理由各自独立，缺一都不会立刻显形：
 *
 * 1. Windows 只认 .ico。Electron 自己的 BrowserWindow.icon 文档就是这么写的
 *    （"On Windows it is recommended to use `ICO` icons"，electron.d.ts）——单张 256 档
 *    PNG 要由系统自己降采样出 16/24/32/48/64，任务栏那一格必然发虚。
 * 2. 打包态交给 BrowserWindow 的路径是由 Chromium 的图片加载器读的（不是 Node 的 fs），
 *    那条路要穿过 app.asar 归档。整条图标链上只有这一环是开发态（真实文件）验过的；一旦
 *    读不到，窗口就拿不到 WM_SETICON，任务栏按钮退成默认字形——而 exe 内嵌那只橘猫不会
 *    来救场：进程带着显式 AUMID 时 Explorer 先找该 AUMID 注册的资源，不再往下退到 exe。
 */
export function windowIconPath(layout: { here: string; resourcesPath: string; isPackaged: boolean }): string {
  return layout.isPackaged ? join(layout.resourcesPath, WINDOW_ICON) : join(layout.here, '../assets', WINDOW_ICON)
}

const appIcon = (tier: keyof typeof ICON_TIER): string => {
  // 托盘两档是注入通知区的位图，仍取 asar 内逐档导出的 PNG；窗口那枚换多档 .ico。
  if (tier === 'window') {
    return windowIconPath({ here, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged })
  }
  return join(here, '../assets', ICON_TIER[tier])
}

/**
 * 托盘用哪一档位图。HiDPI 屏（scaleFactor ≥ 1.5）给 24 档：系统按 2 倍密度取像素，
 * 16 档被拉上去只会发虚；其余给 16 档，1:1 投放就是它自己的像素。
 */
export function trayIconTier(scaleFactor: number): 'tray' | 'trayHiDpi' {
  return scaleFactor >= 1.5 ? 'trayHiDpi' : 'tray'
}

// ---- 端口策略 ----

/**
 * 后端默认端口：与渲染层 api.ts 的 DEFAULT_API_BASE、apps/server 的 DEFAULT_PORT
 * 同一个值，三处对齐之后「浏览器直连开发」与「桌面内嵌」落在同一个 origin 上。
 *
 * 固定端口换来的是**跨启动稳定的 origin**：Chromium 的 HTTP 缓存与 V8 代码缓存都按
 * URL 索引，端口每次都换（此前的 port 0）等于每次冷启动把整份缓存归零，渲染层那
 * 几百 KB 的分片要重新下载、重新解析、重新编译。
 */
export const DEFAULT_BACKEND_PORT = 32100
/**
 * 渲染层资源服务端口：后端 +1。
 *
 * 同一套理由、同一个坑：资源服务此前监听 port 0，每次冷启动 origin 都变，
 * Chromium 的 HTTP 缓存与 V8 代码缓存一起归零，渲染层那几百 KB 分片全部重新
 * 下载与编译。固定端口换来跨启动稳定的 origin，被占用时同样回退随机。
 */
export const DEFAULT_ASSETS_PORT = DEFAULT_BACKEND_PORT + 1
/** 后端监听地址（回环；不监听 0.0.0.0，本机服务没有对外暴露的理由）。 */
const BACKEND_HOST = '127.0.0.1'

/** 端口占用探测（先探后起，见 {@link resolveBackendPort}）。 */
function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const probe = createNetServer()
    probe.once('error', () => {
      resolvePromise(false)
    })
    probe.listen(port, host, () => {
      probe.close(() => {
        resolvePromise(true)
      })
    })
  })
}

/**
 * 端口选择：固定端口优先，被占用时回退随机端口。
 *
 * 为什么先探再起：`RyHarnessServer.create` 内部的 `http.listen` 没有挂 error 监听，
 * 端口被占时不会 reject，而是变成主进程的未捕获异常（应用直接闪退）。开发态同时
 * 跑着另一个实例、或用户机器上正好有别的程序占着 32100 都很常见，所以这里先探。
 * probe 可注入，测试不需要真的占一个端口。
 */
export async function resolveBackendPort(options: {
  port: number
  host: string
  probe?: (port: number, host: string) => Promise<boolean>
}): Promise<{ port: number; fallback: boolean; reason?: string }> {
  // 显式要求随机端口（RYHARNESS_PORT=0，测试与多开场景）时不必探测。
  if (options.port === 0) return { port: 0, fallback: false }
  const probe = options.probe ?? isPortAvailable
  if (await probe(options.port, options.host)) return { port: options.port, fallback: false }
  return { port: 0, fallback: true, reason: `端口 ${options.port} 已被占用` }
}

/** RYHARNESS_PORT 解析：缺省或非法值退回默认固定端口；0 表示显式要求随机端口。 */
export function backendPortFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = envValue(env, 'PORT')
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_BACKEND_PORT
  const port = Number(raw)
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : DEFAULT_BACKEND_PORT
}

/**
 * 改名那天的数据迁移：产品从 RyAgent 改成 RyHarness，数据目录的位置与文件名都跟着
 * 变了（`%APPDATA%\RyAgent\ryagent-data\ryagent.db` → `%APPDATA%\RyHarness\
 * ryharness-data\ryharness.db`）。
 *
 * 不迁的话，用户升级后打开应用会发现会话、长期记忆、助理配置全没了——那些数据还
 * 在老目录里躺着，只是没人去读。这是最难查的一类"数据丢了"。
 *
 * 实现在 {@link migrateLegacyDataDir}（单独成模块是为了能单测）。
 */

// ---- API 一次性 token ----

/**
 * 本次启动的 API token（256 位随机，base64url）。
 *
 * 后端固定监听 32100，且工具链里就有 shellExec：没有 token 的话，本机任何一个
 * 进程都能直接驱动助手去执行命令。每次启动换一个，猜中与复用都无从谈起；
 * 它只走注入通道（见 pushApiBase），不落盘、不进命令行——命令行在本机是全局
 * 可见的，放进去等于把 token 公开。
 */
export function generateApiToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 本次启动的 token（main() 里生成一次，渲染层与主进程自己共用）。 */
let apiToken: string | undefined

// ---- 启动计时 ----

/** 一次启动里记录的一个阶段。 */
export interface BootPhase {
  stage: string
  /** 相对冷启动（进程 spawn）的毫秒数。 */
  sinceStartMs: number
  /** 与上一阶段的间隔毫秒；首个阶段为 0。 */
  deltaMs: number
}

/** 启动计时快照（可查询：主进程持有 + `ryharness:boot-trace` IPC + userData 日志）。 */
export interface BootSnapshot {
  /** 进程冷启动时刻（Unix 毫秒）。 */
  startedAt: number
  /** 最后一个阶段距冷启动的毫秒数。 */
  totalMs: number
  phases: BootPhase[]
}

/**
 * 冷启动计时器：只记阶段名与耗时，不带任何业务数据。
 *
 * 起点用 `Date.now() - performance.now()` 反推进程 spawn 时刻（Node 的
 * performance.now 从进程启动计时），否则量到的只是「本模块被加载到首屏」。
 * 时钟可注入，测试不需要真的等。
 */
export class BootTrace {
  private readonly phases: { stage: string; at: number }[] = []
  private readonly seen = new Set<string>()

  constructor(
    private readonly now: () => number = () => {
      return Date.now()
    },
    startedAt: number = now() - performance.now(),
  ) {
    this.push('process-start', startedAt)
  }

  /** 打一个阶段标记（同名只记第一次，重复调用不会污染计时）。 */
  mark(stage: string): void {
    this.push(stage, this.now())
  }

  private push(stage: string, at: number): void {
    if (this.seen.has(stage)) return
    this.seen.add(stage)
    this.phases.push({ stage, at })
  }

  /**
   * 并入渲染层上报的阶段。
   *
   * 渲染层的 `performance.now()` 从导航起点计时，主进程看不到那个零点，因此由调用
   * 方给出 offset（loadURL 那一刻在主进程时钟上的位置），两边才对得上一条时间轴。
   */
  recordRenderer(report: RendererBootReport, offsetMs: number): void {
    for (const phase of report.phases) this.push(`renderer:${phase.stage}`, offsetMs + phase.ms)
  }

  /** 当前快照。 */
  snapshot(): BootSnapshot {
    const first = this.phases[0]?.at ?? this.now()
    const last = this.phases[this.phases.length - 1]?.at ?? first
    let previous = first
    return {
      startedAt: first,
      totalMs: last - first,
      phases: this.phases.map((phase) => {
        const deltaMs = phase.at - previous
        previous = phase.at
        return { stage: phase.stage, sinceStartMs: phase.at - first, deltaMs }
      }),
    }
  }

  /** 单行摘要，直接进日志（阶段顺序即时间轴）。 */
  summary(): string {
    const snapshot = this.snapshot()
    const body = snapshot.phases
      .map((phase) => {
        return `${phase.stage} +${phase.sinceStartMs}ms（+${phase.deltaMs}ms）`
      })
      .join(' → ')
    return `启动 ${snapshot.phases.length} 段：${body}`
  }
}

/** 渲染层上报的启动阶段（毫秒相对渲染层自己的导航起点）。 */
export interface RendererBootReport {
  phases: { stage: string; ms: number }[]
}

/** 渲染层启动阶段挂在 window 上的全局键（主进程用 executeJavaScript 读，不经 preload）。 */
const RENDERER_BOOT_GLOBAL = '__RYHARNESS_BOOT__'

/**
 * 从渲染层读回它自己记的阶段（首屏 JS 执行 → DOM 就绪 → 首帧）。
 *
 * 没有全局变量只是说明页面还没执行到那段代码，不算错误。
 */
export function readRendererBootReport(payload: unknown): RendererBootReport {
  if (typeof payload !== 'object' || payload === null) return { phases: [] }
  const phases = (payload as { phases?: unknown }).phases
  if (!Array.isArray(phases)) return { phases: [] }
  return {
    phases: phases.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const stage = (item as { stage?: unknown }).stage
      const ms = (item as { ms?: unknown }).ms
      return typeof stage === 'string' && typeof ms === 'number' && Number.isFinite(ms) ? [{ stage, ms }] : []
    }),
  }
}

/**
 * 把本次启动计时写进 userData 下的 boot-trace.log（覆盖上次，一次启动一行）。
 *
 * 覆盖而不是追加：用户排障要看的是「这次为什么慢」，历史行只会越积越多没人翻。
 * 写不进去（只读安装目录/磁盘满）不该挡住启动，因此吞掉异常。
 */
export function writeBootTraceLog(userDataDir: string, trace: BootTrace): void {
  try {
    writeFileSync(join(userDataDir, 'boot-trace.log'), `${JSON.stringify(trace.snapshot(), null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error('[ryharness] failed to write boot trace log:', error)
  }
}

/** 本次启动的计时器（模块级：main() 与 IPC handler 共用同一份）。 */
const bootTrace = new BootTrace()

/**
 * 启动时加载 .env（KEY=VALUE）。用 Node 自带的 process.loadEnvFile——引擎要求
 * ^22.19||>=24，自带实现语义明确（已存在的环境变量优先），不再手写解析器。
 *
 * 候选路径见 {@link dotEnvCandidates}：生产态只认显式指定与 userData 两处，
 * 开发态才多给应用目录 / 仓库根 / cwd。
 *
 * 由 main() 在 app.whenReady 之后调用（而不是模块顶层）：顶层执行会让测试
 * import 本模块时先摸一遍磁盘上的 .env。
 */
function loadDotEnvIntoProcess(): void {
  const candidates = dotEnvCandidates({
    envFile: envValue(process.env, 'ENV_FILE'),
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
    cwd: process.cwd(),
    packaged: app.isPackaged,
  })
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      process.loadEnvFile(candidate)
    } catch (error) {
      // 解析失败不应挡住启动：凭据缺失由 provider 状态灯与首启配置卡兜底。
      console.error(`[ryharness] failed to load env file ${candidate}:`, error)
    }
    return
  }
}

/**
 * 产品名与版本：运行时从**应用自己的** package.json 读，不在代码里写死。
 * app.getAppPath() 打包后指向 resources/app.asar（Electron 的 fs 能透明读 asar），
 * 开发态指向 apps/desktop——两边是同一份文件，版本号因此只有一个来源，
 * 改版本只需要改 package.json，不必同步改菜单文案与关于框。
 */
function readAppMeta(): { name: string; version: string } {
  try {
    const raw = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { productName?: string; name?: string; version?: string }
    return {
      name: pkg.productName ?? pkg.name ?? 'RyHarness',
      version: pkg.version ?? app.getVersion(),
    }
  } catch {
    // 读不到就退回 Electron 自己的取值：关于框只是信息展示，不该把启动带崩。
    return { name: 'RyHarness', version: app.getVersion() }
  }
}

/** 「关于」对话框。开发运行额外标注，避免有人拿开发构建当成发布版报障。 */
function showAbout(): void {
  const meta = readAppMeta()
  dialog.showMessageBox({
    type: 'info',
    title: `关于 ${meta.name}`,
    message: `${meta.name} ${meta.version}`,
    detail: [
      app.isPackaged ? '' : '开发模式运行（非发布构建）。',
      '单机多 Agent 即时通讯桌面应用。',
      'MIT License；第三方资产署名见安装目录 resources/NOTICE.md。',
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
    buttons: ['好'],
  })
}

/**
 * 应用菜单：macOS 走系统约定的「应用 / 编辑 / 视图 / 窗口」；Windows 与 Linux
 * 同样建菜单，但 BrowserWindow 的 autoHideMenuBar 让它默认收起（Alt 唤出）——
 * 保留「关于 / 重新加载 / 开发者工具 / 退出」四个入口，退出走 app.quit()
 * 触发 before-quit 的后端 flush，不给「数据没落盘就关窗」留口子。
 */
/** 派发一个窗口事件到渲染层（应用菜单里的动作走这条路）。 */
function dispatchToRenderer(event: string): void {
  const win = mainWindow
  if (win === undefined || win.isDestroyed()) return
  void win.webContents
    .executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(event)}))`)
    .catch((error: unknown) => {
      console.error('[renderer] failed to dispatch event:', error)
    })
}

function applyAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const meta = readAppMeta()
  const aboutItem: MenuItemConstructorOptions = { label: `关于 ${meta.name}`, click: showAbout }
  const quitItem: MenuItemConstructorOptions = { role: 'quit', label: `退出 ${meta.name}` }
  const windowItems: MenuItemConstructorOptions[] = [
    { role: 'minimize', label: '最小化' },
    { role: 'zoom', label: '缩放' },
    { role: 'close', label: '关闭窗口' },
  ]
  if (isMac) windowItems.push({ role: 'front', label: '前置全部窗口' })

  const template: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: meta.name,
          submenu: [
            aboutItem,
            { type: 'separator' },
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: `隐藏 ${meta.name}` },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            quitItem,
          ],
        },
      ]
    : [{ label: '文件', submenu: [aboutItem, { type: 'separator' }, quitItem] }]
  template.push(
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        {
          label: SEARCH_SHORTCUT.label,
          accelerator: SEARCH_SHORTCUT.accelerator,
          click: () => {
            dispatchToRenderer(SEARCH_FOCUS_EVENT)
          },
        },
        {
          label: NEW_CHAT_SHORTCUT.label,
          accelerator: NEW_CHAT_SHORTCUT.accelerator,
          click: () => {
            dispatchToRenderer(NEW_CHAT_EVENT)
          },
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { label: '窗口', submenu: windowItems },
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 建窗口并开始加载渲染层。不 await——调用方与 server 启动并行。
 * `pageUrl` 是渲染层入口；生产模式不带 ?api=（后端可能还没就绪，由 pushApiBase 补）。
 */
/** 窗口最小尺寸（DIP）；与设计规范的窄屏下限一致。 */
const MIN_WIDTH = 1024
const MIN_HEIGHT = 680

/**
 * 自绘标题栏。原生标题栏是中性冷灰的一条带，和下方暖奶油的内容之间是一道硬缝
 * （截图上就是顶部 45px 的灰）；`titleBarStyle: 'hidden' + titleBarOverlay` 把它换成
 * 页面自己的底色，窗口按钮浮在渲染层让出的顶条上。
 *
 * 高度与配色必须与 renderer 的 styles.css 同源（--titlebar-h / --bg-app /
 * --text-secondary）：两边各写一份，迟早对不上一次。
 */
const TITLEBAR_H = 40
const TITLEBAR_OVERLAY = {
  light: { color: '#FAF7F2', symbolColor: '#736B65' },
  dark: { color: '#14110E', symbolColor: '#EDE8E2' },
} as const
const IS_MAC = process.platform === 'darwin'

/**
 * 标题栏配色跟随渲染层的主题。
 *
 * 标题栏由原生绘制，只有主进程能改；而渲染层翻转主题只改 documentElement 的
 * data-theme，preload 此前也没有回传通道（DesktopBridge 只有 appName/openPath），
 * 所以这里在窗口**获得焦点期间**每 400ms 问一次渲染层「现在什么主题」——
 * 一次 executeJavaScript 就是一个跨进程往返，常年占着渲染层的主线程。
 *
 * 现在改成**推**：渲染层切主题时经 preload 说一声（ryharness:theme），主进程直接改；
 * 只在首屏加载完与窗口获得焦点时各拉一次（首屏那次渲染层可能还没挂上桥，推不回来）。
 */
function followRendererTheme(window: BrowserWindow): void {
  if (IS_MAC) return
  const pull = (): void => {
    if (window.isDestroyed()) return
    void window.webContents
      .executeJavaScript("document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'")
      .then((theme: unknown) => {
        applyTitleBarTheme(theme)
      })
      .catch(() => {
        // 文档还没就绪时 executeJavaScript 会抛；渲染层那一下推会补上。
      })
  }
  window.webContents.on('did-finish-load', pull)
  window.on('focus', pull)
}

/** 把主题色刷到原生标题栏上（渲染层推过来或首屏拉一次，都走这里）。 */
function applyTitleBarTheme(theme: unknown): void {
  if (IS_MAC) return
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  window.setTitleBarOverlay({
    ...TITLEBAR_OVERLAY[theme === 'dark' ? 'dark' : 'light'],
    height: TITLEBAR_H,
  })
}

/**
 * 应用页面的 origin：窗口建起来时记下，IPC 校验来源用。
 */
let appPageOrigin: string | undefined

/**
 * IPC 的来源校验：只有应用自己的页面能调。
 *
 * Electron 安全清单第 17 条：任何被加载进这个窗口的 frame（blob:、同源 iframe）
 * 都能 invoke 这些 channel。不校验来源，等于把主进程的能力一并开放出去。
 */
function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  const origin = event.senderFrame?.origin
  if (origin === undefined || appPageOrigin === undefined) return false
  return origin === appPageOrigin
}

/**
 * 「打开工作区目录 / 用系统程序打开产物」的唯一通道：渲染层拿不到 Node 权限，
 * 只能经 preload 调到这里。
 *
 * 目录与产物路径来自本机后端（GET /api/workspace、GET /api/files/:name/info），
 * 不是网页传来的任意 URL——但后端给的是 agent 写出来的东西，所以这里仍然要过
 * 三道闸：来源是应用自己的页面、路径在工作区之内、不是可执行文件。
 * shell.openPath 成功返回空串。
 *
 * 注册放进 main()（而不是模块顶层）：顶层 ipcMain.handle 在测试里 import 本模块
 * 时会立刻打在一个不存在的 ipcMain 上。
 */
function registerIpcHandlers(workspaceRoot: string): void {
  ipcMain.handle('ryharness:open-path', (event, targetPath: unknown) => {
    if (!isTrustedSender(event)) return 'invalid sender'
    if (typeof targetPath !== 'string') return 'invalid path'
    if (!canOpenPath(workspaceRoot, targetPath)) return 'invalid path'
    return shell.openPath(targetPath)
  })
  // 启动计时的查询口：开发时从渲染层/控制台随时问「这次启动各阶段多久」，
  // 不依赖任何遥测服务（离线开发、CI、本机排障都能用）。
  ipcMain.handle('ryharness:boot-trace', () => {
    return bootTrace.snapshot()
  })
  /**
   * 渲染层切了主题，推过来让原生标题栏跟上。
   *
   * 此前主进程是每 400ms 问渲染层一次「现在什么主题」——一次 executeJavaScript 就是
   * 一个跨进程往返，常年占着渲染层的主线程。改成推之后这个往返只在切主题时发生一次。
   */
  ipcMain.on('ryharness:theme', (event, theme: unknown) => {
    if (!isTrustedSender(event)) return
    if (theme !== 'light' && theme !== 'dark') return
    applyTitleBarTheme(theme)
  })
}

/**
 * 权限策略：默认拒绝，按白名单放行。
 *
 * Electron 的默认行为是**自动批准所有权限请求**（见 security.ts 里的说明）。
 */
function registerPermissionPolicy(): void {
  const target = session.defaultSession
  target.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowedPermission(permission))
  })
  target.setPermissionCheckHandler((_webContents, permission) => {
    return allowedPermission(permission)
  })
}

/**
 * 主显示器的工作区尺寸（DIP）。
 *
 * 注意：本机 1.5× 缩放下 Electron 的 workAreaSize 返回的是**物理像素**（1707），
 * 而窗口 bounds 是 DIP——两者混用会让自动居中把窗口放到屏幕外。所以先用
 * dipToScreenPoint 探测坐标单位再统一换算，位置也自己算，不依赖 Electron 居中。
 */
function primaryWorkArea(): { width: number; height: number } {
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const probe = screen.dipToScreenPoint({ x: 100, y: 100 })
  const unit = Math.abs(probe.x - 100) < 0.5 ? 1 : scale
  return {
    width: Math.round(display.workAreaSize.width / unit),
    height: Math.round(display.workAreaSize.height / unit),
  }
}

/**
 * 开窗尺寸与位置：设计稿按 1320×840，但 150% 缩放的小屏工作区可能只有 1100 DIP 宽，
 * 固定尺寸会让窗口超出屏幕、右侧内容被裁掉（内容按视口宽度布局，视口比屏幕宽）。
 * 这里按主显示器工作区收敛，并保证不小于 minWidth/minHeight。
 */
function fitToWorkArea(desired: { width: number; height: number }): {
  width: number
  height: number
  x: number
  y: number
} {
  const work = primaryWorkArea()
  const width = Math.min(desired.width, Math.max(MIN_WIDTH, work.width - 32))
  const height = Math.min(desired.height, Math.max(MIN_HEIGHT, work.height - 32))
  return {
    width,
    height,
    x: Math.max(0, Math.round((work.width - width) / 2)),
    y: Math.max(0, Math.round((work.height - height) / 4)),
  }
}

/** 窗口位置状态文件的位置（userData 下）。 */
function windowStatePath(): string {
  return join(app.getPath('userData'), WINDOW_STATE_FILE)
}

/** 外链 URL 的长度上限：超长的多半是畸形输入，不值得交给系统浏览器。 */
export const MAX_EXTERNAL_URL_LENGTH = 2048

/**
 * 外链策略：这个 URL 允许交给系统浏览器打开吗？
 *
 * 渲染层有五处 `target="_blank"`（Markdown 里的链接、「去官网申请 API Key」、
 * 产物的「在新窗口打开」…）。此前主进程既没有 `setWindowOpenHandler`，也没有
 * `shell.openExternal`，于是它们开出来的是**应用自己的新窗口**：无边框、无菜单、
 * 独立任务栏，看起来像被劫持，而用户真正的浏览器被绕开了。
 *
 * 只放行 http/https：`file:` 会让系统浏览器打开本机文件、`javascript:` 在部分
 * 浏览器里仍可执行、`data:` 则是内联内容——这些都不该从应用里递出去。
 *
 * @param raw - 渲染层交上来的原始 URL。
 * @returns 规范化后的 URL；不允许打开时返回 undefined。
 */
export function externalLinkUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_EXTERNAL_URL_LENGTH) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.toString()
}

/**
 * 窗口新开请求的处理：允许的 http(s) 交给系统浏览器，其余一律 deny。
 *
 * 抽成纯函数是为了能测：主进程里的 `setWindowOpenHandler` 回调一旦接错
 * （放行了 file:、或者忘了 deny 掉内部窗口），表现是"点个链接弹出一个没有
 * 边框的孤儿窗口"——不接成纯函数就只能靠真机手点。
 *
 * @param open - 真正打开外部 URL 的动作（主进程里接 shell.openExternal）。
 */
export function externalWindowOpenHandler(
  open: (url: string) => void,
): (details: { url: string }) => { action: 'deny' } {
  return ({ url }) => {
    const external = externalLinkUrl(url)
    if (external !== undefined) open(external)
    return { action: 'deny' }
  }
}

/**
 * 窗口自身导航的判定。
 *
 * 站内（同一个 origin）放行——那是应用自己的页面；站外一律拦下这次导航，
 * 并把 http(s) 链接交给系统浏览器。不拦的话，`<a target="_self">` 或一段脚本
 * 就能把应用壳带跑，用户看到的是"应用变成了网页"。
 *
 * @param url - 即将导航到的地址。
 * @param pageOrigin - 应用页面的 origin（资源服务）。
 */
export function externalNavigationTarget(url: string, pageOrigin: string): { allow: boolean; external?: string } {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { allow: false }
  }
  if (target.origin === pageOrigin) return { allow: true }
  const external = externalLinkUrl(url)
  return external === undefined ? { allow: false } : { allow: false, external }
}

function createWindow(pageUrl: string): BrowserWindow {
  const fit = fitToWorkArea({ width: 1320, height: 840 })
  const pageOrigin = new URL(pageUrl).origin
  // 记下应用页面的 origin：IPC 校验来源用（只有这个 origin 的页面能调主进程）。
  appPageOrigin = pageOrigin
  // 记住上次的位置与尺寸：桌面应用的基本盘之一。位置要收敛回当前屏幕
  // （换了显示器或分辨率之后，上次的坐标可能整块在屏外）。
  const statePath = windowStatePath()
  const remembered = readWindowBounds(statePath)
  const work = primaryWorkArea()
  const bounds =
    remembered === undefined ? fit : clampBounds(remembered, work, { width: MIN_WIDTH, height: MIN_HEIGHT })
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#FAF7F2',
    title: 'RyHarness',
    icon: appIcon('window'),
    // 首帧画完再显示，避免加载期的白/空窗口闪烁（加载期的骨架由渲染层自己画）。
    show: false,
    // macOS 的交通灯留在系统内嵌位置（渲染层同样让出 40px 顶条，两端布局一致）；
    // Windows/Linux 用 Window Controls Overlay，窗口按钮浮在页面之上。
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    ...(IS_MAC ? {} : { titleBarOverlay: { ...TITLEBAR_OVERLAY.light, height: TITLEBAR_H } }),
    // Windows/Linux 默认收起菜单（Alt 唤出），macOS 保留常驻应用菜单。
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 20 起默认就是 true，写出来是因为它和上一行是同一组约束：
      // sandbox 只按 CommonJS 装载 preload，所以产物必须是 .cjs（tsdown.config.mjs
      // 为此把它单独构建了一次）。谁把 sandbox 关掉或把 preload 换成 ESM，桥都会
      // 静默消失且渲染层零报错——这一行把那条隐式依赖变成显式的。
      sandbox: true,
      // Chromium 把内置 PDF 阅读器挂在 NPAPI 插件开关后面，Electron 默认关掉它。
      // 这正是原来「PDF 只能下载、不能预览」的根因：不是路径或 MIME 的问题，也不是
      // 缺 pdf.js。打开这一项，`<embed type="application/pdf">` 才能真正渲染出页面。
      plugins: true,
    },
  })
  window.once('ready-to-show', () => {
    window.show()
  })
  // 记住位置与尺寸：拖动/缩放停下来后（去抖 400ms）写回，退出时也写一次。
  // 写失败只当没记住——记不住窗口位置不是故障，不该打断用户。
  let rememberTimer: ReturnType<typeof setTimeout> | undefined
  const rememberBounds = (): void => {
    if (window.isDestroyed()) return
    writeWindowBounds(statePath, window.getBounds())
  }
  const scheduleRemember = (): void => {
    if (rememberTimer !== undefined) clearTimeout(rememberTimer)
    rememberTimer = setTimeout(() => {
      rememberTimer = undefined
      rememberBounds()
    }, 400)
  }
  window.on('resize', scheduleRemember)
  window.on('move', scheduleRemember)
  window.on('close', () => {
    if (rememberTimer !== undefined) clearTimeout(rememberTimer)
    rememberBounds()
  })
  followRendererTheme(window)
  // 关窗不退出：托盘在场时窗口只是收起来，正在跑的活继续跑（退出走托盘菜单）。
  // 没有托盘（截图模式）时保持 Electron 默认行为，关窗即关。
  window.on('close', (event) => {
    if (quitting || tray === undefined) return
    event.preventDefault()
    window.hide()
    if (hideHintShown) return
    hideHintShown = true
    notify(`${readAppMeta().name} 还在托盘里`, '助理们照常接活；要退出请点托盘菜单的「退出」。')
  })
  window.on('focus', () => {
    windowFocused = true
    presence?.markSeen()
  })
  window.on('blur', () => {
    windowFocused = false
  })
  window.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[renderer] load failed: ${description} (${code})`)
  })
  // 外链交给系统浏览器：应用自己开的新窗口是无边框、无菜单的孤儿窗口，
  // 看起来像被劫持，用户真正的浏览器反倒被绕开。渲染层五处 target="_blank"
  // （Markdown 链接、「去官网申请 API Key」、产物的「在新窗口打开」）全走这一条。
  window.webContents.setWindowOpenHandler(
    externalWindowOpenHandler((url) => {
      void shell.openExternal(url)
    }),
  )
  // 窗口自身不导航到站外：没有这一条，<a target="_self"> 或脚本导航就能把
  // 应用壳带跑，用户看到的是"应用变成了网页"。站外链接同样交给系统浏览器。
  window.webContents.on('will-navigate', (event, url) => {
    const decision = externalNavigationTarget(url, pageOrigin)
    if (decision.allow) return
    event.preventDefault()
    if (decision.external !== undefined) void shell.openExternal(decision.external)
  })
  // 首屏计时：DOM 就绪 = 骨架屏已画出来，did-finish-load = 所有分片到齐。
  window.webContents.on('dom-ready', () => {
    bootTrace.mark('dom-ready')
  })
  window.webContents.on('did-finish-load', () => {
    bootTrace.mark('loaded')
    void collectRendererBootPhases(window)
  })
  // 渲染层 performance.now() 的零点（导航起点）在主进程看来就是 loadURL 这一刻。
  windowLoadStartedAt = Date.now()
  void window.loadURL(pageUrl)
  bootTrace.mark('window-created')
  return window
}

/**
 * 渲染层首屏阶段并进主进程时间轴（读 window.__RYHARNESS_BOOT__，不经 preload）。
 *
 * 读不到不算失败：老页面还没执行到 boot-trace 模块、或窗口已经关掉，属正常。无论
 * 有没有读到，这份计时都会落一行日志并写进 userData——主进程各阶段本身就是排障要的。
 */
async function collectRendererBootPhases(window: BrowserWindow): Promise<void> {
  try {
    const payload: unknown = await window.webContents.executeJavaScript(
      `JSON.stringify(window.${RENDERER_BOOT_GLOBAL} ?? null)`,
    )
    bootTrace.recordRenderer(readRendererBootReport(JSON.parse(String(payload))), windowLoadStartedAt)
  } catch (error) {
    console.error('[ryharness] failed to collect renderer boot phases:', error)
  }
  console.log(`[ryharness] ${bootTrace.summary()}`)
  writeBootTraceLog(app.getPath('userData'), bootTrace)
}

/** 等待首屏加载结束（截图模式依赖这个契约；失败也算结束，避免永久挂起）。 */
function whenLoaded(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoadingMainFrame()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const settle = (): void => {
      resolve()
    }
    window.webContents.once('did-finish-load', settle)
    window.webContents.once('did-fail-load', settle)
  })
}

/**
 * 后端就绪后把 API 地址与 token 推给渲染层（contextIsolation 下不用 preload 注入）。
 *  页面还在加载时先等 did-finish-load——否则脚本会落在旧的 about:blank 文档上。
 *  推的是**实际绑定到的**地址（端口回退随机时与配置的固定端口不同）。
 *
 *  渲染层契约（apps/desktop/renderer/src/lib/boot.ts 消费）：
 *  - `window.__RYHARNESS_API_BASE__` / `ryharness:api-base` 事件（detail = 地址字符串）；
 *  - `window.__RYHARNESS_API_TOKEN__` / `ryharness:api-token` 事件（detail = token 字符串）；
 *  - 请求带上 `Authorization: Bearer <token>`，WS 用 `?token=<token>`。
 *  两个事件分开而不是把 detail 改成对象：事件名与旧的地址通道一一对应，
 *  只加一条不改旧的，渲染层什么时候接上都接得上。
 */
function pushApiBase(window: BrowserWindow, apiBase: string, token: string | undefined): void {
  const payload = JSON.stringify(apiBase)
  const tokenPayload = JSON.stringify(token ?? '')
  const script =
    `window.__RYHARNESS_API_BASE__=${payload};` +
    `window.dispatchEvent(new CustomEvent('ryharness:api-base',{detail:${payload}}));` +
    `window.__RYHARNESS_API_TOKEN__=${tokenPayload};` +
    `window.dispatchEvent(new CustomEvent('ryharness:api-token',{detail:${tokenPayload}}));`
  const send = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.executeJavaScript(script).catch((error: unknown) => {
      console.error('[renderer] failed to push api base:', error)
    })
  }
  bootTrace.mark('api-base-pushed')
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', send)
    // 兜底：加载失败/超时也要送达（渲染层有全局变量 + 事件双通道）。
    setTimeout(send, 3000)
    return
  }
  send()
}

// ---- 常驻：托盘 / 通知 / 开机自启 / 首启演示会话 ----

/** 主窗口与其入口地址：Dock、托盘、通知都靠它把窗口叫回来。 */
let mainWindow: BrowserWindow | undefined
let pageUrl = ''
/** 最近一次 loadURL 的主进程时刻：把渲染层的相对计时对齐到主进程时间轴。 */
let windowLoadStartedAt = Date.now()
let tray: Tray | undefined
/** before-quit 已经发起：此后关窗口才是真退出，不该再收进托盘。 */
let quitting = false
/** 窗口是否在前台：决定新回复是弹通知，还是只悄悄进列表。 */
let windowFocused = false
/** 收进托盘时只说一次「它还在」，之后别反复打扰。 */
let hideHintShown = false
/** 在场监听器（订阅后端 WS，驱动托盘与通知）。 */
let presence: PresenceMonitor | undefined

/** 首启演示会话的标题前缀：一眼看出是示例，不是用户自己的历史。 */
export const DEMO_TITLE_PREFIX = '示例'
/** 首启只跑一次的标记：示例被用户删掉后不该在下次启动时又长回来。 */
const FIRST_LAUNCH_MARKER = 'first-launch-seeded'
/**
 * 托盘「新对话」派发给渲染层的事件名。
 *
 * 与 renderer/src/App.tsx 里的 NEW_CHAT_EVENT 是同一个字符串：主进程与渲染层
 * 各自打包、不共享模块，所以这里只靠名字对齐——改一边必须改另一边。
 */
const NEW_CHAT_EVENT = 'ryharness:new-chat'
/**
 * 通知点击「落到那条会话」派发给渲染层的事件名。
 *
 * 与 renderer/src/App.tsx 里的 OPEN_CONVERSATION_EVENT 是同一个字符串：主进程与
 * 渲染层各自打包、不共享模块，只靠名字对齐——改一边必须改另一边（同 NEW_CHAT_EVENT）。
 */
const OPEN_CONVERSATION_EVENT = 'ryharness:open-conversation'
/** 新回复的通知正文长度上限（超了通知面板会自己截断，这里先截干净）。 */
const NOTIFY_BODY_LIMIT = 160

/** 打开主窗口：没有就重建（macOS Dock / 托盘），有就还原并前置。 */
function showMainWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    mainWindow = createWindow(pageUrl)
  } else if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 在渲染层里执行一段脚本：窗口还在加载时排队到加载完成再跑。
 *
 * 冷启动点通知（showMainWindow 刚重建窗口、页面还没加载完）时直接 executeJavaScript
 * 会落在旧的 about:blank 文档上，页面一导航、脚本连同它的重试定时器一起被丢掉。
 * 与 pushApiBase 同一套「did-finish-load + 超时兜底」的排队。
 */
function runInRenderer(win: BrowserWindow, script: string): void {
  const send = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    void win.webContents.executeJavaScript(script).catch((error: unknown) => {
      console.error('[renderer] failed to run script:', error)
    })
  }
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', send)
    setTimeout(send, 3000)
    return
  }
  send()
}

/**
 * 系统通知；点通知回到主窗口，并落到那条会话（有 id 才驱动渲染层）。
 *
 * IM 的肌肉记忆是「点通知 → 落到那条聊天」：只把窗口弹起来，用户还得自己在
 * 列表里找是谁回了话，「助理主动找我」这条回访回路就断在最后一厘米。
 */
function notify(title: string, body: string, options: { conversationId?: string } = {}): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title,
    body: body.length > NOTIFY_BODY_LIMIT ? `${body.slice(0, NOTIFY_BODY_LIMIT)}…` : body,
  })
  notification.on('click', () => {
    showMainWindow()
    const conversationId = options.conversationId
    // 会话 id 缺席（托盘提示这类）时只回窗口；有 id 才让渲染层选中那条会话。
    if (conversationId === undefined || conversationId.length === 0) return
    // showMainWindow 可能重建了窗口，句柄要在这之后取。
    const win = mainWindow
    if (win === undefined || win.isDestroyed()) return
    runInRenderer(win, openConversationScript(conversationId))
  })
  notification.show()
}

/** 开机自启是否已开。Electron 在部分平台读不到设置，此时按「关」处理。 */
export function isAutoLaunchEnabled(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

/** 开关开机自启，并让托盘菜单的勾选立刻回显。 */
export function setAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled })
  tray?.setContextMenu(buildTrayMenu())
}

/**
 * 全局免打扰：开着时任何会话都不弹系统通知。
 *
 * 与「按会话静音」是两层：前者是应用级的开关（现在不想被打扰），后者是某个
 * 群太吵、只压它一个。
 */
let doNotDisturb = false

/** 免打扰当前是否开着（托盘菜单与通知路径共用同一份）。 */
export function isDoNotDisturb(): boolean {
  return doNotDisturb
}

/** 开关免打扰，并让托盘菜单的勾选立刻回显。 */
export function setDoNotDisturb(enabled: boolean): void {
  doNotDisturb = enabled
  tray?.setContextMenu(buildTrayMenu())
}

/** 托盘菜单：打开主窗口 / 新对话 / 免打扰 / 开机自启 / 退出，项项都有真实行为。 */
function buildTrayMenu(): Menu {
  const meta = readAppMeta()
  return Menu.buildFromTemplate([
    {
      label: '打开主窗口',
      click: () => {
        showMainWindow()
      },
    },
    {
      label: '新对话',
      click: () => {
        startNewChat()
      },
    },
    { type: 'separator' },
    {
      label: '免打扰',
      type: 'checkbox',
      checked: doNotDisturb,
      click: (item) => {
        setDoNotDisturb(item.checked)
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: isAutoLaunchEnabled(),
      click: (item) => {
        setAutoLaunch(item.checked)
      },
    },
    { type: 'separator' },
    {
      label: `退出 ${meta.name}`,
      click: () => {
        app.quit()
      },
    },
  ])
}

/** 建托盘：图标 + 菜单 + 点击回到主窗口。图标读不出来就不建（应用退回到「关窗即退」）。 */
function createTray(): void {
  // 托盘不吃矢量：直接用 16/24 档那份已经做过光学补偿的位图，不再从大图缩。
  const file = appIcon(trayIconTier(screen.getPrimaryDisplay().scaleFactor))
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) {
    // 空图标在部分平台上会让 Tray 抛错，把整个主进程带下去；宁可不常驻。
    console.error(`[ryharness] tray icon missing: ${file}`)
    return
  }
  tray = new Tray(image)
  tray.setToolTip(trayStatusText(readAppMeta().name, { busy: new Map(), unread: 0 }))
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => {
    showMainWindow()
  })
}

/** 托盘状态刷新：tooltip 说清现在是在忙、在等人看，还是待命。 */
function updateTray(state: PresenceState): void {
  tray?.setToolTip(trayStatusText(readAppMeta().name, state))
  if (IS_MAC) tray?.setTitle(state.busy.size > 0 ? '…' : '')
}

/** 托盘 tooltip 文案。 */
export function trayStatusText(appName: string, state: PresenceState): string {
  if (state.busy.size > 0) {
    // 一个会话里可能是几个助理接力（群聊一轮三人各说一段），所以按 agent 名摊平再去重。
    const names = [...new Set([...state.busy.values()].flatMap((agents) => [...agents]))]
    const who = names.length === 1 ? names[0] : `${names.length} 位助理`
    return `${appName}：${who}正在回复…`
  }
  if (state.unread > 0) return `${appName}：${state.unread} 条新回复等你回来`
  return `${appName}：待命中，点开说点什么`
}

/** 在场状态快照。 */
export interface PresenceState {
  /** 会话 id → 这一轮正在发言的 agent 名（群聊一轮可能是好几位）。 */
  busy: Map<string, ReadonlySet<string>>
  /** 窗口不在前台时攒下的新回复条数。 */
  unread: number
}

/** 主进程用到的最小 WS 形态（便于测试注入替身）。 */
export interface MinimalSocket {
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  close(): void
}

/** 在场监听所需的后端事件契约：直接用服务端的 @ryharness/server WsEvent。 */
type PresenceEvent = WsEvent

/** 一条轮次里某个 agent 的发言：托盘上叫什么、这轮已经说了多少字。 */
interface TurnSpeaker {
  /** 收到过 message-start 才算「开口了」；只见到 dispatch / 工具事件的是「在场未开口」。 */
  started: boolean
  /** 托盘与通知上显示的名字。后端还没给名字时（派工、工具事件）退回 senderId。 */
  name: string
  /** 这一轮该 agent 的正文增量。 */
  text: string
}

/** 一条轮次（一个 turnIndex）里所有 agent 的发言。 */
interface ConversationTurn {
  /** 还没发完 message-done 的 agent（senderId → 发言状态）。托盘只算这些。 */
  pending: Map<string, TurnSpeaker>
  /** 已经说完的发言，按说完顺序留着：整轮收口时一起进那一条通知。 */
  spoken: TurnSpeaker[]
}

/**
 * 没带 turnIndex 的事件归到这个键下。
 *
 * 服务端契约里 text-delta 与工具类事件不带 turnIndex（见 apps/server/src/events.ts），
 * 所以「这是哪条轮次的」只能拿 senderId 反查正在进行的轮次；一条都查不到时
 * （主进程中途才连上 WS，漏掉了 message-start）先记在这个占位轮次里，等
 * message-done 到来时按「这个会话只剩一条在跑的轮次」把它收掉——否则托盘会
 * 永远停在「正在回复」。
 */
const UNKNOWN_TURN = 'unknown'
/** 轮次键：真实 turnIndex，或上面那个占位键。 */
type TurnKey = number | typeof UNKNOWN_TURN

/** 会话列表多久扫一次（新会话建出来后自动纳入监听）。 */
const DISCOVER_INTERVAL_MS = 5000
/** WS 断线重连退避（ms）。 */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000]

/** 把 http(s) 基地址换成 WS 订阅地址。浏览器 WS 不能带自定义头，token 走查询串。 */
export function websocketUrl(baseUrl: string, conversationId: string, token?: string): string {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = ''
  url.searchParams.set('conversationId', conversationId)
  if (token !== undefined && token.length > 0) url.searchParams.set('token', token)
  return url.toString()
}

/**
 * 解析一条 WS 推送；形状不对就当没收到（主进程不该被脏数据带崩）。
 *
 * 逐个 type 按 @ryharness/server 的 WsEvent 契约逐字段校验，而不是「能抄几个抄几个」：
 * 手写鸭子类型时服务端改一个字段名，这里静默读到 undefined，通知少一条也看不出异常。
 * 现在返回的就是真 WsEvent——下游 switch 能按联合类型收窄，服务端新增事件类型时
 * 漏处理的分支直接编译不过（见 PresenceMonitor.onEvent 末尾的 never 校验）。
 */
function parsePresenceEvent(raw: unknown): PresenceEvent | undefined {
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const fields = parsed as Record<string, unknown>
  const str = (key: string): string | undefined => {
    const value = fields[key]
    return typeof value === 'string' ? value : undefined
  }
  const type = str('type')
  const conversationId = str('conversationId')
  if (type === undefined || conversationId === undefined) return undefined
  const senderId = str('senderId')
  const turnIndex = fields.turnIndex
  const callId = str('callId')
  switch (type) {
    case 'message-start': {
      // senderName 缺了还能退到 senderId：名字只用于托盘与通知抬头，不能因为它
      // 把「有人在忙」这个事实整条丢掉。
      if (senderId === undefined || typeof turnIndex !== 'number') return undefined
      return {
        type: 'message-start',
        conversationId,
        senderId,
        senderName: str('senderName') ?? senderId,
        turnIndex,
      }
    }
    case 'text-delta': {
      const text = str('text')
      if (senderId === undefined || text === undefined) return undefined
      return { type: 'text-delta', conversationId, senderId, text }
    }
    case 'tool-call-start': {
      const name = str('name')
      const args = str('arguments')
      if (senderId === undefined || callId === undefined || name === undefined || args === undefined) return undefined
      return { type: 'tool-call-start', conversationId, senderId, callId, name, arguments: args }
    }
    case 'tool-result': {
      const name = str('name')
      const content = str('content')
      if (senderId === undefined || callId === undefined || name === undefined || typeof fields.isError !== 'boolean') {
        return undefined
      }
      return {
        type: 'tool-result',
        conversationId,
        senderId,
        callId,
        name,
        isError: fields.isError,
        content: content ?? '',
      }
    }
    case 'produce-card': {
      // 卡片字段也是契约的一部分，逐个校一遍，不给脏卡片留位置（在场监听只用 senderId）。
      const card = fields.card
      if (senderId === undefined || callId === undefined || typeof card !== 'object' || card === null) return undefined
      const meta = card as Record<string, unknown>
      const { path, mime, name: fileName, size } = meta
      if (
        typeof path !== 'string' ||
        typeof mime !== 'string' ||
        typeof fileName !== 'string' ||
        typeof size !== 'number'
      ) {
        return undefined
      }
      return { type: 'produce-card', conversationId, senderId, callId, card: { path, mime, name: fileName, size } }
    }
    case 'dispatch': {
      const toAgent = str('toAgent')
      const reason = str('reason')
      if (toAgent === undefined || reason === undefined || typeof turnIndex !== 'number') return undefined
      const fromAgent = str('fromAgent')
      return {
        type: 'dispatch',
        conversationId,
        ...(fromAgent === undefined ? {} : { fromAgent }),
        toAgent,
        reason,
        turnIndex,
      }
    }
    case 'message-done':
      if (senderId === undefined || typeof turnIndex !== 'number') return undefined
      // usage 在场监听用不到（用量面板在渲染层收），带不带都不影响托盘与通知。
      return { type: 'message-done', conversationId, senderId, turnIndex }
    case 'error': {
      const message = str('message')
      const code = str('code')
      if (message === undefined || code === undefined) return undefined
      return { type: 'error', conversationId, message, code }
    }
    case 'queued':
      // 契约里 queued 刻意不带 turnIndex（入队时这一轮还没有序号）。
      if (senderId !== 'user') return undefined
      return { type: 'queued', conversationId, senderId }
    default:
      // 服务端将来新增的类型：主进程对不认识的事件一律不猜。
      return undefined
  }
}

/**
 * 在场监听：主进程自己连后端 WS，逐会话跟踪「谁在写」。
 *
 * 渲染层只订阅当前打开的那个会话，托盘与通知却要覆盖全部会话——所以这里在
 * 主进程另起一份订阅；后端是单进程事件总线，多一个订阅者不会多跑一次模型。
 *
 * 记账按**轮次**而不是按会话：群聊一轮里三名 agent 各发一次
 * message-start / text-delta / message-done，共享同一个 turnIndex。早期版本把
 * 正文挂在会话上，于是第一条 message-done 就把草稿删干净，后两条正文为空 →
 * 弹两次「这一轮没有文字」、一轮未读 +3。现在同一轮只在最后一位 agent 收口时
 * 通知一次、累计一条未读。
 */
export class PresenceMonitor {
  private readonly sockets = new Map<string, MinimalSocket | WebSocket>()
  /** 会话 id → 轮次键 → 该轮发言。托盘状态由这里现算，不另存一份。 */
  private readonly turns = new Map<string, Map<TurnKey, ConversationTurn>>()
  private readonly attempts = new Map<string, number>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  private discoverTimer: ReturnType<typeof setInterval> | undefined
  /** 静音中的会话（按服务端回传的 muted 标记）。 */
  private readonly muted = new Set<string>()
  private unread = 0
  private stopped = false

  constructor(
    private readonly options: {
      baseUrl: string
      /** API token：常驻监听自己也要过同一道闸，否则 401 后托盘/通知全线哑掉。 */
      token?: string
      onState: (state: PresenceState) => void
      onReply: (reply: { agentName: string; text: string; conversationId: string }) => void
      isFocused: () => boolean
      /**
       * 全局免打扰：开着时任何会话都不弹通知。
       *
       * 与「按会话静音」是两层：前者是应用级的开关（现在不想被打扰），后者
       * 是某个群太吵、只压它一个。
       */
      isDnd?: () => boolean
      createSocket?: (url: string) => MinimalSocket | WebSocket
    },
  ) {}

  start(): void {
    void this.discover()
    this.discoverTimer = setInterval(() => {
      void this.discover()
    }, DISCOVER_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.discoverTimer !== undefined) clearInterval(this.discoverTimer)
    this.discoverTimer = undefined
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    for (const socket of this.sockets.values()) socket.close()
    this.sockets.clear()
    this.turns.clear()
  }

  /** 窗口回到前台：攒着的新回复已经看得见了。 */
  markSeen(): void {
    if (this.unread === 0) return
    this.unread = 0
    this.emit()
  }

  /** 托盘状态由在跑的轮次现算：会话 → 这一轮还在发言的 agent 名。 */
  private emit(): void {
    const busy = new Map<string, ReadonlySet<string>>()
    for (const [conversationId, byTurn] of this.turns) {
      const names = new Set<string>()
      for (const turn of byTurn.values()) {
        for (const speaker of turn.pending.values()) names.add(speaker.name)
      }
      if (names.size > 0) busy.set(conversationId, names)
    }
    this.options.onState({ busy, unread: this.unread })
  }

  /** 取出（必要时新建）一条轮次。 */
  private turn(conversationId: string, key: TurnKey): ConversationTurn {
    let byTurn = this.turns.get(conversationId)
    if (byTurn === undefined) {
      byTurn = new Map<TurnKey, ConversationTurn>()
      this.turns.set(conversationId, byTurn)
    }
    let turn = byTurn.get(key)
    if (turn === undefined) {
      turn = { pending: new Map(), spoken: [] }
      byTurn.set(key, turn)
    }
    return turn
  }

  /** 拿 senderId 反查它正在说的轮次（text-delta 与工具事件不带 turnIndex）。 */
  private turnOf(conversationId: string, senderId: string): ConversationTurn | undefined {
    for (const turn of this.turns.get(conversationId)?.values() ?? []) {
      if (turn.pending.has(senderId)) return turn
    }
    return undefined
  }

  /** 这个会话唯一在跑的轮次（含占位轮次）：工具事件与收口兜底都用它。 */
  private soleTurn(conversationId: string): ConversationTurn | undefined {
    const byTurn = this.turns.get(conversationId)
    if (byTurn === undefined || byTurn.size !== 1) return undefined
    return [...byTurn.values()][0]
  }

  /**
   * 按 turnIndex 找一条轮次；找不到就退到「这个会话唯一在跑的那条」。
   *
   * 退这一步是为了中途才连上 WS 的场景：漏掉的 message-start 让轮次记在占位键下，
   * 而 message-done 带的是真实 turnIndex。收口必须认，否则托盘永远停在「正在回复」。
   */
  private findTurn(conversationId: string, turnIndex: number): [TurnKey, ConversationTurn] | undefined {
    const byTurn = this.turns.get(conversationId)
    if (byTurn === undefined) return undefined
    const exact = byTurn.get(turnIndex)
    if (exact !== undefined) return [turnIndex, exact]
    if (byTurn.size !== 1) return undefined
    return [...byTurn.entries()][0]
  }

  /** 把某条轮次从在场状态里摘掉（摘完顺手清掉空会话）。 */
  private discardTurn(conversationId: string, key: TurnKey): void {
    const byTurn = this.turns.get(conversationId)
    if (byTurn === undefined) return
    byTurn.delete(key)
    if (byTurn.size === 0) this.turns.delete(conversationId)
  }

  /**
   * 丢掉这个会话里所有不是 key 的轮次：新一轮已经开跑，旧的那些就是残留。
   *
   * 依据是后端在同一会话内串行执行轮次（apps/server/src/app.ts 的 turnChains），
   * 所以两个轮次不会同时在跑。真撞上并行轮次时，表现是少记一个 agent 的正文，
   * 而不是托盘永远灭不了。
   */
  private supersedeTurns(conversationId: string, key: TurnKey): void {
    const byTurn = this.turns.get(conversationId)
    if (byTurn === undefined) return
    for (const other of [...byTurn.keys()]) {
      if (other !== key) byTurn.delete(other)
    }
  }

  private async discover(): Promise<void> {
    if (this.stopped) return
    try {
      const response = await fetch(`${this.options.baseUrl}/api/conversations`, {
        headers: this.options.token === undefined ? {} : { authorization: `Bearer ${this.options.token}` },
      })
      if (!response.ok) return
      const body = (await response.json()) as { conversations?: { id?: unknown; muted?: unknown }[] }
      // 静音集合顺手在这轮扫描里更新：会话列表本来就每 5 秒拉一次，通知路径
      // 不必为了知道"这个会话静没静音"再单独打一次后端。
      this.muted.clear()
      for (const conversation of body.conversations ?? []) {
        if (typeof conversation.id !== 'string') continue
        if (conversation.muted === true) this.muted.add(conversation.id)
        if (this.sockets.has(conversation.id)) continue
        this.subscribe(conversation.id)
      }
    } catch {
      // 后端还没起来或刚重启：下一轮扫描再说，不打扰用户。
    }
  }

  private subscribe(conversationId: string): void {
    const url = websocketUrl(this.options.baseUrl, conversationId, this.options.token)
    const socket: MinimalSocket | WebSocket = this.options.createSocket?.(url) ?? new WebSocket(url)
    this.sockets.set(conversationId, socket)
    socket.onmessage = (event: { data: unknown }) => {
      this.onEvent(conversationId, event.data)
    }
    socket.onclose = () => {
      this.sockets.delete(conversationId)
      // 断线那一段的事件整段丢了，残缺的轮次记账不能再当真：清掉，重连后由新到达的
      // 事件重新点亮托盘。否则丢一条 message-done 就会让托盘永远停在「正在回复」。
      this.turns.delete(conversationId)
      if (this.stopped) return
      const attempt = this.attempts.get(conversationId) ?? 0
      this.attempts.set(conversationId, attempt + 1)
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 10000
      const timer = setTimeout(() => {
        this.retries.delete(conversationId)
        this.subscribe(conversationId)
      }, delay)
      this.retries.set(conversationId, timer)
    }
  }

  /**
   * 九种 WS 事件逐个按语义处理：一个都不落 default——服务端新增事件类型而这里
   * 没跟上时，下面末尾的 never 校验会直接编译不过，而不是等真机上少一条通知。
   */
  private onEvent(conversationId: string, raw: unknown): void {
    const event = parsePresenceEvent(raw)
    if (event === undefined) return
    switch (event.type) {
      case 'message-start': {
        // 用户自己发消息也会先来一条 message-start，那不是「有人在忙」。
        if (event.senderId === 'user') return
        // 一个会话里的轮次是串行的：真来了新一轮，上一轮的残留记账（丢掉过
        // message-done 的那一轮）就该丢掉，否则托盘会永远停在「正在回复」。
        this.supersedeTurns(conversationId, event.turnIndex)
        const turn = this.turn(conversationId, event.turnIndex)
        const speaker = turn.pending.get(event.senderId)
        // 派工/工具事件已经把它记成「在场但未开口」时，这里补上真名，已经攒的正文留住。
        if (speaker === undefined) {
          turn.pending.set(event.senderId, { started: true, name: event.senderName, text: '' })
        } else {
          speaker.started = true
          speaker.name = event.senderName
        }
        this.emit()
        break
      }
      case 'text-delta': {
        // 后台窗口看不到流式正文，所以增量只进草稿、不推状态。契约里 text-delta
        // 不带 turnIndex：先按 senderId 反查它在说的轮次，再退到本会话正在跑的那条，
        // 都查不到（中途才连上 WS，漏掉了 message-start）才记到占位轮次上。
        const turn =
          this.turnOf(conversationId, event.senderId) ??
          this.soleTurn(conversationId) ??
          this.turn(conversationId, UNKNOWN_TURN)
        const speaker = turn.pending.get(event.senderId)
        if (speaker === undefined) {
          turn.pending.set(event.senderId, { started: false, name: event.senderId, text: event.text })
          // 新开了一条轮次（中途接上的那一轮）：托盘该亮起来，这不是流式增量。
          this.emit()
        } else {
          speaker.text += event.text
        }
        break
      }
      case 'dispatch': {
        // 派工：接手的 agent 还没开口，但这一轮已经在跑，托盘先亮起来。
        const turn = this.turn(conversationId, event.turnIndex)
        if (!turn.pending.has(event.toAgent)) {
          turn.pending.set(event.toAgent, { started: false, name: event.toAgent, text: '' })
          this.emit()
        }
        break
      }
      case 'tool-call-start':
      case 'tool-result':
      case 'produce-card': {
        // 工具事件说明这个 agent 正在干活，只是契约里不带 turnIndex。只在本会话
        // 已经有一条轮次在跑时补记名：凭空造一轮的话，等不到它的 message-done，
        // 托盘就会一直亮着。
        if (this.turnOf(conversationId, event.senderId) !== undefined) break
        const turn = this.soleTurn(conversationId)
        if (turn === undefined) break
        turn.pending.set(event.senderId, { started: false, name: event.senderId, text: '' })
        this.emit()
        break
      }
      case 'message-done': {
        // 先按 turnIndex 精确找，找不到再退到「这个会话唯一在跑的那条轮次」：
        // 主进程中途才连上 WS 时，轮次记在占位键下，而这条 done 带的是真实序号。
        const found = this.findTurn(conversationId, event.turnIndex)
        if (found === undefined) break
        const [key, turn] = found
        const speaker = turn.pending.get(event.senderId)
        if (speaker === undefined) break
        // 这一位说完了：正文留进整轮发言表，等最后一位说完时一起进那一条通知。
        turn.pending.delete(event.senderId)
        turn.spoken.push(speaker)
        // 只见到派工/工具事件的「在场」不占收口条件：它们没开口，不会再发 done。
        for (const [senderId, each] of turn.pending) {
          if (!each.started) turn.pending.delete(senderId)
        }
        if (turn.pending.size > 0) {
          // 群里这一轮还有 agent 在说：托盘继续亮，不通知、不计未读。
          this.emit()
          break
        }
        this.closeTurn(conversationId, key, turn)
        break
      }
      case 'error': {
        // 错误终止整条轮次：这一轮不会再有 message-done 过来。
        this.turns.delete(conversationId)
        this.emit()
        // 主动「已停止」不是故障，不该弹通知。
        if (event.code === 'ABORTED' || !this.shouldNotify(conversationId)) break
        this.unread += 1
        this.emit()
        this.options.onReply({ agentName: 'RyHarness', text: event.message, conversationId })
        break
      }
      case 'queued':
        // 用户消息在排队：真正在跑的那一轮已经把托盘点亮了，排队本身不是「有人在忙」。
        break
      case 'approval-request':
      case 'approval-resolved':
        // 工具审批卡由渲染层处理：这一轮仍在跑（等用户点头），托盘灯不灭也不叠未读。
        break
      default: {
        const unhandled: never = event
        throw new Error(`[ryharness] 未处理的在场事件：${JSON.stringify(unhandled)}`)
      }
    }
  }

  /**
   * 收口一条轮次：托盘灭灯；窗口不在前台时按「一轮一条」弹通知、累计一条未读。
   *
   * 群聊一轮由好几位 agent 各说一段，收口只发生在最后一位说完时——所以通知抬头与
   * 正文取的是整轮攒下的发言（turn.spoken），不是某一个人的。
   */
  /**
   * 这一轮该不该弹系统通知。
   *
   * 三道闸：全局免打扰 → 窗口在前台 → 会话被静音。
   *
   * 静音的约定是"不弹未读"（渲染层 api.ts 的 muted 契约：静音 = 不弹未读），
   * 所以静音的会话连未读都不累计——它在列表里已经以"已静音"角标明示过了，
   * 系统通知再来一次就是违约而不是提醒。静音集合由每 5 秒一次的会话列表扫描
   * 顺带刷新（见 discover），通知路径不必为它单独打一次后端。
   */
  private shouldNotify(conversationId: string): boolean {
    if (this.options.isDnd?.() === true) return false
    if (this.options.isFocused()) return false
    if (this.muted.has(conversationId)) return false
    return true
  }

  private closeTurn(conversationId: string, key: TurnKey, turn: ConversationTurn): void {
    this.discardTurn(conversationId, key)
    this.emit()
    if (!this.shouldNotify(conversationId)) return
    this.unread += 1
    this.emit()
    const names = [...new Set(turn.spoken.map((each) => each.name))]
    const body = turn.spoken
      .map((each) => each.text.trim())
      .filter((text) => text.length > 0)
      .join('\n')
    this.options.onReply({
      agentName: names.join('、'),
      text: body.length > 0 ? body : '这一轮没有文字',
      conversationId,
    })
  }
}

/**
 * 托盘「新对话」：把窗口带回欢迎页，让用户自己选跟 Ryen 聊还是开个小队。
 *
 * 此前这段脚本替用户做了决定——切通讯录、点 Ryen 的「发消息」，于是「开个小队」
 * 从托盘出发这条路根本不存在，文案里说的「一起商量」只在首屏成立。渲染层现在
 * 监听 NEW_CHAT_EVENT 把自己切回无选中会话的欢迎页，上面就是去向二选一。
 *
 * 主进程仍然不持有渲染层状态（preload 桥里没有「新会话」动作），复用/创建/选中
 * 全程由渲染层完成；这里只派发事件。会话是否复用由页面决定。
 */
function startNewChat(): void {
  showMainWindow()
  const win = mainWindow
  if (win === undefined || win.isDestroyed()) return
  void win.webContents.executeJavaScript(NEW_CHAT_SCRIPT).catch((error: unknown) => {
    console.error('[renderer] failed to start a new chat:', error)
  })
}

/**
 * 在渲染层里执行的「新对话」脚本：反复派发事件直到欢迎页真的在屏上。
 *
 * React 可能还没挂上监听（窗口刚恢复、executeJavaScript 抢跑），所以派发要重试；
 * 判据用「欢迎页是否已渲染」这个 DOM 事实，而不是发完就算成功。
 */
export const NEW_CHAT_SCRIPT = `(() => {
  let tries = 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      tries += 1;
      window.dispatchEvent(new CustomEvent(${JSON.stringify(NEW_CHAT_EVENT)}));
      const landed = document.querySelector('.welcome') !== null;
      if (landed || tries >= 20) {
        clearInterval(timer);
        resolve(landed);
      }
    }, 150);
  });
})()`

/**
 * 通知点击后在渲染层执行的「落到这条会话」脚本：反复派发事件直到渲染层真的选中它。
 *
 * 与 NEW_CHAT_SCRIPT 同一套重试（React 可能还没挂上监听：冷启动时通知点击先于
 * 渲染层加载完）。落地判据不能是「目标行高亮」——列表是虚拟化的，目标行可能
 * 不在窗口里；也不能是 .chat-view（欢迎页包在同一个类里）。渲染层处理完事件
 * 会把 data-ryharness-open-conversation 盖成目标 id（见 App.tsx），拿它对账。
 */
export function openConversationScript(conversationId: string): string {
  const event = JSON.stringify(OPEN_CONVERSATION_EVENT)
  const id = JSON.stringify(conversationId)
  return `(() => {
    let tries = 0;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        tries += 1;
        window.dispatchEvent(new CustomEvent(${event}, { detail: ${id} }));
        const landed = document.documentElement.getAttribute('data-ryharness-open-conversation') === ${id};
        if (landed || tries >= 20) {
          clearInterval(timer);
          resolve(landed);
        }
      }, 150);
    });
  })()`
}

/** 演示会话需要的存储能力（SessionStore 的一个子集，测试可换替身）。 */
export interface DemoSeedStore {
  listAgents(): { id: string; name: string; isBuiltin: boolean }[]
  listConversations(limit?: number): { id: string }[]
  createConversation(input: { kind: 'group'; title: string; memberAgentIds: string[]; dispatcherAgentId?: string }): {
    id: string
  }
  appendMessage(input: {
    conversationId: string
    senderType: 'user' | 'agent' | 'system'
    senderId?: string
    contentBlocks: { type: string; text?: string }[]
    mentions?: string[]
    turnIndex?: number
  }): unknown
  recordDispatchEvent(input: {
    conversationId: string
    fromAgent?: string
    toAgent: string
    reason: string
    turnIndex: number
  }): unknown
}

/** 首启演示会话的落种结果。 */
export interface DemoSeedResult {
  /** 新建的示例会话 id；没种时为 undefined。 */
  conversationId?: string
  /** 演示小队成员 id（按总管 → 干活 → 记事排序）。 */
  memberIds: string[]
}

/**
 * 种一条已经发生过的接力演示会话：用户提一个工作任务，总管派工，助理交付文件，
 * 总管收口并记下后续。
 *
 * 场景必须是「干活」而不是「过日子」：RyHarness 是干活用的 agent，示例要一眼展示
 * 核心能力——派工、文件交付、长期记忆、主动提醒；聚餐订座那类生活场景让用户
 * 误以为这是个聊天玩具。
 *
 * 走 store 而不是 POST /messages：后者会真的跑一轮模型（没有 key 就报错气泡，
 * 有 key 就花钱）。演示要的是「社交隐喻当天成立」，不是「再烧一次 token」。
 * 判定条件是「一条会话都没有」：用户自己开过口的库不该被示例插队。
 */
export function seedFirstLaunchDemo(store: DemoSeedStore): DemoSeedResult {
  if (store.listConversations(1).length > 0) return { memberIds: [] }
  const roster = store
    .listAgents()
    .filter((agent) => {
      return agent.isBuiltin
    })
    .slice(0, 3)
  if (roster.length < 3) return { memberIds: [] }
  const [ryen, worker, keeper] = roster
  const memberIds = roster.map((agent) => {
    return agent.id
  })
  const conversation = store.createConversation({
    kind: 'group',
    // 职位名直接取成员名（工程师 / 管家），只有 Ryen 是品牌名不是职能名，括号里补上
    // 「总管」：这是用户看到三位成员分工的第一处，只写「Ryen」等于什么都没说。
    title: `${DEMO_TITLE_PREFIX} · ${ryen.name}（总管）、${worker.name}、${keeper.name}一起做季度报告`,
    memberAgentIds: memberIds,
    dispatcherAgentId: ryen.id,
  })
  const say = (
    senderType: 'user' | 'agent' | 'system',
    senderId: string | undefined,
    text: string,
    mentions: string[] = [],
  ): void => {
    store.appendMessage({
      conversationId: conversation.id,
      senderType,
      ...(senderId === undefined ? {} : { senderId }),
      contentBlocks: [{ type: 'text', text }],
      mentions,
      turnIndex: 0,
    })
  }
  say(
    'system',
    undefined,
    `这是一条示例会话：产品自带的演示，接力已经发生过了，不是你自己的历史。看完可在首屏一键删掉。`,
  )
  say(
    'user',
    'user',
    `帮我做一份智能家居行业的季度分析报告，周五要给老板汇报。${worker.name}你拉数据写初稿，${keeper.name}你照我上次改过的模板把关格式。`,
    [keeper.id],
  )
  store.recordDispatchEvent({
    conversationId: conversation.id,
    fromAgent: ryen.id,
    toAgent: worker.id,
    reason: 'default-dispatcher',
    turnIndex: 0,
  })
  say(
    'agent',
    worker.id,
    `数据拉好了：Q3 市场规模 7157 亿，同比 +12.4%，增长最快的三个品类都配了图表；初稿写到结论段了。`,
  )
  store.recordDispatchEvent({
    conversationId: conversation.id,
    fromAgent: worker.id,
    toAgent: keeper.id,
    reason: `relay @${keeper.name}`,
    turnIndex: 0,
  })
  say(
    'agent',
    keeper.id,
    `照你上次改过的模板核过了：封面、数据来源标注都齐了；你偏好结论先行，我把核心发现提到了第一页。`,
  )
  say(
    'agent',
    ryen.id,
    `报告已经放进工作区（智能家居季度报告-v1.docx），结论先行、图表齐全。周五要汇报这件事我记进长期记忆了，周四傍晚我来提醒你过一遍。`,
  )
  return { conversationId: conversation.id, memberIds }
}

/**
 * 首启落种一次，之后靠标记文件记住：示例被用户删掉时表也就空了，
 * 只看「表空没空」会在下次启动把它又种回来。
 */
function seedFirstLaunchOnce(server: RyHarnessServer): void {
  const marker = join(server.dataDir, FIRST_LAUNCH_MARKER)
  if (existsSync(marker)) return
  try {
    const result = seedFirstLaunchDemo(server.store)
    console.log(`[ryharness] first launch seed: ${result.conversationId ?? 'skipped'}`)
  } catch (error) {
    console.error('[ryharness] first launch seed failed:', error)
  } finally {
    try {
      writeFileSync(marker, new Date().toISOString())
    } catch (error) {
      console.error('[ryharness] failed to write first launch marker:', error)
    }
  }
}

/** 常驻能力：托盘 + 在场监听 + 通知。 */
function startResidency(baseUrl: string, token: string | undefined): void {
  createTray()
  // 窗口已经开着且在前台时，不能从「未聚焦」起步，否则第一条回复会对着用户弹通知。
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) windowFocused = mainWindow.isFocused()
  presence = new PresenceMonitor({
    baseUrl,
    token,
    isFocused: () => {
      return windowFocused
    },
    isDnd: () => {
      return isDoNotDisturb()
    },
    onState: (state) => {
      updateTray(state)
    },
    onReply: (reply) => {
      notify(`${reply.agentName} 回复了`, reply.text, { conversationId: reply.conversationId })
    },
  })
  presence.start()
}

async function main(): Promise<void> {
  const isCapture = envValue(process.env, 'CAPTURE') === '1'
  // 单实例锁：第二个实例直接退出，由首实例聚焦已有窗口。
  // 截图模式（RYHARNESS_CAPTURE=1）是独立进程，不参与锁。
  if (!isCapture && !app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }

  await app.whenReady()
  bootTrace.mark('app-ready')
  // Windows 的系统通知按 AUMID 归属应用；不设的话任务栏/通知里显示的是 electron.app.Electron。
  app.setAppUserModelId('com.ryharness.desktop')
  // 凭据落盘用系统密钥库加密（必须在任何读写 api-keys.json 之前钉住）。
  // safeStorage 在 app ready 之后才保证可用；isEncryptionAvailable() 为假时
  // 交给 @ryharness/server 的明文降级路径，它会在日志里说明降级原因。
  configureSecretStore(
    safeStorage.isEncryptionAvailable()
      ? {
          id: 'safeStorage',
          seal: (plain) => {
            return safeStorage.encryptString(plain).toString('base64')
          },
          open: (sealed) => {
            return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
          },
        }
      : undefined,
  )
  // 本次启动的 API token：后端强制校验，渲染层与常驻监听都带着它。
  //
  // RYHARNESS_API_TOKEN 只给**自动化**用（release.yml 要在进程外访问 API，不能靠猜
  // 随机 token），而且只在 CI 或截图模式下生效（见 envTokenAllowed）。生产构建同样
  // 认这个环境变量的话，用户（或用户抄来的脚本、快捷方式、计划任务）设一个
  // RYHARNESS_API_TOKEN，本机任何进程都能拿 Bearer 直调本机 API——而这个 API 背后是
  // 带 shellExec 的 agent 工具链。每次启动随机 256 位 token 的防线被一个环境变量
  // 整个绕过，界面上还没有任何提示。
  const allowEnvToken = envTokenAllowed(process.env)
  apiToken = (allowEnvToken ? envValue(process.env, 'API_TOKEN') : undefined) ?? generateApiToken()
  loadDotEnvIntoProcess()
  /**
   * 数据目录与工作区根目录在这里定一次：后端与 IPC 的路径闸必须用**同一个**根，
   * 各算各的就会出现「后端放行、主进程拦下」这种用户看不懂的失败。
   */
  const dataDir = envValue(process.env, 'DATA_DIR') ?? join(app.getPath('userData'), 'ryharness-data')
  /**
   * 改名那天的数据迁移：老数据在 `%APPDATA%\RyAgent\ryagent-data`，新位置是
   * `%APPDATA%\RyHarness\ryharness-data`。不迁的话用户升级后打开应用会发现会话、
   * 长期记忆、助理配置全没了——数据还在老目录里，只是没人去读。
   *
   * 只在**新目录不存在**时迁；用户自己指定了 RYHARNESS_DATA_DIR 的话更不迁
   * （那是他自己挑的地方）。
   */
  if (envValue(process.env, 'DATA_DIR') === undefined) {
    const legacyDataDir = join(app.getPath('appData'), 'RyAgent', 'ryagent-data')
    const migration = migrateLegacyDataDir({
      dataDir,
      legacyDataDir,
      exists: existsSync,
      move: (from, to) => {
        renameSync(from, to)
      },
      fileExists: existsSync,
      rename: (from, to) => {
        renameSync(from, to)
      },
    })
    if (migration.migrated) {
      console.log(`[ryharness] 已把老版本的数据目录迁到 ${dataDir}`)
    } else if (migration.reason !== undefined && migration.reason.startsWith('move failed')) {
      console.warn(`[ryharness] 老数据目录迁移失败（${migration.reason}）：${legacyDataDir}`)
    }
  }
  const workspaceRoot = join(dataDir, 'workspace')
  registerIpcHandlers(workspaceRoot)
  registerPermissionPolicy()
  applyAppMenu()

  const devServerUrl = envValue(process.env, 'DEV_SERVER_URL')
  // 渲染层资源服务：与后端无关，先就绪，窗口才能立刻开始加载。
  let assets: RendererAssets | undefined
  if (devServerUrl === undefined || devServerUrl.length === 0) {
    // 与后端同一套端口策略：固定端口优先（跨启动 origin 稳定，HTTP 与 V8 缓存
    // 不归零）；被占用时回退随机，实际地址由 assets.url 带出，调用方不必关心。
    const assetChoice = await resolveBackendPort({ port: DEFAULT_ASSETS_PORT, host: BACKEND_HOST })
    if (assetChoice.fallback === true) {
      console.warn(`[ryharness] ${assetChoice.reason ?? '端口被占用'}，资源服务回退随机端口`)
    }
    assets = await RendererAssets.start(join(here, '../renderer/dist'), { port: assetChoice.port })
    if (assets.fellBack) console.warn(`[ryharness] 资源服务端口 ${DEFAULT_ASSETS_PORT} 起不来，已回退 ${assets.port}`)
  }
  bootTrace.mark('assets-ready')
  const startServer = async (): Promise<RyHarnessServer> => {
    // 固定端口优先（跨启动 origin 稳定，HTTP 与 V8 缓存不归零）；被占用时回退随机，
    // 实际地址由 readyServer.url 推给渲染层，调用方不必关心用的是哪个端口。
    const choice = await resolveBackendPort({ port: backendPortFromEnv(), host: BACKEND_HOST })
    if (choice.fallback === true) console.warn(`[ryharness] ${choice.reason ?? '端口被占用'}，回退随机端口`)
    return RyHarnessServer.create({
      port: choice.port,
      host: BACKEND_HOST,
      dataDir,
      authToken: apiToken,
    })
  }

  if (isCapture) {
    // 截图用可见窗口：隐藏/offscreen 窗口的 capturePage 会挂起不返回。
    // 演示数据要写进 store，所以截图模式仍先起 server 再建窗。
    // here 是打包产物目录（main/），capture.png 写到应用根目录便于查找。
    const server = await startServer()
    bootTrace.mark('backend-ready')
    const captureUrl =
      assets !== undefined
        ? `${assets.url}${RENDERER_MOUNT}?api=${encodeURIComponent(server.url)}&token=${encodeURIComponent(apiToken ?? '')}`
        : `${devServerUrl}?api=${encodeURIComponent(server.url)}&token=${encodeURIComponent(apiToken ?? '')}`
    await runCapture(server, join(here, '..'), async () => {
      const win = createWindow(captureUrl)
      await whenLoaded(win)
      return win
    })
    app.exit(0)
    return
  }

  // 窗口先行：server 在后台启动，渲染层先出骨架，就绪后再喂数据。
  // 两种模式都不把 api 写进 URL（窗口加载时后端可能还没起来），统一走 pushApiBase。
  pageUrl = assets !== undefined ? `${assets.url}${RENDERER_MOUNT}` : `${devServerUrl ?? ''}`
  mainWindow = createWindow(pageUrl)
  let readyServer: RyHarnessServer
  try {
    readyServer = await startServer()
  } catch (error) {
    dialog.showErrorBox('RyHarness 启动失败', error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  bootTrace.mark('backend-ready')
  // 首启落种（小队成员 + 接力演示会话）必须在 API 地址推给渲染层之前：
  // 渲染层一拿到地址就会拉会话列表，晚一步这轮首屏就没有演示可看。
  seedFirstLaunchOnce(readyServer)
  // 后端就绪：API 地址推给渲染层（窗口可能还在加载；渲染层另有全局变量兜底，
  // 事件早于监听注册也不会丢）。
  pushApiBase(mainWindow, readyServer.url, apiToken)
  // 常驻：托盘 + 在场监听 + 失焦通知 + 关窗收进托盘。
  startResidency(readyServer.url, apiToken)

  app.on('second-instance', () => {
    // 第二实例已退出，这里把首实例窗口拉到前台。
    showMainWindow()
  })
  app.on('activate', () => {
    // macOS 点击 Dock 图标：复用已有 server 实例，只在窗口全关时重建窗口。
    if (BrowserWindow.getAllWindows().length === 0) {
      pushApiBase(showMainWindowAndReturn(), readyServer.url, apiToken)
    } else {
      showMainWindow()
    }
  })
  app.on('window-all-closed', () => {
    // 托盘在时不算「该退了」：关窗只是把窗口收起来。
    if (process.platform !== 'darwin' && tray === undefined) app.quit()
  })
  app.on('before-quit', (event) => {
    // 等 server 真正关闭（flush 落盘）后再退出，避免直接 app.quit() 丢数据。
    if (quitting) return
    quitting = true
    presence?.stop()
    tray?.destroy()
    tray = undefined
    event.preventDefault()
    void readyServer
      .close()
      .catch(() => {})
      .then(() => {
        return assets?.close()
      })
      .finally(() => {
        app.exit(0)
      })
  })
}

/** showMainWindow 的窗口句柄版：macOS 全关后重建窗口时要拿回新句柄推 API 地址。 */
function showMainWindowAndReturn(): BrowserWindow {
  showMainWindow()
  return mainWindow as BrowserWindow
}

// 测试 import 本模块只为拿纯函数与种子：自动启动会抢端口、挂定时器。
if (process.env.VITEST === undefined) void main()
