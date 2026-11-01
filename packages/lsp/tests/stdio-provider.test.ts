/**
 * stdio provider：真的把一个子进程拉起来，走真的帧协议。
 *
 * 这一组用例是这个包的核心价值所在：握手顺序、`didOpen` 送过去的到底是哪份文本、
 * 崩了之后会不会重起、服务器没装会怎么讲——这些只有真起一个进程才看得见。
 *
 * 对端是 `tests/fixtures/fake-lsp-server.mjs`：它说的是真话（按字节数写帧头、
 * 走 `initialize` → `initialized` → `didOpen` → 请求的真顺序）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LspError,
  LspService,
  languageIdFor,
  pathToUri,
  readServerOperations,
  type StdioLspProvider,
  type StdioLspProviderConfig,
  type StdioLspProviderOptions,
  StdioLspProvider as StdioProvider,
} from '../src/index.ts'

/** 假 server 的绝对路径：测试真的把它当子进程拉起来。 */
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))

const providers: StdioLspProvider[] = []
const temps: string[] = []

afterEach(async () => {
  // 断言之外的无条件兜底：进程要是还活着，先收掉再走。
  while (providers.length > 0) {
    await providers.pop()?.stop()
  }
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir === undefined) continue
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 被杀掉的子进程退出后，Windows 释放目录句柄会滞后一拍。
    }
  }
})

/** 造一个临时目录。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-lsp-'))
  temps.push(dir)
  return dir
}

/**
 * 起一个指向假 server 的 provider。
 *
 * 环境变量写在配置里（那是「这个语言服务器怎么跑」的一部分），provider 选项留给
 * 时限、目录这类运行时的东西。
 * @param config - 配置的补充部分。
 * @param options - provider 选项的补充部分。
 * @returns provider。
 */
function makeProvider(
  config: Partial<StdioLspProviderConfig> = {},
  options: StdioLspProviderOptions = {},
): StdioLspProvider {
  const provider = new StdioProvider(
    { command: process.execPath, args: [FIXTURE], extensions: ['.ts'], ...config },
    { timeoutMs: 8_000, ...options },
  )
  providers.push(provider)
  return provider
}

/**
 * 读假 server 记下来的消息。
 * @param logPath - 日志文件。
 * @returns 消息列表。
 */
function readLog(logPath: string): Record<string, unknown>[] {
  const text = readFileSync(logPath, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * 等日志文件里出现某个方法名（子进程写文件与测试读之间有 race）。
 * @param logPath - 日志文件。
 * @param method - 要等的方法名。
 * @returns 等到了就是 true。
 */
async function waitForMethod(logPath: string, method: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (readLog(logPath).some((entry) => entry.method === method)) return true
    } catch {
      // 文件还没建出来，继续等。
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
  }
  return false
}

/**
 * 把失败原样抓下来，用来断言错误的种类与文案。
 * @param promise - 会失败的 promise。
 * @returns 抛出来的东西。
 */
async function capture(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

/** 写一个 .ts 文件，返回它的路径。 */
function writeSource(dir: string, name = 'app.ts', text = 'export const a = 1\n'): string {
  const file = join(dir, name)
  writeFileSync(file, text, 'utf8')
  return file
}

describe('stdio 语言服务器 provider', () => {
  it('握手顺序是 initialize → initialized → didOpen → 请求', async () => {
    const dir = tempDir()
    const logPath = join(dir, 'log.jsonl')
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_LOG: logPath } })

    await provider.definition(file, { line: 0, character: 0 })

    const methods = readLog(logPath).map((entry) => entry.method)
    expect(methods).toEqual(['initialize', 'initialized', 'textDocument/didOpen', 'textDocument/definition'])
  })

  it('didOpen 送过去的是文件真正的内容', async () => {
    const dir = tempDir()
    const logPath = join(dir, 'log.jsonl')
    const file = writeSource(dir, 'app.ts', 'export const 名字 = 1\n')
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_LOG: logPath } })

    await provider.definition(file, { line: 0, character: 0 })

    const opened = readLog(logPath).find((entry) => entry.method === 'textDocument/didOpen')
    const params = opened?.params as { textDocument: { uri: string; text: string; languageId: string } }
    expect(params.textDocument.text).toBe('export const 名字 = 1\n')
    expect(params.textDocument.languageId).toBe('typescript')
    expect(params.textDocument.uri).toBe(pathToUri(file))
  })

  it('同一个文件不会被反复 didOpen', async () => {
    const dir = tempDir()
    const logPath = join(dir, 'log.jsonl')
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_LOG: logPath } })

    await provider.definition(file, { line: 0, character: 0 })
    await provider.references(file, { line: 0, character: 0 })

    const opens = readLog(logPath).filter((entry) => entry.method === 'textDocument/didOpen')
    expect(opens).toHaveLength(1)
  })

  it('跳定义：位置被归一化成 uri + 行 + 列', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir })

    const locations = await provider.definition(file, { line: 0, character: 0 })

    expect(locations).toHaveLength(1)
    expect(locations[0]?.uri).toBe(pathToUri(file))
    expect(locations[0]?.line).toBe(42)
    expect(locations[0]?.character).toBe(8)
  })

  it('找引用：跨文件的引用也在结果里', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir })

    const locations = await provider.references(file, { line: 0, character: 0 })

    expect(locations).toHaveLength(2)
    expect(locations[0]?.line).toBe(7)
    expect(locations[1]?.uri).toBe('file:///elsewhere/ref.ts')
  })

  it('找实现：位置被归一化', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir })

    const locations = await provider.implementations(file, { line: 0, character: 0 })

    expect(locations).toHaveLength(1)
    expect(locations[0]?.uri).toBe('file:///elsewhere/impl.ts')
    expect(locations[0]?.line).toBe(3)
  })

  it('读 hover：Markdown 文本原样带出来', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir })

    const hover = await provider.hover(file, { line: 0, character: 0 })

    expect(hover?.contents).toBe('```ts\nconst answer: number\n```')
    expect(hover?.range?.start.line).toBe(0)
  })

  it('服务器不支持的操作：报 unsupported-operation，不去打服务器', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_CAPABILITIES: 'no-implementation' } })

    const error = await capture(provider.implementations(file, { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('unsupported-operation')
    expect((error as LspError).message).toContain('implementations')
  })

  it('能力跟着服务器自述走', async () => {
    const dir = tempDir()
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_CAPABILITIES: 'no-implementation' } })

    await provider.start()

    expect(provider.capabilities.operations).toEqual(['definition', 'references', 'hover'])
    expect(provider.status).toBe('running')
  })

  it('配置限定了操作时，能力跟着配置收窄', async () => {
    const dir = tempDir()
    const provider = makeProvider({ rootPath: dir, operations: ['definition'] })

    await provider.start()

    expect(provider.capabilities.operations).toEqual(['definition'])
  })

  it('语言服务器命令不在 PATH 上：说找不到，不静默降级', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ command: 'ryharness-lsp-not-installed', args: [], rootPath: dir })

    const error = await capture(provider.definition(file, { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('command-not-found')
    expect((error as LspError).message).toContain('ryharness-lsp-not-installed')
    expect(provider.status).toBe('unavailable')
  })

  it('服务器不回包：报超时', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_MODE: 'slow' } }, { timeoutMs: 800 })

    const error = await capture(provider.definition(file, { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('timeout')
    expect((error as LspError).message).toContain('800ms')
  })

  it('服务器崩了：provider 变成不可用并给出原因', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_MODE: 'crash' } })

    const error = await capture(provider.definition(file, { line: 0, character: 0 }))

    expect((error as LspError).code).toBe('server-unavailable')
    expect(provider.status).toBe('unavailable')
    expect(provider.unavailableReason).toContain('退出码 3')
  })

  it('崩了之后下一次调用自动重起', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    // 标记文件让「只崩一次」跨进程有效：重起的是新进程，内存里的标志不算数。
    const marker = join(dir, 'crashed.marker')
    const provider = makeProvider({
      rootPath: dir,
      env: { LSP_FIXTURE_MODE: 'crash-once', LSP_FIXTURE_MARKER: marker },
    })

    const first = await capture(provider.definition(file, { line: 0, character: 0 }))
    expect((first as LspError).code).toBe('server-unavailable')
    expect(provider.status).toBe('unavailable')

    const locations = await provider.definition(file, { line: 0, character: 0 })

    expect(locations).toHaveLength(1)
    expect(locations[0]?.line).toBe(42)
    expect(provider.status).toBe('running')
  })

  it('autoRestart 关掉之后不再重起，直接报不可用', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_MODE: 'crash' } }, { autoRestart: false })

    await capture(provider.definition(file, { line: 0, character: 0 }))
    const error = await capture(provider.definition(file, { line: 0, character: 0 }))

    expect((error as LspError).code).toBe('server-unavailable')
    expect((error as LspError).message).toContain('退出码 3')
  })

  it('握手期间服务器退出：报服务器不可用', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_MODE: 'exit-on-init' } })

    const error = await capture(provider.definition(file, { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('server-unavailable')
    expect(provider.status).toBe('unavailable')
  })

  it('服务器说了不是协议的话：报协议错误', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_MODE: 'garbage' } })

    const error = await capture(provider.definition(file, { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('protocol-error')
  })

  it('文件不在工作区：报 file-not-in-workspace', async () => {
    const dir = tempDir()
    const outside = tempDir()
    const file = writeSource(outside)
    const provider = makeProvider({ rootPath: dir })

    const error = await capture(provider.definition(file, { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('file-not-in-workspace')
    expect((error as LspError).message).toContain('工作区')
  })

  it('文件读不到：报 file-not-found', async () => {
    const dir = tempDir()
    const provider = makeProvider({ rootPath: dir })

    const error = await capture(provider.definition(join(dir, '不存在.ts'), { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('file-not-found')
  })

  it('关掉时先发 shutdown 再发 exit', async () => {
    const dir = tempDir()
    const logPath = join(dir, 'log.jsonl')
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_LOG: logPath } })

    await provider.start()
    await provider.stop()

    expect(await waitForMethod(logPath, 'exit')).toBe(true)
    const methods = readLog(logPath).map((entry) => entry.method)
    expect(methods).toContain('shutdown')
    expect(methods.indexOf('shutdown')).toBeLessThan(methods.indexOf('exit'))
    expect(provider.status).toBe('stopped')
  })

  it('没配时延时也能用：默认给一个够用的时限', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = new StdioProvider(
      { command: process.execPath, args: [FIXTURE], extensions: ['.ts'], rootPath: dir },
      {},
    )
    providers.push(provider)

    const locations = await provider.definition(file, { line: 0, character: 0 })

    expect(locations).toHaveLength(1)
  })

  it('重复 start 不会起第二个进程', async () => {
    const dir = tempDir()
    const logPath = join(dir, 'log.jsonl')
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_LOG: logPath } })

    await provider.start()
    await provider.start()

    const initializes = readLog(logPath).filter((entry) => entry.method === 'initialize')
    expect(initializes).toHaveLength(1)
  })

  it('并发 start 只握手一次', async () => {
    const dir = tempDir()
    const logPath = join(dir, 'log.jsonl')
    const provider = makeProvider({ rootPath: dir, env: { LSP_FIXTURE_LOG: logPath } })

    await Promise.all([provider.start(), provider.start()])

    const initializes = readLog(logPath).filter((entry) => entry.method === 'initialize')
    expect(initializes).toHaveLength(1)
    expect(provider.status).toBe('running')
  })

  it('dispose 把语言服务器收掉', async () => {
    const dir = tempDir()
    const provider = makeProvider({ rootPath: dir })

    await provider.start()
    await provider.dispose()

    expect(provider.status).toBe('stopped')
  })

  it('没配工作区时，文件在哪儿都能问', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider()

    const locations = await provider.definition(file, { line: 0, character: 0 })

    expect(locations).toHaveLength(1)
  })

  it('文件就是工作区根目录本身：那是目录，读不了', async () => {
    const dir = tempDir()
    const provider = makeProvider({ rootPath: dir })

    const error = await capture(provider.definition(dir, { line: 0, character: 0 }))

    expect((error as LspError).code).toBe('file-not-found')
  })

  it('restart 之后还能继续用', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir })

    await provider.start()
    await provider.restart()
    const locations = await provider.definition(file, { line: 0, character: 0 })

    expect(locations).toHaveLength(1)
    expect(provider.status).toBe('running')
  })

  it('接进服务层：按扩展名挑到它，导航照常', async () => {
    const dir = tempDir()
    const file = writeSource(dir)
    const provider = makeProvider({ rootPath: dir })
    const service = new LspService()
    service.register(provider)

    expect(service.providerFor(file)?.id).toBe(provider.id)
    const locations = await service.definition(file, { line: 0, character: 0 })

    expect(locations).toHaveLength(1)
    expect(locations[0]?.line).toBe(42)
  })

  it('服务层遇到没配语言服务器的文件：报 no-provider', async () => {
    const dir = tempDir()
    const provider = makeProvider({ rootPath: dir })
    const service = new LspService()
    service.register(provider)

    const error = await capture(service.definition(join(dir, 'x.py'), { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('no-provider')
  })
})

describe('stdio provider 的小工具', () => {
  it('languageId 按扩展名猜，认不出来的用扩展名本身', () => {
    expect(languageIdFor('a/b.ts')).toBe('typescript')
    expect(languageIdFor('a/b.py')).toBe('python')
    expect(languageIdFor('a/b.rs')).toBe('rust')
    expect(languageIdFor('a/b.unknownext')).toBe('unknownext')
    expect(languageIdFor('a/Makefile')).toBe('plaintext')
  })

  it('从 initialize 的回包里读服务器支持哪些操作', () => {
    expect(
      readServerOperations({
        capabilities: {
          definitionProvider: true,
          referencesProvider: {},
          implementationProvider: false,
          hoverProvider: { contentFormat: ['markdown'] },
        },
      }),
    ).toEqual(['definition', 'references', 'hover'])
  })

  it('服务器没报能力时，当它一个都不支持', () => {
    expect(readServerOperations({})).toEqual([])
    expect(readServerOperations({ capabilities: {} })).toEqual([])
    expect(readServerOperations('不是对象')).toEqual([])
  })
})
