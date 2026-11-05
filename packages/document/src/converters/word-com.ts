/**
 * Word COM 转换器：用本机装的 Microsoft Word 把 Office 文件转成 PDF。
 *
 * **为什么先试 Word 而不是 LibreOffice**：上游 dsh 用的是 LibreOffice，但那东西
 * 几百 MB，装机与分发都不成比例；Windows 上装了 Office 的机器里 **Word COM 是
 * 现成的**——不用装任何东西，用 `Documents.Open` + `ExportAsFixedFormat` 就完事。
 * 两条路都在（见 `soffice.ts`），引擎按「本机有什么」自动挑。
 *
 * **为什么要走 PowerShell**：COM 是 Windows 的组件技术，Node 没有内建绑定。起一个
 * PowerShell 进程调 COM 是最省事的做法——零新增依赖，不用编译。
 *
 * **注意**：Word 是**有状态的进程**——开着窗口、记着最近打开的文件。所以转换完
 * 一定要 `Quit()`，否则用户桌面上会留下一堆 Word 窗口与僵尸进程。
 *
 * @module @ryharness/document/converters/word-com
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DocumentError } from '../errors.ts'
import type { DocumentConverter, DocumentConvertInput, DocumentConvertResult } from '../types.ts'

/** 转换器 id（会进缓存键）。 */
const CONVERTER_ID = 'word-com'

/** 一次转换的默认时限（毫秒）。Word 起进程慢，给得宽一点。 */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * PDF 导出的格式常量（`wdExportFormatPDF`）。
 */
const WORD_EXPORT_FORMAT_PDF = 17

/**
 * PowerShell 脚本。
 *
 * 输入靠**环境变量**传，不拼进脚本文本：文件内容走 base64 走环境变量，路径走
 * 环境变量，脚本本身是固定的。模型给的文件名里有什么都不影响脚本解析。
 *
 * **收尾必须干净**：Word 是有状态的进程——开着窗口、记着最近打开的文件。所以
 * 这里在 `finally` 里关文档、`Quit()` 应用、释放 COM 引用，并把**这次起的那个
 * Word 进程号**打出来：Word 的 `Quit()` 不保证进程立刻消失（它可能还挂在
 * 收尾流程里），宿主拿这个 pid 去确认并收掉它——只收自己起的那一个，不碰用户
 * 自己的 Word。
 */
const CONVERT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$srcPath = $env:RY_DOC_SRC
$pdfPath = $env:RY_DOC_PDF
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  [Console]::Out.WriteLine("PID:" + $word.Application.ProcessID)
  $doc = $word.Documents.Open($srcPath, $false, $true)
  $doc.ExportAsFixedFormat($pdfPath, ${WORD_EXPORT_FORMAT_PDF})
  $pages = $doc.ComputeStatistics(2)
  [Console]::Out.WriteLine("PAGES:" + $pages)
} finally {
  if ($doc -ne $null) {
    try { $doc.Close($false) } catch {}
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null } catch {}
  }
  if ($word -ne $null) {
    try { $word.Quit() } catch {}
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`

/** Word COM 转换器的构造参数。 */
export interface WordComConverterOptions {
  /** 宿主环境；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 平台；缺省当前平台。 */
  readonly platform?: NodeJS.Platform
  /** 单次转换的时限（毫秒）。默认 120000。 */
  readonly timeoutMs?: number
  /** PowerShell 可执行文件路径；缺省按平台挑。 */
  readonly powershellPath?: string
}

/**
 * 找 PowerShell。
 * @param options - 查找选项。
 * @returns 路径；找不到是 undefined。
 */
function findPowerShell(options: WordComConverterOptions): string | undefined {
  const env = options.env ?? process.env
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
 * 本机有没有 Microsoft Word。
 *
 * **查注册表里的 ProgID，不启动 Word**。
 *
 * 这一条踩过坑：`New-Object -ComObject Word.Application` 是能探到 Word，
 * 但它会**真的起一个 WINWORD.EXE 进程并弹出一个可见窗口**——而且不显式
 * `Quit()` 的话那个进程会一直留着。服务端每起一个实例就探一次，于是探一次漏
 * 一个 Word 进程，一轮测试能漏几十个，用户桌面上就会开出一堆 Word 窗口。
 *
 * 注册表里有 `Word.Application` 这个 ProgID 就说明装了 Office，够判断了；
 * 真要转文档时再起 COM（那时候必须起，而且必须收干净）。
 *
 * @param options - 探测选项。
 * @returns 装了返回 true。
 */
export function hasWordInstalled(options: WordComConverterOptions = {}): boolean {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return false
  const env = options.env ?? process.env
  const shell = findPowerShell(options)
  if (shell === undefined) return false
  return probeWord(shell, env)
}

/**
 * 问一句「注册表里有没有 Word.Application 这个 ProgID」。
 *
 * **只读注册表，不创建任何 COM 对象**——所以既不起进程也不弹窗口。
 * @param shell - PowerShell 路径。
 * @param env - 环境。
 * @returns 在就返回 true。
 */
function probeWord(shell: string, env: NodeJS.ProcessEnv): boolean {
  return runProcess(
    shell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      // 查三个地方：32 位与 64 位视图下的 CLSID 根，以及 TypeLib 的类型键。
      // 任何一个命中就说明装了 Office。
      '$keys = @(' +
        '"Registry::HKEY_CLASSES_ROOT\\Word.Application", ' +
        '"Registry::HKEY_CLASSES_ROOT\\WOW6432Node\\Word.Application", ' +
        '"Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Word.Application"' +
        '); ' +
        'foreach ($k in $keys) { if (Test-Path -LiteralPath $k) { exit 0 } }; exit 1',
    ],
    { env, timeoutMs: 15_000 },
  ).ok
}

/**
 * 跑一个进程，只看它成不成功。
 * @param command - 命令。
 * @param args - 参数。
 * @param options - 执行选项。
 * @returns 成功与否。
 */
function runProcess(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSyncCapture(command, args, options)
  return result
}

/**
 * 同步跑一个进程并拿它的输出。
 * @param command - 命令。
 * @param args - 参数。
 * @param options - 执行选项。
 * @returns 执行结果。
 */
function spawnSyncCapture(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): { ok: boolean; stdout: string; stderr: string } {
  // 用 execFileSync 而不是 spawnSync：它自带超时与「非零退出码抛错」两件事。
  try {
    const stdout = execFileSync(command, [...args], {
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? '' }
  }
}

/**
 * Word COM 转换器。
 */
export class WordComConverter implements DocumentConverter {
  readonly id = CONVERTER_ID

  #options: WordComConverterOptions

  constructor(options: WordComConverterOptions = {}) {
    this.#options = options
  }

  /** 把一份文档转成 PDF。 */
  async convert(input: DocumentConvertInput): Promise<DocumentConvertResult> {
    const platform = this.#options.platform ?? process.platform
    if (platform !== 'win32') {
      throw new DocumentError('ENGINE_UNAVAILABLE', 'Word COM 转换器只能在 Windows 上用。')
    }
    const shell = findPowerShell(this.#options)
    if (shell === undefined) {
      throw new DocumentError('ENGINE_UNAVAILABLE', '本机没找到 PowerShell，Word COM 转换器用不了。')
    }

    // 工作目录放临时区：输入与中间产物都不该落在用户的文档目录里。
    const workDir = mkdtempSync(join(tmpdir(), 'ryharness-doc-'))
    const srcPath = join(workDir, 'input.doc')
    const pdfPath = join(workDir, 'output.pdf')
    try {
      writeFileSync(srcPath, Buffer.from(input.bytes))
      const result = await this.#runWord(shell, srcPath, pdfPath)
      if (!result.ok) {
        throw new DocumentError('CONVERSION_FAILED', `Word 转换失败：${result.detail}`)
      }
      if (!existsSync(pdfPath)) {
        throw new DocumentError('CONVERSION_FAILED', 'Word 说转完了，但没找到 PDF 文件。')
      }
      const pdf = Buffer.from(await readFileAsync(pdfPath))
      return { pdf, ...(result.pages === undefined ? {} : { pages: result.pages }) }
    } finally {
      // 临时目录一定要清：里面躺着用户的文档原件。
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // 清不掉就留在临时区；系统临时目录自己会清。
      }
    }
  }

  /** 跑那段 Word 脚本。 */
  async #runWord(
    shell: string,
    srcPath: string,
    pdfPath: string,
  ): Promise<{ ok: boolean; detail: string; pages?: number }> {
    const env = {
      ...(this.#options.env ?? process.env),
      RY_DOC_SRC: srcPath,
      RY_DOC_PDF: pdfPath,
    }
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return await new Promise((resolve) => {
      const child: ChildProcess = spawn(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CONVERT_SCRIPT],
        { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
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
        resolve({ ok: false, detail: `Word 转换超过 ${timeoutMs} 毫秒没返回` })
      }, timeoutMs)
      child.on('error', (error: Error) => {
        clearTimeout(timer)
        resolve({ ok: false, detail: `起 PowerShell 失败：${error.message}` })
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        // Word 进程可能还活着（Quit() 不保证立刻退出）：按 pid 收掉**这一次起的**那个。
        // 只按脚本报上来的 pid 收，不按名字批量杀——用户自己的 Word 不能碰。
        const wordPid = Number.parseInt(/PID:(\d+)/.exec(stdout)?.[1] ?? '', 10)
        if (Number.isInteger(wordPid)) reclaimWordProcess(wordPid)
        if (code !== 0) {
          const detail = stderr.trim().length > 0 ? stderr.trim() : `退出码 ${code}`
          resolve({ ok: false, detail })
          return
        }
        const pages = Number.parseInt(/PAGES:(\d+)/.exec(stdout)?.[1] ?? '', 10)
        resolve({ ok: true, detail: '', ...(Number.isInteger(pages) ? { pages } : {}) })
      })
    })
  }
}

/**
 * 收掉一个残留的 Word 进程。
 *
 * **只按 pid 收**：脚本自己报上来的那个 pid 就是这次转换起的 Word，用户自己开
 * 着的 Word 不在里头。杀不掉就算了（它会自己退出），不能因此让转换失败。
 * @param pid - Word 进程号。
 */
function reclaimWordProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程已经退了，或权限不够：这两种都不影响转换结果。
  }
}

/** 读一个文件。 */
async function readFileAsync(path: string): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises')
  return await readFile(path)
}
