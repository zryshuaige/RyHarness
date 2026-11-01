/**
 * 测试用的假转换器与临时目录。
 *
 * 假转换器是**真的被调用**的：服务怎么调它、传了什么、有没有重复调（缓存命中就不该再调），
 * 这些都要看得见，所以这里记录调用次数与最后一次入参。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocumentConverter, DocumentConvertInput } from '../src/index.ts'

/** 一份最小的 PDF（只要文件头对得上就行）。 */
export function fakePdf(marker = 'ry'): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% ${marker}\n%%EOF\n`)
}

/** 假转换器的行为。 */
export interface FakeConverterOptions {
  /** 转换器 id（会进缓存键）。 */
  id?: string
  /** 转出来的 PDF。 */
  pdf?: Uint8Array
  /** 报出来的页数。 */
  pages?: number
  /** 转之前先睡多久（毫秒）。 */
  delayMs?: number
  /** 直接抛这个错（可以是任意值，转换器抛什么都不该把服务带崩）。 */
  failWith?: unknown
}

/** 一个假转换器。 */
export interface FakeConverter {
  /** 转换器本身。 */
  readonly converter: DocumentConverter
  /** 被调了几次。 */
  readonly calls: () => number
  /** 最后一次拿到的入参。 */
  readonly lastInput: () => DocumentConvertInput | undefined
}

/** 造一个假转换器。 */
export function createFakeConverter(options: FakeConverterOptions = {}): FakeConverter {
  let calls = 0
  let last: DocumentConvertInput | undefined
  const converter: DocumentConverter = {
    id: options.id ?? 'fake',
    convert: async (input: DocumentConvertInput) => {
      calls += 1
      last = input
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      if (options.failWith !== undefined) throw options.failWith
      const pdf = options.pdf ?? fakePdf()
      return options.pages === undefined ? { pdf } : { pdf, pages: options.pages }
    },
  }
  return {
    converter,
    calls: () => calls,
    lastInput: () => last,
  }
}

/** 造一个临时目录（测试结束要收掉）。 */
export function createTempDir(prefix = 'ry-document-test-'): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return {
    path,
    dispose: () => {
      rmSync(path, { recursive: true, force: true })
    },
  }
}
