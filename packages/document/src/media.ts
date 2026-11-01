/**
 * 输入类型的白名单。
 *
 * **为什么要白名单**：转换引擎（不管哪个）都有可能被一份畸形文件带沟里——超大、加密、
 * 嵌了外部引用的 Office 文档都能。认准少数几种格式，其余一律拒，是最省事的防线。
 *
 * 判定顺序：
 * 1. MIME 类型在白名单里 → 就用它；
 * 2. MIME 类型认不出来（`application/octet-stream`）→ 退回按文件名后缀判断；
 * 3. 两处都认不出来 → 拒（`UNSUPPORTED_TYPE`）。**不猜**。
 * @module @ryharness/document/media
 */

/** 白名单里的 MIME 类型。 */
export const SUPPORTED_MEDIA_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
] as const

/** 白名单里的某一种 MIME 类型。 */
export type DocumentMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number]

/** 后缀 → MIME 类型。 */
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, DocumentMediaType>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
}

/** 认不出来的 MIME 类型（这时才看文件名后缀）。 */
const GENERIC_MEDIA_TYPES: readonly string[] = ['', 'application/octet-stream', 'binary/octet-stream']

/**
 * 这个 MIME 类型在白名单里吗。
 * @param value - 待判定的 MIME 类型。
 * @returns 在白名单里返回 true。
 */
export function isSupportedMediaType(value: string): value is DocumentMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(value)
}

/**
 * 按文件名后缀找 MIME 类型。
 * @param name - 文件名。
 * @returns 认得出来返回类型，认不出来返回 undefined。
 */
export function mediaTypeForName(name: string): DocumentMediaType | undefined {
  const index = name.lastIndexOf('.')
  if (index < 0 || index === name.length - 1) return undefined
  const extension = name.slice(index + 1).toLowerCase()
  return MEDIA_TYPE_BY_EXTENSION[extension]
}

/**
 * 定下这份输入到底是什么类型。
 * @param mediaType - 调用方给的 MIME 类型。
 * @param name - 文件名（可选）。
 * @returns 认得出来返回类型，认不出来返回 undefined。
 */
export function resolveMediaType(mediaType: string, name?: string): DocumentMediaType | undefined {
  if (isSupportedMediaType(mediaType)) return mediaType
  const generic = mediaType.trim().toLowerCase()
  if (!GENERIC_MEDIA_TYPES.includes(generic)) return undefined
  if (name === undefined) return undefined
  return mediaTypeForName(name)
}

/**
 * 白名单的可读列表（写进错误文案里，让人知道能转什么）。
 * @returns 类型清单。
 */
export function supportedMediaTypeList(): string {
  return SUPPORTED_MEDIA_TYPES.join('、')
}
