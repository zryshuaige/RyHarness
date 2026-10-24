/**
 * 主进程的两道权限闸：能交给系统打开的路径、能放行的浏览器权限。
 *
 * 单独成模块是为了能**直接测**：main.ts 一 import 就带进 electron，测试里跑不动；
 * 而这两条闸恰恰是"少一道就出事"的地方，必须有测试钉住，不能只靠肉眼读代码。
 * @module apps/desktop/electron/security
 */

import { extname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * shell.openPath 会用**系统默认程序**打开目标：对 .exe / .lnk / .bat 就是直接执行。
 *
 * 而产物路径是 agent 用 file_produce 写出来的——内容由模型决定，模型又可能被网页、
 * 文档里的提示注入影响。这些扩展名一律不放行：用户想看一个产物，看的应该是内容
 * （预览 / 下载），不是把它交给系统执行。
 */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe',
  '.lnk',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.msi',
  '.ps1',
  '.vbs',
  '.jar',
  '.hta',
  // Windows 脚本宿主的其余载体：.jse/.vbe 只是编码混淆过的 .js/.vbs，.wsf 能拼装
  // 多段脚本——双击与 .vbs 一样直接执行代码，拦 .vbs 不拦它们等于漏了大半族。
  '.jse',
  '.vbe',
  '.wsf',
  // 快捷方式族：.url/.scf 指向任意目标（可带参数），.cpl 由 rundll32 加载——双击
  // 不是「打开内容」而是「跳去执行别处的东西」，与 .lnk 同一风险。
  '.url',
  '.scf',
  '.cpl',
])

/**
 * 路径是否落在某个根目录之下（根目录本身也算在内）。
 *
 * 用 relative 而不是字符串前缀：`C:\work` 与 `C:\workspace-evil` 前缀相同但毫无
 * 关系，字符串前缀会把后者放进来。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const from = resolve(root)
  const to = resolve(target)
  if (from === to) return true
  const rel = relative(from, to)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 这个路径能不能交给 shell.openPath？
 *
 * 三道闸缺一不可：绝对路径、在工作区之内、不是可执行文件。少了任何一道，这条
 * IPC 就是一条「把文件交给系统执行」的通道，而入参完全由 agent 的产出决定。
 */
export function canOpenPath(root: string, target: unknown): boolean {
  if (typeof target !== 'string' || target.length === 0) return false
  if (!isAbsolute(target)) return false
  if (!isInsideRoot(root, target)) return false
  return !EXECUTABLE_EXTENSIONS.has(extname(target).toLowerCase())
}

/**
 * 渲染层真正用到的权限就这么一项：往剪贴板写（复制按钮）。
 *
 * Electron 的默认行为是**自动批准所有权限请求**——官方文档原话："By default,
 * Electron will automatically approve all permission requests unless the developer
 * has manually configured a custom handler."。不装这个 handler，渲染层一旦被诱导
 * 调用 getUserMedia，摄像头与麦克风会直接打开、没有系统授权框；剪贴板读、串口、
 * 指针锁定同理。这个应用一样都不需要，因此默认拒绝、只放行剪贴板写。
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-write', 'clipboard-sanitized-write'])

/** 这项权限放行吗？默认拒绝。 */
export function allowedPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

/**
 * 环境变量里的 API token 只在**自动化**场景可信。
 *
 * RYHARNESS_API_TOKEN 是给冒烟测试用的（release.yml 要在进程外访问 API，不能靠猜随
 * 机 token）。生产构建同样认它的话，用户（或用户抄来的脚本、快捷方式、计划任务）
 * 设一个 RYHARNESS_API_TOKEN，本机任何进程都能拿 Bearer 直调本机 API——而这个 API
 * 背后是带 shellExec 的 agent 工具链。每次启动随机 256 位 token 的防线被一个环境
 * 变量整个绕过，界面上还没有任何提示。
 */
export function envTokenAllowed(env: {
  CI?: string | undefined
  RYHARNESS_CAPTURE?: string | undefined
  RYAGENT_CAPTURE?: string | undefined
}): boolean {
  return env.CI === 'true' || env.RYHARNESS_CAPTURE === '1' || env.RYAGENT_CAPTURE === '1'
}

/**
 * 环境变量取值：**新名优先，旧名仍然认**。
 *
 * 改名那天的兼容：用户的启动脚本、计划任务、CI 里写的还是旧名（RYAGENT_*）。直接不认
 * 的话，那些脚本会"突然不起作用"——比如数据目录悄悄换了个地方，用户打开应用发现
 * 自己的会话都不见了，却什么提示都没收到。
 */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const current = env[`RYHARNESS_${name}`]
  if (current !== undefined && current.length > 0) return current
  const legacy = env[`RYAGENT_${name}`]
  return legacy !== undefined && legacy.length > 0 ? legacy : undefined
}

/**
 * .env 的候选路径。
 *
 * 生产态只认两处：显式指定的 RYHARNESS_ENV_FILE，与 userData（Roaming）下的 .env。
 * 安装目录（per-user 可写：NSIS 默认装到 %LOCALAPPDATA%\Programs）与 cwd 都是
 * 任何以当前用户身份运行的进程都能写的地方，往里丢一个 .env 就能把整个会话库
 * （消息、长期记忆、agent 配置）指向攻击者准备好的路径。配置信任边界不该比数据
 * 目录还宽。
 *
 * 开发态多给三处（应用目录 / 仓库根 / cwd），本地调试要的就是"根目录那个 .env"。
 */
export function dotEnvCandidates(input: {
  envFile: string | undefined
  userData: string
  appPath: string
  cwd: string
  packaged: boolean
}): string[] {
  const devOnly = input.packaged
    ? []
    : [join(input.appPath, '.env'), join(input.appPath, '..', '..', '.env'), join(input.cwd, '.env')]
  return [input.envFile, join(input.userData, '.env'), ...devOnly].filter((candidate): candidate is string => {
    return typeof candidate === 'string' && candidate.length > 0
  })
}
