/**
 * 转换器引擎挑选的用例：**不碰引擎**的那部分逻辑。
 *
 * 判据只有三条：
 * - 装了 Word 就用 Word（不用额外装 LibreOffice）；
 * - 没 Word 但装了 soffice 就用 soffice；
 * - 两个都没有就说「没装」，**不假装能转**。
 *
 * 真机转换另有用例（`converters.test.ts`）。
 */
import { describe, expect, it } from 'vitest'
import { createDocumentConverter, detectDocumentEngine, resetDocumentEngineCache } from '../src/index.ts'

describe('转换器引擎挑选', () => {
  it('非 Windows 上探不到 Word', () => {
    resetDocumentEngineCache()
    const engine = detectDocumentEngine({ platform: 'linux', env: {} })
    expect(['libreoffice', 'none']).toContain(engine.kind)
    resetDocumentEngineCache()
  })

  it('两个引擎都没有时：说「没装」，转换器报 ENGINE_UNAVAILABLE', async () => {
    resetDocumentEngineCache()
    const converter = createDocumentConverter({ platform: 'linux', env: {} })
    await expect(
      converter.convert({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    resetDocumentEngineCache()
  })

  it('探测结果缓存着：同样的输入只探一次', () => {
    resetDocumentEngineCache()
    const first = detectDocumentEngine({ platform: 'linux', env: {} })
    const second = detectDocumentEngine({ platform: 'linux', env: {} })
    expect(second).toBe(first)
    resetDocumentEngineCache()
  })

  it('探测结果带一句人话与一个转换器 id', () => {
    resetDocumentEngineCache()
    const engine = detectDocumentEngine({ platform: 'linux', env: {} })
    expect(engine.label.length).toBeGreaterThan(0)
    expect(engine.converterId.length).toBeGreaterThan(0)
    resetDocumentEngineCache()
  })
})
