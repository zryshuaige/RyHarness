/**
 * 文档转换服务：把「授权过的 Office 文件」变成「可复用的 PDF」。
 *
 * 一次转换按固定的顺序过一遍，顺序本身就是边界：
 *
 * 1. **授权**：没显式授权就不做——连文件大小都不量（没授权的文件不该被读）。
 * 2. **类型白名单**：不在白名单里的类型直接拒，不猜。
 * 3. **大小上限**：超了直接拒，不给引擎「试试看」的机会。
 * 4. **缓存**：同样的内容转过一次就直接给缓存里的 PDF，不重复转。
 * 5. **转换**：调宿主的转换器，带时限与取消。
 * 6. **页数上限**：转换器报得出页数就判，超了这份产物不落盘。
 * 7. **落盘**：PDF 写进宿主给的目录，并按内容 hash 记进缓存。
 *
 * 产物**不落临时目录**：临时目录会被清掉，PDF 放那儿等于没放。所以 `outputDir` 是必填的，
 * 而且默认拒绝指向系统临时目录的路径（真要那样，明说 `allowTemporaryOutputDir`）。
 * @module @ryharness/document/service
 */

import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { DocumentPdfCache } from './cache.ts'
import { DocumentError, isDocumentError } from './errors.ts'
import { type DocumentMediaType, resolveMediaType, supportedMediaTypeList } from './media.ts'
import { checkAuthorized, checkInputSize, checkPageCount, type DocumentPolicy, resolvePolicy } from './policy.ts'
import type { DocumentConverter, DocumentConvertResult, DocumentSource } from './types.ts'

/** PDF 的文件头。 */
const PDF_MAGIC = '%PDF-'

/** 服务的构造参数。 */
export interface DocumentServiceOptions {
  /** 转换器（宿主提供；本机没装引擎时用 `unavailableConverter()`）。 */
  readonly converter: DocumentConverter
  /** PDF 落盘目录（宿主给）。必填。 */
  readonly outputDir: string
  /** 缓存目录；缺省与 `outputDir` 同一个。 */
  readonly cacheDir?: string
  /** 边界覆盖项。 */
  readonly policy?: Partial<DocumentPolicy>
  /** 明知要落在系统临时目录时显式放行（默认不放行）。 */
  readonly allowTemporaryOutputDir?: boolean
}

/** 一次转换请求。 */
export interface DocumentConvertRequest {
  /** 待转换的文档。 */
  readonly source: DocumentSource
  /**
   * 调用方是不是授权了这份文件。
   *
   * **必填且必须为真**：没授权就不转。这是这一族的硬边界，不是可以默认掉的开关。
   */
  readonly authorized: boolean
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/** 一次转换的结果。 */
export interface DocumentConversionOutcome {
  /** PDF 字节。 */
  readonly pdf: Uint8Array
  /** 页数（转换器报得出来才有）。 */
  readonly pages?: number
  /** 是不是命中了缓存。 */
  readonly fromCache: boolean
  /** 缓存键（内容 hash）。 */
  readonly key: string
  /** PDF 在盘上的路径。 */
  readonly path: string
}

/** 比较路径时用的归一化（Windows 上大小写不敏感）。 */
function comparable(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 某个路径是不是在另一个目录里面。 */
function isInsideDirectory(parent: string, child: string): boolean {
  const p = comparable(parent)
  const c = comparable(child)
  if (p === c) return true
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`)
}

/** 错误对象 → 一句人话。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 这堆字节是不是一个 PDF。 */
function isPdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false
  return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString('latin1') === PDF_MAGIC
}

/**
 * 文档转换服务。
 *
 * 一个实例管一份产物目录与一个转换器；可以反复用。
 */
export class DocumentConversionService {
  /** 转换器。 */
  readonly #converter: DocumentConverter
  /** 边界。 */
  readonly #policy: DocumentPolicy
  /** 缓存。 */
  readonly #cache: DocumentPdfCache
  /** 产物目录。 */
  readonly #outputDir: string

  constructor(options: DocumentServiceOptions) {
    const rawOutput = options.outputDir.trim()
    if (rawOutput.length === 0) {
      throw new DocumentError(
        'OUTPUT_DIR_INVALID',
        '必须给一个产物目录：PDF 要落在宿主指定的持久目录里，不能落临时目录。',
      )
    }
    const outputDir = resolve(rawOutput)
    if (options.allowTemporaryOutputDir !== true && isInsideDirectory(tmpdir(), outputDir)) {
      throw new DocumentError(
        'OUTPUT_DIR_INVALID',
        `产物目录在系统临时目录里（${outputDir}）：临时目录会被清掉，PDF 放这儿等于没放。` +
          '换一个持久目录，或者显式声明 allowTemporaryOutputDir。',
      )
    }
    this.#outputDir = outputDir
    this.#converter = options.converter
    this.#policy = resolvePolicy(options.policy)
    this.#cache = new DocumentPdfCache(options.cacheDir ?? outputDir)
  }

  /** 产物目录。 */
  get outputDir(): string {
    return this.#outputDir
  }

  /** 边界参数。 */
  get policy(): DocumentPolicy {
    return this.#policy
  }

  /**
   * 把一份文档转成 PDF。
   * @param request - 转换请求（必须带授权）。
   * @returns 转换结果（含缓存命中与否）。
   */
  async convert(request: DocumentConvertRequest): Promise<DocumentConversionOutcome> {
    checkAuthorized(request.authorized)
    const source = request.source
    if (source.bytes.length === 0) {
      throw new DocumentError('INVALID_INPUT', '文件是空的，没什么可转的。')
    }
    const mediaType = resolveMediaType(source.mediaType, source.name)
    if (mediaType === undefined) {
      throw new DocumentError(
        'UNSUPPORTED_TYPE',
        `不支持的文件类型（${source.mediaType}${source.name === undefined ? '' : `，文件名 ${source.name}`}）。` +
          `只转这些：${supportedMediaTypeList()}。`,
      )
    }
    checkInputSize(source.bytes.length, this.#policy)

    const key = this.#cache.keyFor(source.bytes, mediaType, this.#converter.id)
    const cached = await this.#cache.read(key)
    if (cached !== undefined) {
      return { pdf: cached, fromCache: true, key, path: this.#cache.pathFor(key) }
    }

    const converted = await this.#runConverter(source, mediaType, request.signal)
    if (!isPdf(converted.pdf)) {
      throw new DocumentError('CONVERSION_FAILED', '转换器返回的不是一个 PDF 文件。')
    }
    checkPageCount(converted.pages, this.#policy)

    const path = await this.#cache.write(key, converted.pdf)
    return {
      pdf: converted.pdf,
      ...(converted.pages === undefined ? {} : { pages: converted.pages }),
      fromCache: false,
      key,
      path,
    }
  }

  /**
   * 调转换器，带时限与取消。
   *
   * 时限到了就 abort 转换器**并且**不等它收尾：引擎卡住时不能把这一轮也拖住。
   */
  async #runConverter(
    source: DocumentSource,
    mediaType: DocumentMediaType,
    signal?: AbortSignal,
  ): Promise<DocumentConvertResult> {
    const controller = new AbortController()
    const cleanups: (() => void)[] = []
    let timer: ReturnType<typeof setTimeout> | undefined

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new DocumentError('TIMEOUT', `转换超时（上限 ${this.#policy.timeoutMs} 毫秒），转换已经收掉。`))
      }, this.#policy.timeoutMs)
      timer.unref?.()
    })

    const cancelled = new Promise<never>((_resolve, reject) => {
      if (signal === undefined) return
      const onAbort = (): void => {
        controller.abort()
        reject(new DocumentError('CANCELLED', '转换被取消了。'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', onAbort))
    })

    const work = this.#converter.convert({
      bytes: source.bytes,
      mediaType,
      ...(source.name === undefined ? {} : { name: source.name }),
      signal: controller.signal,
    })
    // 超时先到、转换器后失败时，那条 rejection 没人接会变成未处理异常：先挂一个空处理器。
    void work.catch(() => undefined)

    try {
      return await Promise.race([work, timeout, cancelled])
    } catch (error) {
      if (isDocumentError(error)) throw error
      throw new DocumentError('CONVERSION_FAILED', `转换失败：${messageOf(error)}`, { cause: error })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      for (const cleanup of cleanups) cleanup()
    }
  }
}
