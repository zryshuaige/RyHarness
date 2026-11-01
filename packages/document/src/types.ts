/**
 * 文档转换的类型契约。
 *
 * 这一族做的是一件事：**把一份授权过的 Office 文件变成可复用的 PDF**。
 *
 * 分工是清楚的：
 * - **转换器**（{@link DocumentConverter}）：真正把字节变成 PDF 的那一层。宿主提供实现
 *   （本包不带 LibreOffice——那东西几百 MB，装机与分发都不成比例）。
 * - **服务**（`DocumentConversionService`）：管边界——授权、类型白名单、大小与页数上限、
 *   时限、按内容 hash 的缓存、产物落盘。
 *
 * 服务与转换器分开，是因为「能不能转」和「该不该转」是两件事：前者是环境问题（装没装
 * 引擎），后者是边界问题（授权了吗、类型在不在白名单里、有没有超限）。混在一起之后，
 * 「本机没装引擎」就会变成一句「转换失败」，使用者根本不知道该装什么。
 * @module @ryharness/document/types
 */

/** 一份待转换的文档。 */
export interface DocumentSource {
  /** 文件内容。 */
  readonly bytes: Uint8Array
  /**
   * MIME 类型。
   *
   * 认不出来（`application/octet-stream`）时会退回按文件名后缀判断；两处都认不出来
   * 就拒（白名单外的类型不猜）。
   */
  readonly mediaType: string
  /** 文件名（可选，但给了能帮上忙）。 */
  readonly name?: string
}

/** 交给转换器的一次请求。 */
export interface DocumentConvertInput {
  /** 文件内容。 */
  readonly bytes: Uint8Array
  /** 归一化后的 MIME 类型（一定在白名单里）。 */
  readonly mediaType: string
  /** 文件名。 */
  readonly name?: string
  /** 取消信号：时限到了或调用方中断时会被 abort。 */
  readonly signal?: AbortSignal
}

/** 转换器的产出。 */
export interface DocumentConvertResult {
  /** 转换出来的 PDF 字节。 */
  readonly pdf: Uint8Array
  /** 页数；转换器报得出来就报，报不出来就缺省（服务没法据此判页数上限）。 */
  readonly pages?: number
}

/**
 * 一个转换器实现。
 *
 * 宿主提供。**本机没装引擎的实现**见 `unavailableConverter()`：它总是报
 * `ENGINE_UNAVAILABLE`，并说清该装什么——这比「转换失败」有用得多。
 */
export interface DocumentConverter {
  /** 转换器 id（会进缓存键：换了转换器，旧缓存就不该被复用）。 */
  readonly id: string
  /**
   * 把一份文档转成 PDF。
   * @param input - 转换请求（带取消信号）。
   * @returns 转换结果。
   */
  convert(input: DocumentConvertInput): Promise<DocumentConvertResult>
}
