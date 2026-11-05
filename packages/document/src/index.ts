/**
 * RyHarness 文档转换：把授权过的 Office 文件变成可复用的 PDF。
 *
 * 三块：
 * - **转换器契约**（{@link DocumentConverter}）：真正把字节变成 PDF 的那一层。本包不带
 *   LibreOffice（几百 MB，装机与分发都不成比例），但带两个**可选**的宿主适配器：
 *   {@link WordComConverter}（Windows 上用现成的 Word COM）与 {@link SofficeConverter}
 *   （装了 LibreOffice 就用）。{@link createDocumentConverter} 按本机有什么自动挑。
 * - **服务**（{@link DocumentConversionService}）：授权、类型白名单、大小与页数上限、时限、
 *   按内容 hash 的缓存、产物落盘。
 * - **降级说法**（{@link engineUnavailableError}）：本机没装引擎时报一条能照着做的说明，
 *   而不是一句「转换失败」。
 *
 * 本包**不引 LibreOffice**（几百 MB，装机与分发都不成比例）、**不做 OCR**、
 * **不做图片转 PDF**。
 * @module @ryharness/document
 */

export type { DocumentCacheEntry } from './cache.ts'
export { DocumentPdfCache } from './cache.ts'
export type { DetectEngineOptions, DocumentEngineInfo, DocumentEngineKind } from './converters/engine.ts'
export { createDocumentConverter, detectDocumentEngine, resetDocumentEngineCache } from './converters/engine.ts'
export type { SofficeConverterOptions } from './converters/soffice.ts'
export { findSoffice, hasSofficeInstalled, SofficeConverter } from './converters/soffice.ts'
export type { WordComConverterOptions } from './converters/word-com.ts'
export { hasWordInstalled, WordComConverter } from './converters/word-com.ts'
export { ENGINE_INSTALL_HINT, engineUnavailableError, unavailableConverter } from './engine.ts'
export type { DocumentErrorCode } from './errors.ts'
export { DocumentError, isDocumentError } from './errors.ts'
export type { DocumentMediaType } from './media.ts'
export {
  isSupportedMediaType,
  mediaTypeForName,
  resolveMediaType,
  SUPPORTED_MEDIA_TYPES,
  supportedMediaTypeList,
} from './media.ts'
export type { DocumentPolicy } from './policy.ts'
export {
  checkAuthorized,
  checkInputSize,
  checkPageCount,
  DEFAULT_DOCUMENT_POLICY,
  resolvePolicy,
} from './policy.ts'
export type {
  DocumentConversionOutcome,
  DocumentConvertRequest,
  DocumentServiceOptions,
} from './service.ts'
export { DocumentConversionService } from './service.ts'
export type {
  DocumentConverter,
  DocumentConvertInput,
  DocumentConvertResult,
  DocumentSource,
} from './types.ts'
