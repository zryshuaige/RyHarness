/**
 * Windows 桌面驱动：用系统自带的 PowerShell + .NET 做截图与输入。
 *
 * **为什么走 PowerShell 而不是原生绑定**：桌面自动化要 P/Invoke user32.dll，
 * 那需要原生代码与构建链；用 PowerShell 跑一段内联的 .NET 就能拿到同样的能力，
 * **零新增依赖**、不需要编译。代价是每次动作多一次进程启动（约 200-600ms）——
 * 对「看一眼屏幕再点一下」这种节奏来说可以接受。
 *
 * **DPI**：截图用 `SystemInformation.VirtualScreen`（物理像素），输入用
 * `SetCursorPos`（同样是物理像素），两边口径一致，所以缩放下不会点偏。
 *
 * **只在 Windows 上能用**：其它平台会得到结构化的 `NO_DRIVER` 错误，不假装成功。
 *
 * @module @ryharness/computer-use/drivers/windows
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ComputerUseError } from '../errors.ts'
import type { ComputerDriver, ComputerScreenshot } from '../types.ts'

/** 驱动名。 */
const DRIVER_NAME = 'windows'

/** 一次动作的默认时限（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 动作脚本。
 *
 * 写成一个 PowerShell 片段，按动作类型取一段跑。**参数全部经过 JSON 编码**再
 * 塞进脚本里——模型给的文本里有引号、有反引号、有换行，直接拼进脚本就是注入。
 */
const POWERSHELL_PRELUDE = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ("RyDeskNative" -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RyDeskNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint WHEEL = 0x0800;
  public const uint MOVE = 0x0001;
  public const uint ABSOLUTE = 0x8000;
}
"@
}
`

/** 截图那段脚本。 */
const SCREENSHOT_SCRIPT = `
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
[Console]::Out.WriteLine("RY:" + $bounds.Width + "x" + $bounds.Height + ":" + [Convert]::ToBase64String($ms.ToArray()))
`

/**
 * 把一段值编码成 PowerShell 里的字符串字面量。
 *
 * 走 `ConvertFrom-Json` 反序列化：模型给什么都能原样进去，不需要自己处理引号。
 * @param value - 字符串值。
 * @returns 一段 PowerShell 表达式。
 */
function psString(value: string): string {
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`
}

/** Windows 桌面的构造参数。 */
export interface WindowsDesktopOptions {
  /** 宿主环境；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 平台；缺省当前平台。 */
  readonly platform?: NodeJS.Platform
  /** 单次动作的时限（毫秒）。默认 30000。 */
  readonly timeoutMs?: number
  /** PowerShell 可执行文件路径；缺省按平台挑。 */
  readonly powershellPath?: string
}

/**
 * 找 PowerShell。
 *
 * 优先 pwsh（PowerShell 7），退回 Windows 自带的 powershell.exe。
 * @param options - 查找选项。
 * @returns 路径；找不到是 undefined。
 */
export function findPowerShell(options: WindowsDesktopOptions = {}): string | undefined {
  const env = options.env ?? process.env
  if (options.powershellPath !== undefined) {
    return existsSync(options.powershellPath) ? options.powershellPath : undefined
  }
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const candidates = [
    join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    join(root, 'Sysnative/WindowsPowerShell/v1.0/powershell.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 跑一段 PowerShell 并拿它的输出。
 *
 * 失败时把 stderr 原样带出去：桌面自动化的失败原因（权限、桌面会话不存在、
 * 脚本写错）都在里面，吞掉就只剩一句「失败了」。
 * @param script - 脚本。
 * @param options - 执行选项。
 * @returns 标准输出。
 */
async function runPowerShell(script: string, options: WindowsDesktopOptions): Promise<string> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    throw new ComputerUseError('NO_DRIVER', 'computer-use: 这个驱动只支持 Windows')
  }
  const shell = findPowerShell(options)
  if (shell === undefined) {
    throw new ComputerUseError('NO_DRIVER', 'computer-use: 本机没找到 PowerShell，这个驱动用不了')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return await new Promise<string>((resolve, reject) => {
    const child: ChildProcess = spawn(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new ComputerUseError('TIMEOUT', `computer-use: 桌面动作超过 ${timeoutMs} 毫秒没返回`))
    }, timeoutMs)
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(new ComputerUseError('DRIVER_FAILED', `computer-use: 起 PowerShell 失败：${error.message}`))
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
        return
      }
      const detail = stderr.trim().length > 0 ? stderr.trim() : `退出码 ${code}`
      reject(new ComputerUseError('DRIVER_FAILED', `computer-use: 桌面动作失败：${detail}`))
    })
  })
}

/**
 * Windows 桌面驱动。
 *
 * 每个动作都是一次独立的 PowerShell 进程：动作之间没有状态，坏了一个不影响
 * 下一个。代价是慢一点，换来的是「上一次动作崩了不会污染下一次」。
 */
export class WindowsDesktopDriver implements ComputerDriver {
  readonly name = DRIVER_NAME

  #options: WindowsDesktopOptions

  constructor(options: WindowsDesktopOptions = {}) {
    this.#options = options
  }

  /** 截当前屏幕。 */
  async screenshot(): Promise<ComputerScreenshot> {
    const output = await runPowerShell(`${POWERSHELL_PRELUDE}${SCREENSHOT_SCRIPT}`, this.#options)
    const marker = output.indexOf('RY:')
    if (marker < 0) {
      throw new ComputerUseError('DRIVER_FAILED', 'computer-use: 截图没有拿到数据。')
    }
    const payload = output.slice(marker + 3).trim()
    const separator = payload.indexOf(':')
    if (separator < 0) {
      throw new ComputerUseError('DRIVER_FAILED', 'computer-use: 截图数据格式不对。')
    }
    const size = payload.slice(0, separator)
    const base64 = payload.slice(separator + 1).trim()
    const [width, height] = size.split('x').map((part) => Number.parseInt(part, 10))
    return {
      bytes: Buffer.from(base64, 'base64'),
      mimeType: 'image/png',
      width: Number.isInteger(width) ? width : undefined,
      height: Number.isInteger(height) ? height : undefined,
    }
  }

  /** 点一下屏幕上的某个点。 */
  async click(x: number, y: number): Promise<void> {
    await runPowerShell(
      `${POWERSHELL_PRELUDE}
[RyDeskNative]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 60
[RyDeskNative]::mouse_event([RyDeskNative]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
[RyDeskNative]::mouse_event([RyDeskNative]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
`,
      this.#options,
    )
  }

  /** 打一段字。 */
  async type(text: string): Promise<void> {
    await runPowerShell(
      `${POWERSHELL_PRELUDE}
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys(${psString(text)})
`,
      this.#options,
    )
  }

  /** 按一个键。 */
  async key(name: string): Promise<void> {
    await runPowerShell(
      `${POWERSHELL_PRELUDE}
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys(${psString(toSendKeys(name))})
`,
      this.#options,
    )
  }

  /** 把鼠标移到某个点。 */
  async move(x: number, y: number): Promise<void> {
    await runPowerShell(
      `${POWERSHELL_PRELUDE}
[RyDeskNative]::SetCursorPos(${x}, ${y}) | Out-Null
`,
      this.#options,
    )
  }

  /** 滚轮滚动（横向位移在 Windows 的滚轮消息里没有对应量，只用纵向）。 */
  async scroll(_dx: number, dy: number): Promise<void> {
    await runPowerShell(
      `${POWERSHELL_PRELUDE}
$steps = [Math]::Max(1, [Math]::Abs(${dy}) / 120)
for ($i = 0; $i -lt $steps; $i++) {
  $delta = if (${dy} -lt 0) { -120 } else { 120 }
  [RyDeskNative]::mouse_event([RyDeskNative]::WHEEL, 0, 0, [uint32]([uint32]$delta -band 0xFFFFFFFF), [IntPtr]::Zero)
}
`,
      this.#options,
    )
  }

  /** 收尾：这个驱动不占常驻资源。 */
  async close(): Promise<void> {}
}

/**
 * 把键名翻译成 `WScript.Shell.SendKeys` 的写法。
 *
 * 键名用模型看得懂的形式（`Enter`、`ctrl+c`、`Alt+Tab`），SendKeys 用的是
 * `{ENTER}`、`^c`、`%{TAB}`。翻译表就是这一份，不在别处重复。
 * @param name - 键名。
 * @returns SendKeys 的写法。
 */
export function toSendKeys(name: string): string {
  const key = name.trim()
  if (key.length === 0) return ''
  // 已经写成 SendKeys 语法（{ENTER}）就原样用。
  if (key.startsWith('{') && key.endsWith('}')) return key

  const parts = key.split('+').map((part) => part.trim())
  const modifiers = parts.slice(0, -1)
  const main = parts[parts.length - 1] ?? ''
  const prefix = modifiers
    .map((modifier) => {
      const lower = modifier.toLowerCase()
      if (lower === 'ctrl' || lower === 'control') return '^'
      if (lower === 'alt') return '%'
      if (lower === 'shift') return '+'
      if (lower === 'win' || lower === 'meta' || lower === 'cmd') return '#'
      return ''
    })
    .join('')

  const named: Record<string, string> = {
    enter: '{ENTER}',
    return: '{ENTER}',
    tab: '{TAB}',
    esc: '{ESC}',
    escape: '{ESC}',
    space: ' ',
    backspace: '{BACKSPACE}',
    delete: '{DELETE}',
    del: '{DELETE}',
    insert: '{INSERT}',
    home: '{HOME}',
    end: '{END}',
    pageup: '{PGUP}',
    pagedown: '{PGDN}',
    up: '{UP}',
    down: '{DOWN}',
    left: '{LEFT}',
    right: '{RIGHT}',
    f1: '{F1}',
    f2: '{F2}',
    f3: '{F3}',
    f4: '{F4}',
    f5: '{F5}',
    f6: '{F6}',
    f7: '{F7}',
    f8: '{F8}',
    f9: '{F9}',
    f10: '{F10}',
    f11: '{F11}',
    f12: '{F12}',
  }
  const lowerMain = main.toLowerCase()
  if (named[lowerMain] !== undefined) return prefix + named[lowerMain]
  // 单个字符直接用；多字符（没被命名表收录的）当成组合键逐个发。
  if ([...main].length === 1) return prefix + main
  return main
    .split('')
    .map((char) => prefix + char)
    .join('')
}
