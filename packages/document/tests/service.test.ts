/**
 * 文档转换服务：授权、白名单、上限、缓存、落盘、降级。
 *
 * 每条用例都断言**具体行为**（错误码、转换器被调了几次、文件落在哪、返回什么），
 * 而不是「没抛错」。
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DocumentConversionService,
  DocumentError,
  engineUnavailableError,
  isDocumentError,
  unavailableConverter,
} from '../src/index.ts'
import { createFakeConverter, createTempDir, fakePdf } from './helpers.ts'

/** 当前测试的临时目录。 */
let dir: { path: string; dispose: () => void } | undefined

afterEach(() => {
  dir?.dispose()
  dir = undefined
})

/** 一份最小输入。 */
function source(overrides: { bytes?: Uint8Array; mediaType?: string; name?: string } = {}): {
  bytes: Uint8Array
  mediaType: string
  name?: string
} {
  return {
    bytes: overrides.bytes ?? new Uint8Array([1, 2, 3, 4]),
    mediaType: overrides.mediaType ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ...(overrides.name === undefined ? {} : { name: overrides.name }),
  }
}

/** 抓一次失败的错误码。 */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    if (isDocumentError(error)) return error.code
    return undefined
  }
}

describe('边界先行', () => {
  it('没授权 → NOT_AUTHORIZED，而且一个字节都没碰', async () => {
    dir = createTempDir()
    const fake = createFakeConverter()
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    const code = await codeOf(() => service.convert({ source: source(), authorized: false }))

    expect(code).toBe('NOT_AUTHORIZED')
    expect(fake.calls()).toBe(0)
  })

  it('类型不在白名单 → UNSUPPORTED_TYPE，不调转换器', async () => {
    dir = createTempDir()
    const fake = createFakeConverter()
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    const code = await codeOf(() =>
      service.convert({ source: source({ mediaType: 'image/png', name: 'a.png' }), authorized: true }),
    )

    expect(code).toBe('UNSUPPORTED_TYPE')
    expect(fake.calls()).toBe(0)
  })

  it('类型不对且没有文件名：文案里就说类型，不提文件名', async () => {
    dir = createTempDir()
    const service = new DocumentConversionService({
      converter: createFakeConverter().converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    let caught: unknown
    try {
      await service.convert({ source: source({ mediaType: 'image/png' }), authorized: true })
    } catch (error) {
      caught = error
    }

    expect((caught as DocumentError).message).toContain('image/png')
    expect((caught as DocumentError).message).not.toContain('文件名')
  })

  it('超过大小上限 → INPUT_TOO_LARGE，不调转换器', async () => {
    dir = createTempDir()
    const fake = createFakeConverter()
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
      policy: { maxInputBytes: 3 },
    })

    const code = await codeOf(() => service.convert({ source: source(), authorized: true }))

    expect(code).toBe('INPUT_TOO_LARGE')
    expect(fake.calls()).toBe(0)
  })

  it('空文件 → INVALID_INPUT', async () => {
    dir = createTempDir()
    const service = new DocumentConversionService({
      converter: createFakeConverter().converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    const code = await codeOf(() => service.convert({ source: source({ bytes: new Uint8Array(0) }), authorized: true }))

    expect(code).toBe('INVALID_INPUT')
  })
})

describe('转换与落盘', () => {
  it('转出来了：给出 PDF、落盘、并说清不是缓存', async () => {
    dir = createTempDir()
    const fake = createFakeConverter({ pages: 3 })
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    const outcome = await service.convert({ source: source({ name: 'a.docx' }), authorized: true })

    expect(outcome.fromCache).toBe(false)
    expect(outcome.pages).toBe(3)
    expect(Buffer.from(outcome.pdf).toString('utf8')).toContain('%PDF-1.7')
    expect(existsSync(outcome.path)).toBe(true)
    expect(outcome.path.startsWith(dir.path)).toBe(true)
  })

  it('转换器拿到的是归一化后的类型与文件名', async () => {
    dir = createTempDir()
    const fake = createFakeConverter()
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    await service.convert({
      source: source({ mediaType: 'application/octet-stream', name: 'a.odt' }),
      authorized: true,
    })

    const input = fake.lastInput()
    expect(input?.mediaType).toBe('application/vnd.oasis.opendocument.text')
    expect(input?.name).toBe('a.odt')
  })

  it('转换器返回的不是 PDF → CONVERSION_FAILED', async () => {
    dir = createTempDir()
    const fake = createFakeConverter({ pdf: new Uint8Array([1, 2, 3]) })
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    const code = await codeOf(() => service.convert({ source: source(), authorized: true }))

    expect(code).toBe('CONVERSION_FAILED')
  })

  it('转换器自己抛错 → CONVERSION_FAILED，并带上原因', async () => {
    dir = createTempDir()
    const fake = createFakeConverter({ failWith: new Error('引擎崩了') })
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    let caught: unknown
    try {
      await service.convert({ source: source(), authorized: true })
    } catch (error) {
      caught = error
    }

    expect(isDocumentError(caught, 'CONVERSION_FAILED')).toBe(true)
    expect((caught as DocumentError).message).toContain('引擎崩了')
  })

  it('转换器抛的不是 Error 对象 → 也报 CONVERSION_FAILED', async () => {
    dir = createTempDir()
    const fake = createFakeConverter({ failWith: '就是崩了' })
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    let caught: unknown
    try {
      await service.convert({ source: source(), authorized: true })
    } catch (error) {
      caught = error
    }

    expect(isDocumentError(caught, 'CONVERSION_FAILED')).toBe(true)
    expect((caught as DocumentError).message).toContain('就是崩了')
  })

  it('页数超上限 → PAGE_LIMIT_EXCEEDED，且不落盘', async () => {
    dir = createTempDir()
    const fake = createFakeConverter({ pages: 99 })
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
      policy: { maxPages: 10 },
    })

    const code = await codeOf(() => service.convert({ source: source(), authorized: true }))

    expect(code).toBe('PAGE_LIMIT_EXCEEDED')
    expect(existsSync(join(dir.path, 'x'))).toBe(false)
  })
})

describe('缓存', () => {
  it('同样的输入第二次 → 命中缓存，不再调转换器', async () => {
    dir = createTempDir()
    const fake = createFakeConverter()
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    const first = await service.convert({ source: source(), authorized: true })
    const second = await service.convert({ source: source(), authorized: true })

    expect(first.fromCache).toBe(false)
    expect(second.fromCache).toBe(true)
    expect(fake.calls()).toBe(1)
    expect(second.key).toBe(first.key)
    expect(Buffer.from(second.pdf).toString('utf8')).toBe(Buffer.from(first.pdf).toString('utf8'))
  })

  it('内容不同 → 不命中，各转一次', async () => {
    dir = createTempDir()
    const fake = createFakeConverter()
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    await service.convert({ source: source(), authorized: true })
    const second = await service.convert({
      source: source({ bytes: new Uint8Array([9, 9, 9]) }),
      authorized: true,
    })

    expect(second.fromCache).toBe(false)
    expect(fake.calls()).toBe(2)
  })

  it('换了转换器 → 不命中旧的缓存', async () => {
    dir = createTempDir()
    const service = new DocumentConversionService({
      converter: createFakeConverter({ id: 'engine-a' }).converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })
    await service.convert({ source: source(), authorized: true })

    const other = createFakeConverter({ id: 'engine-b' })
    const second = new DocumentConversionService({
      converter: other.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })
    const outcome = await second.convert({ source: source(), authorized: true })

    expect(outcome.fromCache).toBe(false)
    expect(other.calls()).toBe(1)
  })
})

describe('时限与取消', () => {
  it('转换超时 → TIMEOUT', async () => {
    dir = createTempDir()
    const fake = createFakeConverter({ delayMs: 5_000 })
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
      policy: { timeoutMs: 100 },
    })

    const code = await codeOf(() => service.convert({ source: source(), authorized: true }))

    expect(code).toBe('TIMEOUT')
  })

  it('取消 → CANCELLED', async () => {
    dir = createTempDir()
    const fake = createFakeConverter({ delayMs: 5_000 })
    const service = new DocumentConversionService({
      converter: fake.converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })
    const controller = new AbortController()

    const pending = codeOf(() => service.convert({ source: source(), authorized: true, signal: controller.signal }))
    setTimeout(() => controller.abort(), 50)

    expect(await pending).toBe('CANCELLED')
  })

  it('开始前就已经取消了 → CANCELLED', async () => {
    dir = createTempDir()
    const service = new DocumentConversionService({
      converter: createFakeConverter({ delayMs: 5_000 }).converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })
    const controller = new AbortController()
    controller.abort()

    const code = await codeOf(() => service.convert({ source: source(), authorized: true, signal: controller.signal }))

    expect(code).toBe('CANCELLED')
  })
})

describe('没装引擎', () => {
  it('报 ENGINE_UNAVAILABLE，并说清装什么', async () => {
    dir = createTempDir()
    const service = new DocumentConversionService({
      converter: unavailableConverter(),
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    let caught: unknown
    try {
      await service.convert({ source: source(), authorized: true })
    } catch (error) {
      caught = error
    }

    expect(isDocumentError(caught, 'ENGINE_UNAVAILABLE')).toBe(true)
    expect((caught as DocumentError).message).toContain('LibreOffice')
    expect((caught as DocumentError).message).toContain('PATH')
  })

  it('engineUnavailableError 本身带着安装说明', () => {
    const error = engineUnavailableError('soffice 不在 PATH 里')
    expect(error.code).toBe('ENGINE_UNAVAILABLE')
    expect(error.message).toContain('soffice 不在 PATH 里')
    expect(error.message).toContain('brew install --cask libreoffice')
  })
})

describe('产物目录', () => {
  it('没给目录 → OUTPUT_DIR_INVALID', () => {
    expect(
      () =>
        new DocumentConversionService({
          converter: createFakeConverter().converter,
          outputDir: '  ',
        }),
    ).toThrow(DocumentError)
  })

  it('落在系统临时目录里 → OUTPUT_DIR_INVALID（临时目录会被清）', () => {
    const temp = createTempDir()
    dir = temp
    expect(
      () =>
        new DocumentConversionService({
          converter: createFakeConverter().converter,
          outputDir: temp.path,
        }),
    ).toThrow(DocumentError)
  })

  it('明说 allowTemporaryOutputDir 就能用', () => {
    const temp = createTempDir()
    dir = temp
    const service = new DocumentConversionService({
      converter: createFakeConverter().converter,
      outputDir: temp.path,
      allowTemporaryOutputDir: true,
    })
    expect(service.outputDir).toBe(temp.path)
  })

  it('边界参数能读出来', () => {
    const temp = createTempDir()
    dir = temp
    const service = new DocumentConversionService({
      converter: createFakeConverter().converter,
      outputDir: temp.path,
      allowTemporaryOutputDir: true,
      policy: { maxPages: 7 },
    })
    expect(service.policy.maxPages).toBe(7)
  })

  it('产物目录正好是系统临时目录 → 也拒', () => {
    expect(
      () =>
        new DocumentConversionService({
          converter: createFakeConverter().converter,
          outputDir: tmpdir(),
        }),
    ).toThrow(DocumentError)
  })

  it('转换出来的 PDF 落在宿主给的目录里', async () => {
    dir = createTempDir()
    const service = new DocumentConversionService({
      converter: createFakeConverter({ pdf: fakePdf('ry') }).converter,
      outputDir: dir.path,
      allowTemporaryOutputDir: true,
    })

    const outcome = await service.convert({ source: source(), authorized: true })

    expect(outcome.path.startsWith(dir.path)).toBe(true)
    expect(existsSync(outcome.path)).toBe(true)
  })
})
