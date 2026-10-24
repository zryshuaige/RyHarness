/**
 * Piper 离线语音：安装状态机、镜像回退、供应链完整性（官方 digest 锁定）、并发幂等、
 * 串行合成与插件生命周期。
 *
 * 下载与进程都用假实现：这里量的是状态机与队列的行为，不是网络或 CPU。真实下载
 * 与真 spawn 在单独的真机验证里跑，避免单测依赖外网。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPiperProvider,
  PIPER_BINARY_MIRRORS,
  PIPER_STATUS_PATH,
  type PiperChild,
  type PiperFetch,
  PiperInstaller,
  type PiperInstallerOptions,
  PiperRunner,
  type PiperSpawn,
  RyHarnessServer,
  type VoiceProvider,
} from '@ryharness/server'
import { VOICE_ERROR_CODES } from '@ryharness/voice'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tmpDirs: string[] = []

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-piper-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/** 只要求长度下限的测试用响应。 */
function bytesResponse(size: number): Response {
  return new Response(new Uint8Array(size).fill(7), {
    status: 200,
    headers: { 'content-length': String(size) },
  })
}

/** 假 zip：解压出 `piper/piper.exe` 与一个依赖文件，验证会被摊平到安装根。 */
async function fakeExtract(_zipPath: string, destination: string): Promise<void> {
  const tools = join(destination, 'piper')
  mkdirSync(tools, { recursive: true })
  writeFileSync(join(tools, 'piper.exe'), Buffer.from([1, 2, 3]))
  writeFileSync(join(tools, 'espeak-ng-data.txt'), 'data')
}

function installerWith(
  dataDirPath: string,
  fetchImpl: NonNullable<PiperInstallerOptions['fetchImpl']>,
  overrides: Partial<PiperInstallerOptions> = {},
): PiperInstaller {
  return new PiperInstaller({
    dataDir: dataDirPath,
    platform: 'win32',
    fetchImpl,
    extractZip: fakeExtract,
    limits: { binary: 4, model: 4, config: 4 },
    totalBytesEstimate: 100,
    // 单测默认走单连接，保持「每个文件一次下载」的断言简单；分段另有专门用例。
    parallelChunks: 1,
    ...overrides,
  })
}

/** 假 zip 字节：digest 用例里「API 声明的摘要」与「实际下载的内容」都从它派生。 */
const ZIP_BYTES = new Uint8Array(64).fill(7)

/** 与被测代码同一套算法生成摘要，用例里两边（声明/实际）共用，比对才可复现。 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Releases API 的假响应：digest 缺省时模拟「资产没有 digest 字段」（2024 前的 API）。 */
function apiResponse(digest?: string): Response {
  const asset = { name: 'piper_windows_amd64.zip', ...(digest === undefined ? {} : { digest: `sha256:${digest}` }) }
  return new Response(JSON.stringify({ assets: [asset] }), { headers: { 'content-type': 'application/json' } })
}

/**
 * 按 URL 前缀路由的假源：把 Releases API、官方直连、两个公共代理与 HF 模型源拆开，
 * 用例只登记关心的腿，没登记的一律 404。urls 原样记录，用来断言「代理有没有被碰过」。
 */
function routedFetch(sources: {
  api?: () => Response
  official?: () => Response
  proxy?: () => Response
  model?: () => Response
}): { fetch: PiperFetch; urls: string[] } {
  const urls: string[] = []
  const notFound = (): Response => new Response('not found', { status: 404 })
  const impl: PiperFetch = async (url) => {
    urls.push(url)
    if (url.includes('api.github.com')) return (sources.api ?? notFound)()
    if (url.startsWith('https://github.com/')) return (sources.official ?? notFound)()
    if (url.includes('ghproxy.net') || url.includes('gh-proxy.com')) return (sources.proxy ?? notFound)()
    return (sources.model ?? (() => bytesResponse(4)))()
  }
  return { fetch: impl, urls }
}

/** 一段最小合法 WAV 头（readWav 只校验 RIFF/WAVE）。 */
const WAV_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([36, 0, 0, 0]),
  Buffer.from('WAVE'),
  Buffer.from('fmt '),
  Buffer.alloc(16),
])

interface Mount {
  close(code?: number | null): void
  error(error: Error): void
  stderr(text: string): void
}

interface SpawnHarness {
  spawnImpl: PiperSpawn
  calls: { command: string; args: readonly string[]; stdin: string }[]
  kills: () => number
}

/**
 * 假 spawn：respond 在 writeStdin 时触发（此时 runner 已挂好 close/error 监听），
 * 由用例决定写输出文件、发 stderr、关闭或一直挂着。
 */
function spawnHarness(respond: (call: { args: readonly string[] }, mount: Mount) => void): SpawnHarness {
  const calls: { command: string; args: readonly string[]; stdin: string }[] = []
  let killed = 0
  const spawnImpl: PiperSpawn = (command, args) => {
    const call = { command, args, stdin: '' }
    calls.push(call)
    let onClose: ((code: number | null) => void) | undefined
    let onError: ((error: Error) => void) | undefined
    let onStderr: ((chunk: string) => void) | undefined
    const mount: Mount = {
      close: (code = 0) => {
        onClose?.(code)
      },
      error: (error) => {
        onError?.(error)
      },
      stderr: (text) => {
        onStderr?.(text)
      },
    }
    const child: PiperChild = {
      writeStdin(data) {
        call.stdin += data
        respond(call, mount)
      },
      onStderr(listener) {
        onStderr = listener
      },
      onClose(listener) {
        onClose = listener
      },
      onError(listener) {
        onError = listener
      },
      kill() {
        killed += 1
        mount.close(null)
      },
    }
    return child
  }
  return { spawnImpl, calls, kills: () => killed }
}

describe('PiperInstaller 状态机', () => {
  it('下载成功：官方直连优先、digest 校验通过、文件摊平到 voice/piper 并可直接认成 ready', async () => {
    const urls: string[] = []
    const installer = installerWith(dataDir(), async (url) => {
      urls.push(url)
      // API 声明的摘要与 zip 字节一致 → 校验通过 → 官方直连放行。
      if (url.includes('api.github.com')) return apiResponse(sha256Hex(ZIP_BYTES))
      if (url.endsWith('.zip')) return new Response(ZIP_BYTES)
      return bytesResponse(4)
    })
    const started = installer.startInstall()
    expect(started.state).toBe('downloading')
    expect(started.totalBytes).toBe(100)
    await installer.settled()

    const status = installer.installStatus()
    expect(status.state).toBe('ready')
    expect(status.warning).toBeUndefined()
    expect(status.receivedBytes).toBe(72)
    expect(status.totalBytes).toBeGreaterThanOrEqual(72)
    // 先问官方 API 要摘要，再从 GitHub 官方直连拿 zip；模型文件仍先走 HF 镜像。
    expect(urls).toHaveLength(4)
    expect(urls[0]).toContain('api.github.com/repos/rhasspy/piper/releases/tags/2023.11.14-2')
    expect(urls[1]).toContain('https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip')
    expect(urls[2]).toContain('hf-mirror.com')
    expect(urls[3]).toContain('hf-mirror.com')
    for (const file of [
      'piper.exe',
      'espeak-ng-data.txt',
      'zh_CN-huayan-medium.onnx',
      'zh_CN-huayan-medium.onnx.json',
    ]) {
      expect(existsSync(join(installer.dir, file))).toBe(true)
    }
    // zip 里那层 piper/ 已经被摊平，安装根就是资源目录。
    expect(readFileSync(join(installer.dir, 'piper.exe'))).toEqual(Buffer.from([1, 2, 3]))

    // 第二次启动是幂等的：不再发任何下载请求。
    expect(installer.startInstall().state).toBe('ready')
    expect(urls).toHaveLength(4)
  })

  it('镜像失败继续下一个；全部失败进入 error、清理暂存，重试成功', async () => {
    let fail = true
    const urls: string[] = []
    const root = dataDir()
    const installer = installerWith(root, async (url) => {
      urls.push(url)
      if (fail) return new Response('not found', { status: 404 })
      if (url.includes('api.github.com')) return apiResponse(sha256Hex(ZIP_BYTES))
      if (url.endsWith('.zip')) return new Response(ZIP_BYTES)
      return bytesResponse(4)
    })
    installer.startInstall()
    await installer.settled()
    const failed = installer.installStatus()
    expect(failed.state).toBe('error')
    expect(failed.error).toContain('下载失败')
    // API 也拿不到摘要时代理被禁：二进制只剩官方直连一条腿可试。
    expect(failed.error).toContain('已尝试 1 个镜像')
    expect(failed.error).toContain('只允许官方直连')
    // 失败后不留半成品（正式目录与暂存目录都没有）。
    expect(existsSync(join(root, 'voice', 'piper'))).toBe(false)
    expect(readdirSync(join(root, 'voice')).filter((name) => name.startsWith('.piper-install-'))).toEqual([])

    fail = false
    const before = urls.length
    expect(installer.startInstall().state).toBe('downloading')
    await installer.settled()
    expect(installer.installStatus().state).toBe('ready')
    expect(urls.length).toBeGreaterThan(before)
  })

  it('并发启动只下一份：第二次 POST 拿到同一份 downloading 状态', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let fetchCalls = 0
    const installer = installerWith(dataDir(), async () => {
      fetchCalls += 1
      await gate
      return bytesResponse(4)
    })
    const first = installer.startInstall()
    const second = installer.startInstall()
    expect(first.state).toBe('downloading')
    expect(second.state).toBe('downloading')
    expect(fetchCalls).toBe(1)
    release()
    await installer.settled()
    // API 摘要查询 + 二进制 + 模型 + 配置。
    expect(fetchCalls).toBe(4)
    expect(installer.installStatus().state).toBe('ready')
  })

  it('支持 Range 时分段并发下载，最后拼成完整文件', async () => {
    let fetchCalls = 0
    const installer = installerWith(
      dataDir(),
      async (_url, init) => {
        fetchCalls += 1
        const range = new Headers(init?.headers).get('range')
        if (range === null) return bytesResponse(4)
        const match = /bytes=(\d+)-(\d+)/.exec(range)
        if (match === null) throw new Error(`坏 Range：${range}`)
        const start = Number(match[1])
        const end = Number(match[2])
        if (start === 0 && end === 0) {
          return new Response(new Uint8Array(1), {
            status: 206,
            headers: { 'content-range': 'bytes 0-0/4' },
          })
        }
        return new Response(new Uint8Array(end - start + 1).fill(9), {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/4` },
        })
      },
      { parallelChunks: 2, parallelMinBytes: 4 },
    )
    installer.startInstall()
    await installer.settled()
    expect(installer.installStatus()).toMatchObject({ state: 'ready', receivedBytes: 12 })
    // API 摘要 1 次 + 每个文件（1 次探测 + 2 段）= 10 次请求。
    expect(fetchCalls).toBe(10)
    expect(readFileSync(join(installer.dir, 'zh_CN-huayan-medium.onnx')).length).toBe(4)
  })

  it('非 Windows：state=unsupported 并说清原因，不发起任何下载', async () => {
    let fetched = 0
    const installer = installerWith(
      dataDir(),
      async () => {
        fetched += 1
        return bytesResponse(4)
      },
      { platform: 'darwin' },
    )
    const status = installer.startInstall()
    expect(status.state).toBe('unsupported')
    expect(status.error).toContain('Windows')
    expect(fetched).toBe(0)
  })

  it('插件关闭会中止下载，不留下暂存目录', async () => {
    const root = dataDir()
    const installer = installerWith(root, async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    })
    installer.startInstall()
    installer.dispose()
    await installer.settled()
    expect(installer.installStatus().state).toBe('error')
    expect(readdirSync(join(root, 'voice')).filter((name) => name.startsWith('.piper-install-'))).toEqual([])
  })
})

describe('PiperInstaller 供应链完整性', () => {
  it('digest 匹配：下载后过 SHA-256 再解压，安装成功且状态无「未校验」警示', async () => {
    const { fetch, urls } = routedFetch({
      api: () => apiResponse(sha256Hex(ZIP_BYTES)),
      official: () => new Response(ZIP_BYTES),
    })
    const installer = installerWith(dataDir(), fetch)
    installer.startInstall()
    await installer.settled()
    const status = installer.installStatus()
    expect(status.state).toBe('ready')
    expect(status.warning).toBeUndefined()
    expect(urls[0]).toContain('api.github.com/repos/rhasspy/piper/releases/tags/')
    expect(urls[1]).toContain('https://github.com/rhasspy/piper/releases/download/')
    expect(existsSync(join(installer.dir, 'piper.exe'))).toBe(true)
  })

  it('官方直连失败时允许代理兜底，但字节必须对上官方 digest 才放行', async () => {
    const { fetch, urls } = routedFetch({
      api: () => apiResponse(sha256Hex(ZIP_BYTES)),
      official: () => new Response('boom', { status: 502 }),
      proxy: () => new Response(ZIP_BYTES),
    })
    const installer = installerWith(dataDir(), fetch)
    installer.startInstall()
    await installer.settled()
    expect(installer.installStatus().state).toBe('ready')
    expect(urls.some((url) => url.includes('ghproxy.net'))).toBe(true)
  })

  it('digest 不匹配：拒绝安装、删光下载残留、根本不会走到解压那一步', async () => {
    const root = dataDir()
    let extracts = 0
    const { fetch } = routedFetch({
      // API 声明的是另一份字节的摘要：无论文件从哪来，比对都必然失败。
      api: () => apiResponse(sha256Hex(new Uint8Array(64).fill(9))),
      official: () => new Response(ZIP_BYTES),
    })
    const installer = installerWith(root, fetch, {
      extractZip: async (zipPath, destination) => {
        extracts += 1
        await fakeExtract(zipPath, destination)
      },
    })
    installer.startInstall()
    await installer.settled()
    const status = installer.installStatus()
    expect(status.state).toBe('error')
    expect(status.error).toContain('SHA-256')
    expect(status.error).toContain('篡改')
    expect(extracts).toBe(0)
    expect(existsSync(join(root, 'voice', 'piper'))).toBe(false)
    expect(readdirSync(join(root, 'voice')).filter((name) => name.startsWith('.piper-install-'))).toEqual([])
  })

  it('拿不到 digest：代理一概不碰（哪怕代理上有能下的文件），官方也失败则安装失败', async () => {
    const root = dataDir()
    const { fetch, urls } = routedFetch({
      // 代理上摆着「能下」的 zip——拿不到官方摘要时它根本不该被请求。
      proxy: () => new Response(ZIP_BYTES),
    })
    const installer = installerWith(root, fetch)
    installer.startInstall()
    await installer.settled()
    const status = installer.installStatus()
    expect(status.state).toBe('error')
    expect(status.error).toContain('只允许官方直连')
    expect(urls.some((url) => url.includes('ghproxy.net') || url.includes('gh-proxy.com'))).toBe(false)
    expect(existsSync(join(root, 'voice', 'piper'))).toBe(false)
  })

  it('拿不到 digest：官方直连可用则放行安装，状态明示「未校验哈希」', async () => {
    const { fetch } = routedFetch({
      // API 可达但资产没有 digest 字段（2024 前的 API 就是如此）：与「API 不可达」
      // 走同一条保守路径，只是原因不同。
      api: () => apiResponse(),
      official: () => new Response(ZIP_BYTES),
    })
    const installer = installerWith(dataDir(), fetch)
    installer.startInstall()
    await installer.settled()
    const status = installer.installStatus()
    expect(status.state).toBe('ready')
    expect(status.warning).toContain('未校验哈希')
    expect(existsSync(join(installer.dir, 'piper.exe'))).toBe(true)
  })

  it('二进制镜像表：GitHub 官方直连排第一，两个公共代理只作 fallback', () => {
    expect(PIPER_BINARY_MIRRORS[0]).toContain('https://github.com/rhasspy/piper/releases/download/')
    expect(PIPER_BINARY_MIRRORS[0]).not.toContain('ghproxy')
    expect(
      PIPER_BINARY_MIRRORS.filter((url) => {
        return url.includes('ghproxy.net') || url.includes('gh-proxy.com')
      }),
    ).toHaveLength(2)
  })
})

describe('PiperRunner 合成', () => {
  it('参数与 stdin 正确，读回 WAV 字节', async () => {
    const harness = spawnHarness((call, mount) => {
      const output = call.args[3]
      if (output === undefined) throw new Error('缺少输出路径')
      writeFileSync(output, WAV_BYTES)
      mount.close(0)
    })
    const dir = dataDir()
    const runner = new PiperRunner({ dir, spawnImpl: harness.spawnImpl })
    const result = await runner.synthesize('你好，世界')
    expect(harness.calls).toHaveLength(1)
    // 绝对路径：应用的工作目录不一定是安装目录。
    expect(harness.calls[0]?.command).toBe(join(dir, 'piper.exe'))
    expect(harness.calls[0]?.args.slice(0, 3)).toEqual([
      '--model',
      join(dir, 'zh_CN-huayan-medium.onnx'),
      '--output_file',
    ])
    expect(harness.calls[0]?.stdin).toBe('你好，世界\n')
    expect(result).toMatchObject({ mime: 'audio/wav', format: 'wav' })
    expect(Buffer.from(result.audio).subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('非零退出：VOICE_PIPER_FAILED，并带上 stderr 摘要', async () => {
    const harness = spawnHarness((_call, mount) => {
      mount.stderr('model load failed')
      mount.close(2)
    })
    const runner = new PiperRunner({ dir: dataDir(), spawnImpl: harness.spawnImpl })
    await expect(runner.synthesize('你好')).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.piperFailed,
      message: expect.stringContaining('model load failed'),
    })
  })

  it('30 秒超时（测试缩短）：杀掉进程并回 VOICE_PIPER_FAILED', async () => {
    const harness = spawnHarness(() => {})
    const runner = new PiperRunner({ dir: dataDir(), spawnImpl: harness.spawnImpl, timeoutMs: 20 })
    await expect(runner.synthesize('慢')).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.piperFailed,
      message: expect.stringContaining('超时'),
    })
    expect(harness.kills()).toBeGreaterThan(0)
  })

  it('AbortSignal 中止正在跑的进程', async () => {
    const harness = spawnHarness(() => {})
    const runner = new PiperRunner({ dir: dataDir(), spawnImpl: harness.spawnImpl })
    const controller = new AbortController()
    const pending = runner.synthesize('慢', controller.signal)
    expect(harness.calls).toHaveLength(1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: VOICE_ERROR_CODES.piperFailed })
    expect(harness.kills()).toBe(1)
  })

  it('排队中被中止的任务立刻失败，且不会再 spawn 第二个进程', async () => {
    const harness = spawnHarness(() => {})
    const runner = new PiperRunner({ dir: dataDir(), spawnImpl: harness.spawnImpl })
    const first = runner.synthesize('一')
    const controller = new AbortController()
    const second = runner.synthesize('二', controller.signal)
    controller.abort()
    await expect(second).rejects.toMatchObject({ code: VOICE_ERROR_CODES.piperFailed })
    expect(harness.calls).toHaveLength(1)
    runner.dispose()
    await expect(first).rejects.toMatchObject({ code: VOICE_ERROR_CODES.piperFailed })
  })

  it('串行：前一个进程关闭后才允许下一个 spawn', async () => {
    const mounts: Mount[] = []
    const harness = spawnHarness((call, mount) => {
      const output = call.args[3]
      if (output === undefined) throw new Error('缺少输出路径')
      writeFileSync(output, WAV_BYTES)
      mounts.push(mount)
    })
    const runner = new PiperRunner({ dir: dataDir(), spawnImpl: harness.spawnImpl })
    const first = runner.synthesize('一')
    const second = runner.synthesize('二')
    expect(harness.calls).toHaveLength(1)
    mounts[0]?.close(0)
    await first
    await vi.waitFor(() => {
      expect(harness.calls).toHaveLength(2)
    })
    mounts[1]?.close(0)
    await second
  })

  it('输出不是 WAV：拒绝并把坏字节挡在 <audio> 之外', async () => {
    const harness = spawnHarness((call, mount) => {
      const output = call.args[3]
      if (output === undefined) throw new Error('缺少输出路径')
      writeFileSync(output, 'not a wav')
      mount.close(0)
    })
    const runner = new PiperRunner({ dir: dataDir(), spawnImpl: harness.spawnImpl })
    await expect(runner.synthesize('你好')).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.piperFailed,
      message: expect.stringContaining('WAV'),
    })
  })
})

describe('Piper provider', () => {
  it('未安装：describe 带「离线语音包还没下载」，synthesize 直接拒绝且不 spawn', async () => {
    const harness = spawnHarness(() => {})
    const installer = installerWith(dataDir(), async () => bytesResponse(4))
    const provider: VoiceProvider = createPiperProvider(
      installer,
      new PiperRunner({ dir: installer.dir, spawnImpl: harness.spawnImpl }),
    )
    expect(provider.describe?.()).toMatchObject({ available: false, reason: '离线语音包还没下载' })
    expect(provider.profiles()[0]?.id).toBe('piper-huayan')
    await expect(provider.synthesize({ text: '你好', profileId: 'piper-huayan' }, {})).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.engineUnavailable,
    })
    expect(harness.calls).toHaveLength(0)
  })

  it('文件齐全：describe 可用，synthesize 走 piper 进程', async () => {
    const installer = installerWith(dataDir(), async () => bytesResponse(4))
    mkdirSync(installer.dir, { recursive: true })
    writeFileSync(join(installer.dir, 'piper.exe'), Buffer.from([1]))
    writeFileSync(join(installer.dir, 'zh_CN-huayan-medium.onnx'), Buffer.alloc(4))
    writeFileSync(join(installer.dir, 'zh_CN-huayan-medium.onnx.json'), Buffer.alloc(4))
    const harness = spawnHarness((call, mount) => {
      const output = call.args[3]
      if (output === undefined) throw new Error('缺少输出路径')
      writeFileSync(output, WAV_BYTES)
      mount.close(0)
    })
    const provider = createPiperProvider(
      installer,
      new PiperRunner({ dir: installer.dir, spawnImpl: harness.spawnImpl }),
    )
    expect(provider.describe?.()).toMatchObject({ available: true, name: '离线（Piper）' })
    const result = await provider.synthesize({ text: '你好', profileId: 'piper-huayan' }, {})
    expect(result.format).toBe('wav')
    expect(harness.calls).toHaveLength(1)
  })
})

describe('插件生命周期', () => {
  it('关闭后 provider 注销、两条路由 404、资源文件保留；重开即恢复', async () => {
    const dir = dataDir()
    const keep = join(dir, 'voice', 'piper', 'keep.txt')
    mkdirSync(join(dir, 'voice', 'piper'), { recursive: true })
    writeFileSync(keep, '保留我')
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir: dir,
      memory: null,
      evolution: null,
      proactive: false,
      providersConfig: { providers: {} },
    })
    const statusOf = async (): Promise<number> => {
      return (await fetch(`${server.url}${PIPER_STATUS_PATH}`)).status
    }
    const catalogIds = async (): Promise<string[]> => {
      const body = (await (await fetch(`${server.url}/api/voice/catalog`)).json()) as {
        engines: { id: string }[]
      }
      return body.engines.map((engine) => {
        return engine.id
      })
    }
    const toggle = async (enabled: boolean): Promise<Response> => {
      return await fetch(`${server.url}/api/plugins/voice-piper`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
    }
    try {
      expect(await statusOf()).toBe(200)
      expect(await catalogIds()).toContain('piper')

      expect((await toggle(false)).status).toBe(200)
      expect(await statusOf()).toBe(404)
      expect((await fetch(`${server.url}/api/voice/engines/piper/install`, { method: 'POST' })).status).toBe(404)
      expect(await catalogIds()).not.toContain('piper')
      expect(readFileSync(keep, 'utf8')).toBe('保留我')

      expect((await toggle(true)).status).toBe(200)
      expect(await statusOf()).toBe(200)
      expect(await catalogIds()).toContain('piper')
      expect(readFileSync(keep, 'utf8')).toBe('保留我')
    } finally {
      await server.close()
    }
  })
})
