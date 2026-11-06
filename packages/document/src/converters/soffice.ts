/**
 * LibreOffice（soffice）转换器：把 Office 文件转成 PDF。
 *
 * **这是上游 dsh 用的那套引擎**：跨平台、批处理友好。代价是要装（几百 MB）。
 * 装了 LibreOffice 的机器用它，没装的机器走 Word COM（见 `word-com.ts`）——
 * 引擎的挑选在 `engine.ts` 里做。
 *
 * **为什么要 `--headless` 与独立用户配置**：不带这两个参数时 soffice 会去抢
 * 已经开着的那份实例（转出来的文件可能根本不是它转的），而且会弹 UI。
 * `-env:UserInstallation` 给它一份自己的配置目录，多个转换并行也不打架。
 *
 * @module @ryharness/document/converters/soffice
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentError } from '../errors.ts'
import type { DocumentConverter, DocumentConvertInput, DocumentConvertResult } from '../types.ts'

/** 转换器 id（会进缓存键）。 */
const CONVERTER_ID = 'soffice'

/** 一次转换的默认时限（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * MIME 类型 → 源文件后缀。
 *
 * soffice 靠后缀认格式，认不出来就转不了。`application/octet-stream` 这种
 * 泛型类型在服务层已经被 `resolveMediaType` 归一过了，所以这里拿到的都是
 * 具体类型。
 */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
}

/** soffice 转换器的构造参数。 */
export interface SofficeConverterOptions {
  /** 宿主环境；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 平台；缺省当前平台。 */
  readonly platform?: NodeJS.Platform
  /** 单次转换的时限（毫秒）。默认 120000。 */
  readonly timeoutMs?: number
  /** soffice 可执行文件路径；缺省按平台找。 */
  readonly executablePath?: string
}

/**
 * 找 soffice。
 *
 * 按平台找常见安装位置；找不到就说没装——**不猜**。
 * @param options - 查找选项。
 * @returns 路径；没找到是 undefined。
 */
export function findSoffice(options: SofficeConverterOptions = {}): string | undefined {
  if (options.executablePath !== undefined) {
    return existsSync(options.executablePath) ? options.executablePath : undefined
  }
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const candidates = [
      join(programFiles, 'LibreOffice/program/soffice.exe'),
      join(programFilesX86, 'LibreOffice/program/soffice.exe'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }
  if (platform === 'darwin') {
    const candidate = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    return existsSync(candidate) ? candidate : undefined
  }
  for (const candidate of ['/usr/bin/soffice', '/usr/bin/libreoffice', '/snap/bin/libreoffice']) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 本机有没有 LibreOffice。
 * @param options - 探测选项。
 * @returns 装了返回 true。
 */
export function hasSofficeInstalled(options: SofficeConverterOptions = {}): boolean {
  return findSoffice(options) !== undefined
}

/**
 * LibreOffice 转换器。
 */
export class SofficeConverter implements DocumentConverter {
  readonly id = CONVERTER_ID

  #options: SofficeConverterOptions

  constructor(options: SofficeConverterOptions = {}) {
    this.#options = options
  }

  /** 把一份文档转成 PDF。 */
  async convert(input: DocumentConvertInput): Promise<DocumentConvertResult> {
    const executable = findSoffice(this.#options)
    if (executable === undefined) {
      throw new DocumentError('ENGINE_UNAVAILABLE', '本机没找到 LibreOffice（soffice）。')
    }
    const extension = EXTENSION_BY_MEDIA_TYPE[input.mediaType]
    if (extension === undefined) {
      throw new DocumentError('UNSUPPORTED_TYPE', `soffice 转换器不认这个类型（${input.mediaType}）。`)
    }

    const workDir = mkdtempSync(join(tmpdir(), 'ryharness-doc-'))
    const profileDir = join(workDir, 'profile')
    const srcPath = join(workDir, `input.${extension}`)
    const outDir = join(workDir, 'out')
    try {
      writeFileSync(srcPath, Buffer.from(input.bytes))
      const { mkdir } = await import('node:fs/promises')
      await mkdir(outDir, { recursive: true })
      const result = await this.#runSoffice(executable, srcPath, outDir, profileDir)
      if (!result.ok) {
        throw new DocumentError('CONVERSION_FAILED', `LibreOffice 转换失败：${result.detail}`)
      }
      const pdfPath = join(outDir, `input.${extension}.pdf`)
      if (!existsSync(pdfPath)) {
        throw new DocumentError('CONVERSION_FAILED', 'LibreOffice 说转完了，但没找到 PDF 文件。')
      }
      const pdf = await readFile(pdfPath)
      return { pdf }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // 清不掉就留在临时区；系统临时目录自己会清。
      }
    }
  }

  /** 跑 soffice。 */
  async #runSoffice(
    executable: string,
    srcPath: string,
    outDir: string,
    profileDir: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const args = [
      '--headless',
      '--norestore',
      '--invisible',
      `-env:UserInstallation=${profileDir}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      srcPath,
    ]
    return await new Promise((resolve) => {
      const child: ChildProcess = spawn(executable, args, {
        env: this.#options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      child.stdout?.resume()
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      const timer = setTimeout(() => {
        child.kill()
        resolve({ ok: false, detail: `LibreOffice 转换超过 ${timeoutMs} 毫秒没返回` })
      }, timeoutMs)
      child.on('error', (error: Error) => {
        clearTimeout(timer)
        resolve({ ok: false, detail: `起 LibreOffice 失败：${error.message}` })
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve({ ok: true, detail: '' })
          return
        }
        const detail = stderr.trim().length > 0 ? stderr.trim() : `退出码 ${code}`
        resolve({ ok: false, detail })
      })
    })
  }
}
