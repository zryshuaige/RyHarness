/**
 * Electron 主进程：内嵌启动 @ryagent/server（固定端口，被占用时回退随机），创建窗口。
 * 开发模式加载 Vite dev server（RYAGENT_DEV_SERVER_URL），生产模式由主进程
 * 自己的回环 HTTP server 伺服渲染层构建产物（同源加载、并行分片、可缓存）。
 *
 * 启动顺序：**窗口先行**——whenReady 立刻建窗并开始加载渲染层（先显示骨架），
 * @ryagent/server（WAL 恢复/迁移，慢盘 50–200ms+）并行启动，就绪后把 API 地址
 * 推给渲染层。菜单栏 autoHide（macOS 保留应用菜单）。
 *
 * 常驻：主进程自己订阅后端 WS（Node 22+ 内置 WebSocket）跟踪每个会话的进行中
 * 状态——托盘 tooltip 跟着变，生成完成且窗口不在前台时弹系统通知。关窗收进托盘，
 * 退出只认托盘菜单与 app 菜单，用户不会因为误关窗口丢掉正在跑的活。
 *
 * 产品名与版本不在代码里写死：一律经 readAppMeta() 从应用自己的 package.json 读，
 * 因此开发运行（`electron .`）与安装版显示的是同一个名字和版本号。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RyAgentServer } from '@ryagent/server'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  screen,
  shell,
  Tray,
} from 'electron'
import { runCapture } from './capture.ts'
import { RENDERER_MOUNT, RendererAssets } from './renderer-assets.ts'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 应用图标：窗口标题栏、任务栏与托盘共用这一个路径。
 *
 * 位图是矢量母版 assets/brand/icon.svg（几何橘猫，全应用只有这一只）的导出物，
 * 由 `pnpm gen:icon` 生成；改品牌请改 assets/brand/ 再重新导出，不要在这里换图。
 */
const APP_ICON = join(here, '../assets/icon-256.png')

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
 * 为什么先探再起：`RyAgentServer.create` 内部的 `http.listen` 没有挂 error 监听，
 * 端口被占时不会 reject，而是变成主进程的未捕获异常（应用直接闪退）。开发态同时
 * 跑着另一个实例、或用户机器上正好有别的程序占着 32100 都很常见，所以这里先探。
 * probe 可注入，测试不需要真的占一个端口。
 */
export async function resolveBackendPort(options: {
  port: number
  host: string
  probe?: (port: number, host: string) => Promise<boolean>
}): Promise<{ port: number; fallback: boolean; reason?: string }> {
  // 显式要求随机端口（RYAGENT_PORT=0，测试与多开场景）时不必探测。
  if (options.port === 0) return { port: 0, fallback: false }
  const probe = options.probe ?? isPortAvailable
  if (await probe(options.port, options.host)) return { port: options.port, fallback: false }
  return { port: 0, fallback: true, reason: `端口 ${options.port} 已被占用` }
}

/** RYAGENT_PORT 解析：缺省或非法值退回默认固定端口；0 表示显式要求随机端口。 */
export function backendPortFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RYAGENT_PORT
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_BACKEND_PORT
  const port = Number(raw)
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : DEFAULT_BACKEND_PORT
}

// ---- 启动计时 ----

/** 一次启动里记录的一个阶段。 */
export interface BootPhase {
  stage: string
  /** 相对冷启动（进程 spawn）的毫秒数。 */
  sinceStartMs: number
  /** 与上一阶段的间隔毫秒；首个阶段为 0。 */
  deltaMs: number
}

/** 启动计时快照（可查询：主进程持有 + `ryagent:boot-trace` IPC + userData 日志）。 */
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
const RENDERER_BOOT_GLOBAL = '__RYAGENT_BOOT__'

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
    console.error('[ryagent] failed to write boot trace log:', error)
  }
}

/** 本次启动的计时器（模块级：main() 与 IPC handler 共用同一份）。 */
const bootTrace = new BootTrace()

/**
 * 启动时加载 .env（KEY=VALUE）。用 Node 自带的 process.loadEnvFile——引擎要求
 * ^22.19||>=24，自带实现语义明确（已存在的环境变量优先），不再手写解析器。
 * 候选路径按序查找：RYAGENT_ENV_FILE → userData/.env → 应用目录/.env →
 * 仓库根（dev 模式 ../../.env）→ cwd/.env。
 *
 * 由 main() 在 app.whenReady 之后调用（而不是模块顶层）：顶层执行会让测试
 * import 本模块时先摸一遍磁盘上的 .env。
 */
function loadDotEnvIntoProcess(): void {
  const candidates = [
    process.env.RYAGENT_ENV_FILE,
    join(app.getPath('userData'), '.env'),
    join(app.getAppPath(), '.env'),
    join(app.getAppPath(), '..', '..', '.env'),
    join(process.cwd(), '.env'),
  ].filter((p): p is string => {
    return typeof p === 'string' && p.length > 0
  })
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      process.loadEnvFile(candidate)
    } catch (error) {
      // 解析失败不应挡住启动：凭据缺失由 provider 状态灯与首启配置卡兜底。
      console.error(`[ryagent] failed to load env file ${candidate}:`, error)
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
      name: pkg.productName ?? pkg.name ?? 'RyAgent',
      version: pkg.version ?? app.getVersion(),
    }
  } catch {
    // 读不到就退回 Electron 自己的取值：关于框只是信息展示，不该把启动带崩。
    return { name: 'RyAgent', version: app.getVersion() }
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
 * data-theme，preload 目前也没有回传通道（DesktopBridge 只有 appName/openPath），
 * 所以这里在窗口**获得焦点期间**低频读一次：切主题必然先跟窗口交互，窗口一失焦
 * 就停表，不在后台空转。等 preload 暴露 setTitleBarColor 之后，本函数即可整体删除。
 */
function followRendererTheme(window: BrowserWindow): void {
  if (IS_MAC) return
  let timer: ReturnType<typeof setInterval> | undefined
  const sync = (): void => {
    if (window.isDestroyed()) return
    void window.webContents
      .executeJavaScript("document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'")
      .then((theme: unknown) => {
        window.setTitleBarOverlay({
          ...TITLEBAR_OVERLAY[theme === 'dark' ? 'dark' : 'light'],
          height: TITLEBAR_H,
        })
      })
      .catch(() => {
        // 文档还没就绪时 executeJavaScript 会抛；下一轮再试。
      })
  }
  window.webContents.on('did-finish-load', sync)
  window.on('focus', () => {
    sync()
    timer ??= setInterval(sync, 400)
  })
  window.on('blur', () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  })
  window.once('closed', () => {
    if (timer === undefined) return
    clearInterval(timer)
  })
}

/**
 * 「打开工作区目录」的唯一通道：渲染层拿不到 Node 权限，只能经 preload 调到这里。
 * 目录来自本机后端（GET /api/workspace），不是网页传来的任意 URL，但仍做形状校验，
 * 免得渲染层被注入了非字符串就把 shell 叫歪。shell.openPath 成功返回空串。
 *
 * 注册放进 main()（而不是模块顶层）：顶层 ipcMain.handle 在测试里 import 本模块
 * 时会立刻打在一个不存在的 ipcMain 上。
 */
function registerIpcHandlers(): void {
  ipcMain.handle('ryagent:open-path', (_event, targetPath: unknown) => {
    if (typeof targetPath !== 'string' || targetPath.length === 0) return 'invalid path'
    return shell.openPath(targetPath)
  })
  // 启动计时的查询口：开发时从渲染层/控制台随时问「这次启动各阶段多久」，
  // 不依赖任何遥测服务（离线开发、CI、本机排障都能用）。
  ipcMain.handle('ryagent:boot-trace', () => {
    return bootTrace.snapshot()
  })
}

/**
 * 开窗尺寸与位置：设计稿按 1320×840，但 150% 缩放的小屏工作区可能只有 1100 DIP 宽，
 * 固定尺寸会让窗口超出屏幕、右侧内容被裁掉（内容按视口宽度布局，视口比屏幕宽）。
 * 这里按主显示器工作区收敛，并保证不小于 minWidth/minHeight。
 *
 * 注意：本机 1.5× 缩放下 Electron 的 workAreaSize 返回的是**物理像素**（1707），
 * 而窗口 bounds 是 DIP——两者混用会让自动居中把窗口放到屏幕外。所以先用
 * dipToScreenPoint 探测坐标单位再统一换算，位置也自己算，不依赖 Electron 居中。
 */
function fitToWorkArea(desired: { width: number; height: number }): {
  width: number
  height: number
  x: number
  y: number
} {
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const probe = screen.dipToScreenPoint({ x: 100, y: 100 })
  const unit = Math.abs(probe.x - 100) < 0.5 ? 1 : scale
  const work = {
    width: Math.round(display.workAreaSize.width / unit),
    height: Math.round(display.workAreaSize.height / unit),
  }
  const width = Math.min(desired.width, Math.max(MIN_WIDTH, work.width - 32))
  const height = Math.min(desired.height, Math.max(MIN_HEIGHT, work.height - 32))
  return {
    width,
    height,
    x: Math.max(0, Math.round((work.width - width) / 2)),
    y: Math.max(0, Math.round((work.height - height) / 4)),
  }
}

function createWindow(pageUrl: string): BrowserWindow {
  const fit = fitToWorkArea({ width: 1320, height: 840 })
  const window = new BrowserWindow({
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#FAF7F2',
    title: 'RyAgent',
    icon: APP_ICON,
    // 首帧画完再显示，避免加载期的白/空窗口闪烁（加载期的骨架由渲染层自己画）。
    show: false,
    // macOS 的交通灯留在系统内嵌位置（渲染层同样让出 40px 顶条，两端布局一致）；
    // Windows/Linux 用 Window Controls Overlay，窗口按钮浮在页面之上。
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    ...(IS_MAC ? {} : { titleBarOverlay: { ...TITLEBAR_OVERLAY.light, height: TITLEBAR_H } }),
    // Windows/Linux 默认收起菜单（Alt 唤出），macOS 保留常驻应用菜单。
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => {
    window.show()
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
 * 渲染层首屏阶段并进主进程时间轴（读 window.__RYAGENT_BOOT__，不经 preload）。
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
    console.error('[ryagent] failed to collect renderer boot phases:', error)
  }
  console.log(`[ryagent] ${bootTrace.summary()}`)
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

/** 后端就绪后把 API 地址推给渲染层（contextIsolation 下不用 preload 注入）。
 *  页面还在加载时先等 did-finish-load——否则脚本会落在旧的 about:blank 文档上。
 *  推的是**实际绑定到的**地址（端口回退随机时与配置的固定端口不同）。 */
function pushApiBase(window: BrowserWindow, apiBase: string): void {
  const payload = JSON.stringify(apiBase)
  const script =
    `window.__RYAGENT_API_BASE__=${payload};` +
    `window.dispatchEvent(new CustomEvent('ryagent:api-base',{detail:${payload}}));`
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
/** 内置总管的名字：托盘「新对话」据此在通讯录里找到它。 */
const RYEN_NAME = 'Ryen'
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

/** 系统通知；点通知即回到主窗口。 */
function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title,
    body: body.length > NOTIFY_BODY_LIMIT ? `${body.slice(0, NOTIFY_BODY_LIMIT)}…` : body,
  })
  notification.on('click', () => {
    showMainWindow()
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

/** 托盘菜单：打开主窗口 / 新对话 / 开机自启 / 退出，四项都有真实行为。 */
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
  const image = nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 })
  if (image.isEmpty()) {
    // 空图标在部分平台上会让 Tray 抛错，把整个主进程带下去；宁可不常驻。
    console.error(`[ryagent] tray icon missing: ${APP_ICON}`)
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
    const names = [...new Set(state.busy.values())]
    const who = names.length === 1 ? names[0] : `${names.length} 位助理`
    return `${appName}：${who}正在回复…`
  }
  if (state.unread > 0) return `${appName}：${state.unread} 条新回复等你回来`
  return `${appName}：待命中，点开说点什么`
}

/** 在场状态快照。 */
export interface PresenceState {
  /** 会话 id → 正在回复的 agent 名。 */
  busy: Map<string, string>
  /** 窗口不在前台时攒下的新回复条数。 */
  unread: number
}

/** 主进程用到的最小 WS 形态（便于测试注入替身）。 */
export interface MinimalSocket {
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  close(): void
}

/** 在场监听所需的后端事件（只取驱动托盘/通知用得到的字段）。 */
interface PresenceEvent {
  type: string
  senderId: string
  senderName?: string
  text?: string
  message?: string
  code?: string
}

/** 会话列表多久扫一次（新会话建出来后自动纳入监听）。 */
const DISCOVER_INTERVAL_MS = 5000
/** WS 断线重连退避（ms）。 */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000]

/** 把 http(s) 基地址换成 WS 订阅地址。 */
export function websocketUrl(baseUrl: string, conversationId: string): string {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = ''
  url.searchParams.set('conversationId', conversationId)
  return url.toString()
}

/** 解析一条 WS 推送；形状不对就当没收到（主进程不该被脏数据带崩）。 */
function parsePresenceEvent(raw: unknown): PresenceEvent | undefined {
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const event = parsed as Record<string, unknown>
  // senderId 只有部分事件带（error 就没有），缺省按空串处理，别把整条丢掉。
  if (typeof event.type !== 'string') return undefined
  return {
    type: event.type,
    senderId: typeof event.senderId === 'string' ? event.senderId : '',
    ...(typeof event.senderName === 'string' ? { senderName: event.senderName } : {}),
    ...(typeof event.text === 'string' ? { text: event.text } : {}),
    ...(typeof event.message === 'string' ? { message: event.message } : {}),
    ...(typeof event.code === 'string' ? { code: event.code } : {}),
  }
}

/**
 * 在场监听：主进程自己连后端 WS，逐会话跟踪「谁在写」。
 *
 * 渲染层只订阅当前打开的那个会话，托盘与通知却要覆盖全部会话——所以这里在
 * 主进程另起一份订阅；后端是单进程事件总线，多一个订阅者不会多跑一次模型。
 */
export class PresenceMonitor {
  private readonly sockets = new Map<string, MinimalSocket | WebSocket>()
  private readonly busy = new Map<string, string>()
  private readonly drafts = new Map<string, string>()
  private readonly attempts = new Map<string, number>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  private discoverTimer: ReturnType<typeof setInterval> | undefined
  private unread = 0
  private stopped = false

  constructor(
    private readonly options: {
      baseUrl: string
      onState: (state: PresenceState) => void
      onReply: (reply: { agentName: string; text: string }) => void
      isFocused: () => boolean
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
  }

  /** 窗口回到前台：攒着的新回复已经看得见了。 */
  markSeen(): void {
    if (this.unread === 0) return
    this.unread = 0
    this.emit()
  }

  private emit(): void {
    this.options.onState({ busy: new Map(this.busy), unread: this.unread })
  }

  private async discover(): Promise<void> {
    if (this.stopped) return
    try {
      const response = await fetch(`${this.options.baseUrl}/api/conversations`)
      if (!response.ok) return
      const body = (await response.json()) as { conversations?: { id?: unknown }[] }
      for (const conversation of body.conversations ?? []) {
        if (typeof conversation.id !== 'string' || this.sockets.has(conversation.id)) continue
        this.subscribe(conversation.id)
      }
    } catch {
      // 后端还没起来或刚重启：下一轮扫描再说，不打扰用户。
    }
  }

  private subscribe(conversationId: string): void {
    const url = websocketUrl(this.options.baseUrl, conversationId)
    const socket: MinimalSocket | WebSocket = this.options.createSocket?.(url) ?? new WebSocket(url)
    this.sockets.set(conversationId, socket)
    socket.onmessage = (event: { data: unknown }) => {
      this.onEvent(conversationId, event.data)
    }
    socket.onclose = () => {
      this.sockets.delete(conversationId)
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

  private onEvent(conversationId: string, raw: unknown): void {
    const event = parsePresenceEvent(raw)
    if (event === undefined) return
    switch (event.type) {
      case 'message-start': {
        // 用户自己发消息也会先来一条 message-start，那不是「有人在忙」。
        if (event.senderId === 'user') return
        this.busy.set(conversationId, event.senderName ?? event.senderId)
        this.drafts.set(conversationId, '')
        this.emit()
        break
      }
      case 'text-delta':
        this.drafts.set(conversationId, `${this.drafts.get(conversationId) ?? ''}${event.text ?? ''}`)
        break
      case 'message-done': {
        const agentName = this.busy.get(conversationId) ?? event.senderId
        const text = (this.drafts.get(conversationId) ?? '').trim()
        this.busy.delete(conversationId)
        this.drafts.delete(conversationId)
        if (this.options.isFocused()) {
          this.emit()
          break
        }
        this.unread += 1
        this.emit()
        this.options.onReply({ agentName, text: text.length > 0 ? text : '这一轮没有文字' })
        break
      }
      case 'error': {
        this.busy.delete(conversationId)
        this.drafts.delete(conversationId)
        this.emit()
        // 主动「已停止」不是故障，不该弹通知。
        if (event.code === 'ABORTED' || this.options.isFocused()) break
        this.unread += 1
        this.emit()
        this.options.onReply({ agentName: 'RyAgent', text: event.message ?? '出了点问题' })
        break
      }
      default:
        break
    }
  }
}

/**
 * 托盘「新对话」：切到通讯录，点 Ryen 的「发消息」，走应用自己的开聊流程。
 *
 * 主进程没有渲染层状态句柄（preload 桥里没有「新会话」这个动作），与其在主
 * 进程另建一条建会话的通道、再想办法让渲染层选中它，不如驱动 UI 走它自己的
 * 路径：会话的复用、创建与选中全由渲染层完成，只有入口由托盘发起。
 */
function startNewChat(): void {
  showMainWindow()
  const win = mainWindow
  if (win === undefined || win.isDestroyed()) return
  void win.webContents.executeJavaScript(NEW_CHAT_SCRIPT).catch((error: unknown) => {
    console.error('[renderer] failed to start a new chat:', error)
  })
}

/** 在渲染层里执行的「新对话」脚本：等通讯录渲染出来再点（切页是 React 异步更新）。 */
export const NEW_CHAT_SCRIPT = `(() => {
  const tab = [...document.querySelectorAll('.rail-tab')].find((node) => {
    return (node.textContent ?? '').trim().startsWith('通讯录');
  });
  tab?.click();
  return new Promise((resolve) => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const card = [...document.querySelectorAll('.contact-card')].find((node) => {
        return (node.querySelector('h3')?.textContent ?? '').trim().startsWith(${JSON.stringify(RYEN_NAME)});
      });
      const button = [...(card?.querySelectorAll('button') ?? [])].find((node) => {
        return (node.textContent ?? '').trim() === '发消息';
      });
      if (button !== undefined) {
        clearInterval(timer);
        button.click();
        resolve(true);
        return;
      }
      if (tries >= 20) {
        clearInterval(timer);
        resolve(false);
      }
    }, 150);
  });
})()`

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
 * 种一条已经发生过的接力演示会话：用户发一句话，总管派工，助理转交，总管收口。
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
    title: `${DEMO_TITLE_PREFIX} · ${ryen.name}、${worker.name}、${keeper.name}一起定晚饭`,
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
  say('user', 'user', `我们三个定下周去哪吃？${worker.name}你查查还没去过的，${keeper.name}你记得我的忌口。`, [
    keeper.id,
  ])
  store.recordDispatchEvent({
    conversationId: conversation.id,
    fromAgent: ryen.id,
    toAgent: worker.id,
    reason: 'default-dispatcher',
    turnIndex: 0,
  })
  say('agent', worker.id, `翻完「吃过的店」清单，排掉上个月去过的三家，还剩巷口那家意面和河对岸的川菜。`)
  store.recordDispatchEvent({
    conversationId: conversation.id,
    fromAgent: worker.id,
    toAgent: keeper.id,
    reason: `relay @${keeper.name}`,
    turnIndex: 0,
  })
  say('agent', keeper.id, `你的忌口我记得：不吃香菜，微辣以上会皱眉头。巷口那家可以少辣。`)
  say('agent', ryen.id, `那就定周三晚，巷口那家意面、少辣。我记进长期记忆了，下次你不用再提醒。`)
  return { conversationId: conversation.id, memberIds }
}

/**
 * 首启落种一次，之后靠标记文件记住：示例被用户删掉时表也就空了，
 * 只看「表空没空」会在下次启动把它又种回来。
 */
function seedFirstLaunchOnce(server: RyAgentServer): void {
  const marker = join(server.dataDir, FIRST_LAUNCH_MARKER)
  if (existsSync(marker)) return
  try {
    const result = seedFirstLaunchDemo(server.store)
    console.log(`[ryagent] first launch seed: ${result.conversationId ?? 'skipped'}`)
  } catch (error) {
    console.error('[ryagent] first launch seed failed:', error)
  } finally {
    try {
      writeFileSync(marker, new Date().toISOString())
    } catch (error) {
      console.error('[ryagent] failed to write first launch marker:', error)
    }
  }
}

/** 常驻能力：托盘 + 在场监听 + 通知。 */
function startResidency(baseUrl: string): void {
  createTray()
  // 窗口已经开着且在前台时，不能从「未聚焦」起步，否则第一条回复会对着用户弹通知。
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) windowFocused = mainWindow.isFocused()
  presence = new PresenceMonitor({
    baseUrl,
    isFocused: () => {
      return windowFocused
    },
    onState: (state) => {
      updateTray(state)
    },
    onReply: (reply) => {
      notify(`${reply.agentName} 回复了`, reply.text)
    },
  })
  presence.start()
}

async function main(): Promise<void> {
  const isCapture = process.env.RYAGENT_CAPTURE === '1'
  // 单实例锁：第二个实例直接退出，由首实例聚焦已有窗口。
  // 截图模式（RYAGENT_CAPTURE=1）是独立进程，不参与锁。
  if (!isCapture && !app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }

  await app.whenReady()
  bootTrace.mark('app-ready')
  // Windows 的系统通知按 AUMID 归属应用；不设的话任务栏/通知里显示的是 electron.app.Electron。
  app.setAppUserModelId('com.ryagent.desktop')
  loadDotEnvIntoProcess()
  registerIpcHandlers()
  applyAppMenu()

  const devServerUrl = process.env.RYAGENT_DEV_SERVER_URL
  // 渲染层资源服务：与后端无关，先就绪，窗口才能立刻开始加载。
  let assets: RendererAssets | undefined
  if (devServerUrl === undefined || devServerUrl.length === 0) {
    // 与后端同一套端口策略：固定端口优先（跨启动 origin 稳定，HTTP 与 V8 缓存
    // 不归零）；被占用时回退随机，实际地址由 assets.url 带出，调用方不必关心。
    const assetChoice = await resolveBackendPort({ port: DEFAULT_ASSETS_PORT, host: BACKEND_HOST })
    if (assetChoice.fallback === true) {
      console.warn(`[ryagent] ${assetChoice.reason ?? '端口被占用'}，资源服务回退随机端口`)
    }
    assets = await RendererAssets.start(join(here, '../renderer/dist'), { port: assetChoice.port })
    if (assets.fellBack) console.warn(`[ryagent] 资源服务端口 ${DEFAULT_ASSETS_PORT} 起不来，已回退 ${assets.port}`)
  }
  bootTrace.mark('assets-ready')
  const startServer = async (): Promise<RyAgentServer> => {
    // 固定端口优先（跨启动 origin 稳定，HTTP 与 V8 缓存不归零）；被占用时回退随机，
    // 实际地址由 readyServer.url 推给渲染层，调用方不必关心用的是哪个端口。
    const choice = await resolveBackendPort({ port: backendPortFromEnv(), host: BACKEND_HOST })
    if (choice.fallback === true) console.warn(`[ryagent] ${choice.reason ?? '端口被占用'}，回退随机端口`)
    return RyAgentServer.create({
      port: choice.port,
      host: BACKEND_HOST,
      dataDir: process.env.RYAGENT_DATA_DIR ?? join(app.getPath('userData'), 'ryagent-data'),
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
        ? `${assets.url}${RENDERER_MOUNT}?api=${encodeURIComponent(server.url)}`
        : `${devServerUrl}?api=${encodeURIComponent(server.url)}`
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
  let readyServer: RyAgentServer
  try {
    readyServer = await startServer()
  } catch (error) {
    dialog.showErrorBox('RyAgent 启动失败', error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  bootTrace.mark('backend-ready')
  // 首启落种（小队成员 + 接力演示会话）必须在 API 地址推给渲染层之前：
  // 渲染层一拿到地址就会拉会话列表，晚一步这轮首屏就没有演示可看。
  seedFirstLaunchOnce(readyServer)
  // 后端就绪：API 地址推给渲染层（窗口可能还在加载；渲染层另有全局变量兜底，
  // 事件早于监听注册也不会丢）。
  pushApiBase(mainWindow, readyServer.url)
  // 常驻：托盘 + 在场监听 + 失焦通知 + 关窗收进托盘。
  startResidency(readyServer.url)

  app.on('second-instance', () => {
    // 第二实例已退出，这里把首实例窗口拉到前台。
    showMainWindow()
  })
  app.on('activate', () => {
    // macOS 点击 Dock 图标：复用已有 server 实例，只在窗口全关时重建窗口。
    if (BrowserWindow.getAllWindows().length === 0) {
      pushApiBase(showMainWindowAndReturn(), readyServer.url)
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
