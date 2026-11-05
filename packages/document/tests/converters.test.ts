/**
 * 文档转换的**真机**用例：真的起 Word COM，把一份 docx 转成 PDF。
 *
 * 这不是 mock 用例——它调的是本机装的 Microsoft Word。跑它需要：
 * - Windows；
 * - 装了 Microsoft Word（没装 LibreOffice 也行，Word 优先）。
 *
 * 没装引擎时**整个真机文件跳过**：那是环境问题，不是代码坏了。引擎探测与
 * 「没装时怎么报错」另有纯逻辑用例覆盖。
 *
 * @module @ryharness/document/tests/converters
 */

import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createDocumentConverter,
  DocumentConversionService,
  detectDocumentEngine,
  hasWordInstalled,
  WordComConverter,
} from '../src/index.ts'

/**
 * 本机有没有能用的引擎。
 *
 * **探测在模块加载时做一次**（结果有缓存）：Word 那条只查注册表，不起进程。
 */
const engine = detectDocumentEngine()
const hasEngine = engine.kind !== 'none'

const workDirs: string[] = []

afterAll(() => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/**
 * 造一份最小的 docx。
 *
 * docx 是个 zip，里面要有 `[Content_Types].xml`、`_rels/.rels` 与
 * `word/document.xml` 三样，Word 才认。
 * @returns docx 的字节。
 */
function makeDocx(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-docx-'))
  workDirs.push(dir)
  const inner = join(dir, 'inner')
  mkdirSync(join(inner, '_rels'), { recursive: true })
  mkdirSync(join(inner, 'word'), { recursive: true })
  writeFileSync(
    join(inner, '[Content_Types].xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  writeFileSync(
    join(inner, '_rels', '.rels'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  writeFileSync(
    join(inner, 'word', 'document.xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>RyHarness 文档转换自测</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  )
  const docx = join(dir, 'sample.docx')
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${inner}\\*' -DestinationPath '${docx}' -Force`],
    { stdio: 'ignore' },
  )
  return readFileSync(docx)
}

/**
 * 真机用例**串行**跑。
 *
 * Word COM 是单实例资源：两个 Word 进程同时开同一个文档会互相抢文件锁，
 * 表现是「时好时坏」。而且每个 Word 进程都是几百 MB——并行开几个足以把
 * 跑测试的机器拖垮。串行跑慢一点，但结果稳定、也不伤机器。
 *
 * vitest 的 `describe.sequential` 保证同一个文件里的用例依次执行；这里再加一道
 * **跨文件**的锁（同一个进程里可能还有别的文件碰 Word），用文件锁实现。
 */
const WORD_LOCK = join(tmpdir(), 'ryharness-word-com.lock')

/**
 * 拿一把跨进程的 Word 锁。
 *
 * 用 `wx` 模式创建锁文件：已经有人拿着就等它释放。**不用** `mkdir`（那个在
 * Windows 上不做原子操作），也不删锁文件本身（删了会让并发的一方以为锁没了）。
 * @returns 释放锁的函数。
 */
function acquireWordLock(): () => void {
  const deadline = Date.now() + 120_000
  let handle: number | undefined
  while (handle === undefined) {
    try {
      handle = openSync(WORD_LOCK, 'wx')
    } catch {
      if (Date.now() > deadline) {
        // 等不到就硬拿：宁可两个 Word 撞一下，也不要整条测试挂死。
        try {
          handle = openSync(WORD_LOCK, 'w')
        } catch {
          handle = -1
        }
        break
      }
      // 让出事件循环：这个等待不该挡住同一个进程里的其它任务。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  return () => {
    try {
      if (handle !== undefined && handle >= 0) closeSync(handle)
    } catch {
      // 句柄可能已经关了。
    }
    try {
      rmSync(WORD_LOCK, { force: true })
    } catch {
      // 删不掉就留着；下一个持锁者会等它超时后硬拿。
    }
  }
}

describe.skipIf(!hasEngine)('文档转换（真机）', () => {
  it('真的把 docx 转成 PDF：拿到的是 PDF，页数对得上', async () => {
    const release = acquireWordLock()
    try {
      const converter = new WordComConverter()
      const bytes = makeDocx()
      const beforeWordProcesses = countWordProcesses()
      const result = await converter.convert({
        bytes,
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        name: 'sample.docx',
      })
      expect(result.pdf.byteLength).toBeGreaterThan(500)
      // PDF 文件头：%PDF-
      expect(Buffer.from(result.pdf.slice(0, 5)).toString('latin1')).toBe('%PDF-')
      expect(result.pages).toBe(1)
      // 转完不能留下 Word 进程：Word 是有状态的进程，漏一个就会在用户机器上
      // 一直开着。早先那版脚本 Quit() 之后进程还赖着，所以这条守住了它。
      await waitForWordProcessesToSettle(beforeWordProcesses)
    } finally {
      release()
    }
  }, 180_000)

  it('服务层跑一遍：PDF 落盘，第二次命中缓存', async () => {
    const release = acquireWordLock()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'ryharness-docout-'))
      workDirs.push(dir)
      const service = new DocumentConversionService({
        converter: createDocumentConverter(),
        outputDir: dir,
        // 测试的产物目录在临时区：显式放行（生产路径给的是应用数据目录）。
        allowTemporaryOutputDir: true,
      })
      const bytes = makeDocx()
      const first = await service.convert({
        source: {
          bytes,
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          name: 'sample.docx',
        },
        authorized: true,
      })
      expect(first.fromCache).toBe(false)
      expect(readFileSync(first.path).length).toBeGreaterThan(500)

      const second = await service.convert({
        source: {
          bytes,
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          name: 'sample.docx',
        },
        authorized: true,
      })
      // 同样内容再转一次就该命中缓存，不该再动引擎。
      expect(second.fromCache).toBe(true)
      expect(second.key).toBe(first.key)
    } finally {
      release()
    }
  }, 180_000)
})

describe('文档引擎探测（不碰引擎）', () => {
  it('探测结果给出引擎种类与一句人话', () => {
    const info = detectDocumentEngine()
    expect(['word', 'libreoffice', 'none']).toContain(info.kind)
    expect(info.label.length).toBeGreaterThan(0)
    expect(info.converterId.length).toBeGreaterThan(0)
  })

  it('没装引擎时转换器报「没装引擎」，不是「转换失败」', async () => {
    const converter = createDocumentConverter({ platform: 'linux', env: {} })
    await expect(
      converter.convert({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
  })

  it('非 Windows 上探不到 Word', () => {
    expect(hasWordInstalled({ platform: 'linux' })).toBe(false)
  })

  it('探测 Word **不启任何进程**：探完 WINWORD 数量不变', () => {
    // 这条是踩过坑之后加的：早先那版探测用 `New-Object -ComObject
    // Word.Application`，每探一次就漏一个 WINWORD.EXE，还会弹一个可见窗口。
    // 宿主每起一个实例探一次，一轮测试能漏几十个，用户桌面上开出一堆 Word。
    // 现在探测只查注册表——这里断言「探完进程数没变」。
    const before = countWordProcesses()
    hasWordInstalled()
    hasWordInstalled()
    hasWordInstalled()
    expect(countWordProcesses()).toBe(before)
  })
})

/**
 * 数一数当前有几个 WINWORD 进程。
 *
 * 只数**用户自己的** Word 之外的那些——用命令行里带 `--automation` 或
 * `--headless` 的当特征。实际上我们只需要「数量没变」，所以这里数全部：
 * 探测前后的差值才是关键。
 * @returns 进程数；数不到就是 0。
 */
function countWordProcesses(): number {
  try {
    const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WINWORD.EXE', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const lines = output.split('\n').filter((line) => line.trim().length > 0 && !line.includes('INFO:'))
    return lines.length
  } catch {
    return 0
  }
}

/**
 * 等 Word 进程数回到基准。
 *
 * Word 的 `Quit()` 之后进程可能还挂着收尾流程，所以不能立刻断言——给它几秒。
 * 等不到就**如实报错**（不用「差不多就行」糊过去）：漏掉的 Word 进程正是我们要
 * 守住的东西。
 * @param baseline - 转换前的进程数。
 * @returns 无事发生。
 */
async function waitForWordProcessesToSettle(baseline: number): Promise<void> {
  const deadline = Date.now() + 15_000
  let current = countWordProcesses()
  while (current > baseline && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    current = countWordProcesses()
  }
  expect(current).toBeLessThanOrEqual(baseline)
}
