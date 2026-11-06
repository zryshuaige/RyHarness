/**
 * 引擎挑选：本机有什么就用什么，挑不到就如实说没装。
 *
 * **两条路**：
 * - **Word COM**（Windows + 装了 Office）：不用装任何东西，用系统现成的；
 * - **LibreOffice**（soffice）：跨平台，但要自己装几百 MB。
 *
 * 优先 Word：它不需要用户额外做任何事，「装了 Office 就能用」比「还要再装一个
 * LibreOffice」的门槛低得多。两条都没有时，报的是「没装引擎」加上**具体该装
 * 什么**——不是一句「转换失败」。
 *
 * @module @ryharness/document/converters/engine
 */

import { DocumentError } from '../errors.ts'
import type { DocumentConverter } from '../types.ts'
import { findSoffice, SofficeConverter } from './soffice.ts'
import { hasWordInstalled, WordComConverter } from './word-com.ts'

/** 引擎的种类。 */
export type DocumentEngineKind = 'word' | 'libreoffice' | 'none'

/** 引擎探测的结果。 */
export interface DocumentEngineInfo {
  /** 用的是哪个引擎。 */
  readonly kind: DocumentEngineKind
  /** 引擎的 id（进缓存键）。 */
  readonly converterId: string
  /** 给界面看的一句中文。 */
  readonly label: string
}

/** 探测选项。 */
export interface DetectEngineOptions {
  /** 宿主环境；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 平台；缺省当前平台。 */
  readonly platform?: NodeJS.Platform
}

/**
 * 探本机有什么引擎。
 *
 * **探的是「能不能用」，不是「装没装」**：Word 那条查注册表里的 ProgID，
 * LibreOffice 那条要真找到 soffice。
 *
 * **结果按平台与环境缓存**：探测要起一个 PowerShell 进程（几十毫秒到几百
 * 毫秒），而宿主可能问很多次（每个会话、每次工具调用都可能问）。缓存一次，
 * 后面都直接拿。
 * @param options - 探测选项。
 * @returns 引擎信息。
 */
export function detectDocumentEngine(options: DetectEngineOptions = {}): DocumentEngineInfo {
  const platform = options.platform ?? process.platform
  const key = `${platform}|${options.env === undefined ? '' : 'custom'}`
  const cached = detectionCache.get(key)
  if (cached !== undefined) return cached
  const info = probeEngine(options)
  detectionCache.set(key, info)
  return info
}

/** 探测结果的缓存：键是平台 + 环境来源。 */
const detectionCache = new Map<string, DocumentEngineInfo>()

/**
 * 真探一次（不走缓存）。
 * @param options - 探测选项。
 * @returns 引擎信息。
 */
function probeEngine(options: DetectEngineOptions): DocumentEngineInfo {
  if (hasWordInstalled(options)) {
    return { kind: 'word', converterId: 'word-com', label: 'Microsoft Word' }
  }
  if (findSoffice(options) !== undefined) {
    return { kind: 'libreoffice', converterId: 'soffice', label: 'LibreOffice' }
  }
  return { kind: 'none', converterId: 'unavailable', label: '没装' }
}

/**
 * 清掉探测缓存。
 *
 * 给「用户刚装完 Office」的场景用：装完不重启也能立刻用上。
 */
export function resetDocumentEngineCache(): void {
  detectionCache.clear()
}

/**
 * 造一个转换器：按本机有的引擎挑。
 *
 * 都没有时返回「永远报没装引擎」的转换器——**不假装能转**。
 * @param options - 探测选项。
 * @returns 转换器。
 */
export function createDocumentConverter(options: DetectEngineOptions = {}): DocumentConverter {
  const engine = detectDocumentEngine(options)
  if (engine.kind === 'word') {
    return new WordComConverter(options)
  }
  if (engine.kind === 'libreoffice') {
    return new SofficeConverter(options)
  }
  return {
    id: 'unavailable',
    convert: async () => {
      throw new DocumentError(
        'ENGINE_UNAVAILABLE',
        '本机没装文档转换引擎。装 Microsoft Word（Windows）或 LibreOffice 就能转。',
      )
    },
  }
}
