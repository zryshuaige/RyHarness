/**
 * 「本机没装转换引擎」这件事怎么说。
 *
 * 这一族最容易出的错是把「没装引擎」报成「转换失败」——使用者看到这句话只会以为文件坏了，
 * 换个文件再试一遍，而真正该做的事（装 LibreOffice）没人告诉他。
 *
 * 所以这里给的是**一条能照着做的说明**：装什么、怎么装、不装的话还有哪条路。
 * @module @ryharness/document/engine
 */

import { DocumentError } from './errors.ts'
import type { DocumentConverter } from './types.ts'

/** 装引擎的说明（写进错误文案里）。 */
export const ENGINE_INSTALL_HINT = [
  '装 LibreOffice 就行（上游 dsh 用的就是这套引擎）：',
  'Windows——装完把 soffice.exe 放进 PATH；',
  'Linux——apt install libreoffice-writer libreoffice-calc libreoffice-impress，或 dnf install libreoffice；',
  'macOS——brew install --cask libreoffice。',
  '不想装引擎也行：自己实现 DocumentConverter 接口，把你的转换器交给 DocumentConversionService。',
].join('')

/**
 * 没装引擎时的那个错误。
 * @param detail - 补充说明（可选）。
 * @returns 带 `ENGINE_UNAVAILABLE` 码的错误。
 */
export function engineUnavailableError(detail?: string): DocumentError {
  const suffix = detail === undefined || detail.length === 0 ? '' : `（${detail}）`
  return new DocumentError('ENGINE_UNAVAILABLE', `本机没装文档转换引擎${suffix}。${ENGINE_INSTALL_HINT}`)
}

/**
 * 一个「永远报没装引擎」的转换器。
 *
 * 宿主在启动时探不到引擎就用它：这样调用方拿到的是一句能照着做的说明，而不是一个
 * 「转换失败」。
 * @param detail - 补充说明（可选）。
 * @returns 转换器。
 */
export function unavailableConverter(detail?: string): DocumentConverter {
  return {
    id: 'unavailable',
    convert: async () => {
      throw engineUnavailableError(detail)
    },
  }
}
