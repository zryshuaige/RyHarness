// @vitest-environment node

/**
 * 桌面启动的两件性能基建：固定后端端口（跨启动 origin 稳定）与本地启动计时。
 *
 * 这两条都不碰 Electron API（端口探测用 node:net、计时用注入时钟），所以 electron
 * 只需要一个「能 import」的替身：真 Electron 在 Node 测试里拿不到 app/BrowserWindow。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  return {
    app: {
      getPath: () => {
        return 'C:/tmp/ryagent'
      },
      getAppPath: () => {
        return 'C:/app'
      },
      getVersion: () => {
        return '0.1.0'
      },
      setAppUserModelId: () => {},
      requestSingleInstanceLock: () => {
        return true
      },
      whenReady: () => {
        return Promise.resolve()
      },
      on: () => {},
      quit: () => {},
      exit: () => {},
    },
    BrowserWindow: class {},
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
    Tray: class {},
    Notification: { isSupported: () => false },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({ isEmpty: () => true }) },
    ipcMain: { handle: () => {} },
    dialog: {},
    screen: {},
    shell: {},
  }
})

const {
  backendPortFromEnv,
  BootTrace,
  DEFAULT_ASSETS_PORT,
  DEFAULT_BACKEND_PORT,
  readRendererBootReport,
  resolveBackendPort,
  writeBootTraceLog,
} = await import('../electron/main.ts')

describe('后端端口策略', () => {
  it('默认走固定端口（origin 跨启动不变，HTTP 与 V8 缓存才留得住）', async () => {
    expect(backendPortFromEnv({})).toBe(DEFAULT_BACKEND_PORT)
    const probes: number[] = []
    const choice = await resolveBackendPort({
      port: backendPortFromEnv({}),
      host: '127.0.0.1',
      probe: (port) => {
        probes.push(port)
        return Promise.resolve(true)
      },
    })
    expect(choice).toEqual({ port: DEFAULT_BACKEND_PORT, fallback: false })
    expect(probes).toEqual([DEFAULT_BACKEND_PORT])
  })

  it('端口被占用时回退随机，并把原因说清楚（渲染层拿的是实际地址）', async () => {
    const choice = await resolveBackendPort({
      port: 32100,
      host: '127.0.0.1',
      probe: () => {
        return Promise.resolve(false)
      },
    })
    expect(choice.port).toBe(0)
    expect(choice.fallback).toBe(true)
    expect(choice.reason).toContain('32100')
  })

  it('显式要求随机端口时直接放行，不去探测', async () => {
    let probed = false
    const choice = await resolveBackendPort({
      port: 0,
      host: '127.0.0.1',
      probe: () => {
        probed = true
        return Promise.resolve(false)
      },
    })
    expect(choice).toEqual({ port: 0, fallback: false })
    expect(probed).toBe(false)
  })

  it('RYAGENT_PORT 覆盖默认值；非法值退回默认固定端口', () => {
    expect(backendPortFromEnv({ RYAGENT_PORT: '45999' })).toBe(45999)
    expect(backendPortFromEnv({ RYAGENT_PORT: '0' })).toBe(0)
    expect(backendPortFromEnv({ RYAGENT_PORT: '' })).toBe(DEFAULT_BACKEND_PORT)
    expect(backendPortFromEnv({ RYAGENT_PORT: 'abc' })).toBe(DEFAULT_BACKEND_PORT)
    expect(backendPortFromEnv({ RYAGENT_PORT: '-1' })).toBe(DEFAULT_BACKEND_PORT)
    expect(backendPortFromEnv({ RYAGENT_PORT: '70000' })).toBe(DEFAULT_BACKEND_PORT)
  })

  it('渲染层资源服务占后端 +1：两个固定端口互不抢，各自被占用时各回退随机', async () => {
    expect(DEFAULT_ASSETS_PORT).toBe(DEFAULT_BACKEND_PORT + 1)
    const [backend, assets] = await Promise.all([
      resolveBackendPort({ port: DEFAULT_BACKEND_PORT, host: '127.0.0.1' }),
      resolveBackendPort({ port: DEFAULT_ASSETS_PORT, host: '127.0.0.1' }),
    ])
    expect(backend.port).toBe(DEFAULT_BACKEND_PORT)
    expect(assets.port).toBe(DEFAULT_ASSETS_PORT)
    expect(backend.fallback).toBe(false)
    expect(assets.fallback).toBe(false)
  })
})

describe('启动计时', () => {
  /** 可推进的假时钟。 */
  function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let current = start
    return {
      now: () => {
        return current
      },
      advance: (ms) => {
        current += ms
      },
    }
  }

  it('按阶段记录耗时，首段是 0、其余是与上一段的间隔', () => {
    const clock = fakeClock()
    const trace = new BootTrace(clock.now, clock.now())
    clock.advance(120)
    trace.mark('app-ready')
    clock.advance(30)
    trace.mark('backend-ready')
    clock.advance(15)
    trace.mark('first-interactive')

    const snapshot = trace.snapshot()
    expect(snapshot.phases.map((phase) => phase.stage)).toEqual([
      'process-start',
      'app-ready',
      'backend-ready',
      'first-interactive',
    ])
    expect(snapshot.phases[0]).toMatchObject({ sinceStartMs: 0, deltaMs: 0 })
    expect(snapshot.phases[1]).toMatchObject({ sinceStartMs: 120, deltaMs: 120 })
    expect(snapshot.phases[3]).toMatchObject({ sinceStartMs: 165, deltaMs: 15 })
    expect(snapshot.totalMs).toBe(165)
    expect(trace.summary()).toContain('first-interactive +165ms')
  })

  it('同名阶段只记第一次（重复打点不会把时间轴搅乱）', () => {
    const clock = fakeClock()
    const trace = new BootTrace(clock.now, clock.now())
    trace.mark('app-ready')
    clock.advance(50)
    trace.mark('app-ready')
    expect(trace.snapshot().phases.filter((phase) => phase.stage === 'app-ready')).toHaveLength(1)
  })

  it('渲染层阶段按 loadURL 时刻对齐后并进同一条时间轴', () => {
    const clock = fakeClock()
    const trace = new BootTrace(clock.now, clock.now())
    clock.advance(200) // 主进程走到 loadURL
    const loadStartedAt = clock.now()
    clock.advance(80) // 渲染层跑了 80ms 后上报
    trace.recordRenderer(
      readRendererBootReport(JSON.parse('{"phases":[{"stage":"module","ms":12.5},{"stage":"first-paint","ms":80}]}')),
      loadStartedAt,
    )
    const snapshot = trace.snapshot()
    expect(snapshot.phases.map((phase) => phase.stage)).toEqual([
      'process-start',
      'renderer:module',
      'renderer:first-paint',
    ])
    expect(snapshot.phases[2]).toMatchObject({ sinceStartMs: 280 })
  })

  it('渲染层上报的脏形状按「没上报」处理', () => {
    expect(readRendererBootReport(null)).toEqual({ phases: [] })
    expect(readRendererBootReport('nope')).toEqual({ phases: [] })
    expect(readRendererBootReport({ phases: 'nope' })).toEqual({ phases: [] })
    expect(readRendererBootReport({ phases: [{ stage: 'a' }, 7, null, { stage: 'b', ms: Number.NaN }] })).toEqual({
      phases: [],
    })
    expect(readRendererBootReport({ phases: [{ stage: 'a', ms: 3 }] })).toEqual({ phases: [{ stage: 'a', ms: 3 }] })
  })

  it('写入 userData 下的 boot-trace.log（覆盖上次，一次启动一行 JSON）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryagent-boot-'))
    const clock = fakeClock()
    const trace = new BootTrace(clock.now, clock.now())
    clock.advance(80)
    trace.mark('app-ready')
    writeBootTraceLog(dir, trace)

    const first = JSON.parse(readFileSync(join(dir, 'boot-trace.log'), 'utf8')) as { totalMs: number }
    expect(first.totalMs).toBe(80)

    clock.advance(40)
    trace.mark('backend-ready')
    writeBootTraceLog(dir, trace)
    const second = readFileSync(join(dir, 'boot-trace.log'), 'utf8')
    expect(second).toContain('backend-ready')
    expect((JSON.parse(second) as { totalMs: number }).totalMs).toBe(120)
  })
})
