/**
 * 渲染层静态资源伺服。
 *
 * 以前渲染层以 file:// 加载，外部 module script 会被 CORS 拦截，只能靠
 * scripts/inline-dist.mjs 把 1.3MB 的 JS/CSS 全内联进单个 index.html——代价是
 * 丢掉并行加载、HTTP 缓存与 code splitting。这里改由主进程起一个回环 HTTP
 * server 伺服 renderer/dist：同机读取，浏览器可以并行下载分片、走 HTTP 缓存，
 * 构建产物保持原样（不再内联）。
 *
 * 端口固定优先、被占用时回退随机（与后端同一套策略，调用方是 main.ts 的
 * resolveBackendPort）：Chromium 的 HTTP 缓存与 V8 代码缓存都按 origin 索引，
 * 端口每次都变（此前的 port 0）等于每次冷启动把整份缓存归零。
 *
 * 独立的端口（而不是挂在 @ryagent/server 的 http 上）是为了让窗口能与后端
 * **并行**启动：资源服务可以立刻就绪，窗口先渲染骨架，后端就绪后把 API 地址
 * 推给渲染层（见 main.ts）。
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, type Stats, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'

/** 渲染层挂载路径（主进程 loadURL(`${url}/app`)）。 */
export const RENDERER_MOUNT = '/app'

/** 每次使用前都要回源校验：index.html 与 public 原样拷贝的无 hash 文件。 */
const REVALIDATE = 'no-cache'
/** 内容寻址产物（文件名带 hash）：地址不变即内容不变，可以放心长缓存。 */
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** vite 的产物名尾段是 base64url 内容 hash（如 index-B6_i5xWc.js）。 */
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function mimeOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot === -1 ? undefined : MIME_TYPES[path.slice(dot).toLowerCase()]) ?? 'application/octet-stream'
}

/**
 * 能不能长缓存：只有 vite 写进 assets/ 且文件名带内容 hash 的产物才算。
 *
 * 两条都要。public 目录的文件是原样拷贝到 dist 根目录的（favicon.svg 之类），
 * 名字里没有 hash，内容却会随版本变——只按文件名判就会把它们永久缓存住。
 */
function isImmutable(relative: string): boolean {
  return relative.startsWith('assets/') && HASHED_NAME.test(relative)
}

/**
 * If-None-Match 是否命中（GET 用弱比较）：`*` 通配，逗号列表任一项相等即命中。
 * 客户端可能把强校验器写成 W/"…" 的弱形式，比较前统一剥掉前缀。
 */
function ifNoneMatchHit(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : header
  if (raw === undefined) return false
  const tags = raw.split(',').map((tag) => {
    return tag.trim()
  })
  if (tags.includes('*')) return true
  const weak = (tag: string): string => {
    return tag.startsWith('W/') ? tag.slice(2) : tag
  }
  return tags.some((tag) => {
    return weak(tag) === weak(etag)
  })
}

/** 监听并返回实际绑定的端口。 */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      const address = server.address() as { port: number } | null
      resolvePromise(address?.port ?? port)
    })
  })
}

/**
 * 监听端口；期望端口被占用时回退随机，返回实际绑定的端口。
 *
 * 调用方（main.ts 的 resolveBackendPort）已经先探过一次，但「探 → 起」之间存在
 * 竞态。两层都留着，才不会在端口被别人抢走时把窗口晾成白屏。
 */
async function listenWithFallback(server: Server, port: number, host: string): Promise<number> {
  if (port === 0) return listen(server, 0, host)
  try {
    return await listen(server, port, host)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    return listen(server, 0, host)
  }
}

/** {@link RendererAssets.start} 的端口参数。 */
export interface RendererAssetsOptions {
  /** 期望端口；缺省或 0 = 随机端口（多开与测试场景）。 */
  port?: number
  /** 监听地址（默认回环）。 */
  host?: string
}

export class RendererAssets {
  /** 实际绑定的端口（回退随机时是系统分配的）。 */
  private boundPort = 0
  /** 期望端口没绑上、已回退随机端口（调用方据此打日志）。 */
  private fellBackToRandom = false
  /** 不可变产物的强校验器，按路径缓存：内容寻址，算一次就够。 */
  private readonly etags = new Map<string, string>()

  private constructor(
    readonly root: string,
    private readonly server: Server,
    private readonly host: string,
  ) {}

  static async start(distDir: string, options: RendererAssetsOptions = {}): Promise<RendererAssets> {
    const root = resolve(distDir)
    const host = options.host ?? '127.0.0.1'
    const wanted = options.port ?? 0
    const server = createServer()
    const assets = new RendererAssets(root, server, host)
    server.on('request', (req, res) => {
      assets.handle(req, res)
    })
    assets.boundPort = await listenWithFallback(server, wanted, host)
    assets.fellBackToRandom = wanted !== 0 && assets.boundPort !== wanted
    return assets
  }

  /** 资源服务基址（渲染层页面 URL = `${url}${RENDERER_MOUNT}`）。 */
  get url(): string {
    return `http://${this.host}:${this.boundPort}`
  }

  /** 实际绑定的端口。 */
  get port(): number {
    return this.boundPort
  }

  /** 期望端口被占用、已回退随机（origin 变了，但窗口照样起得来）。 */
  get fellBack(): boolean {
    return this.fellBackToRandom
  }

  close(): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      this.server.closeAllConnections?.()
      this.server.close(() => {
        resolvePromise()
      })
    })
  }

  /** 不可变产物的强校验器：sha1 前 16 位，按路径缓存，不再重复读盘。 */
  private etagOf(target: string): string {
    const cached = this.etags.get(target)
    if (cached !== undefined) return cached
    const etag = `"${createHash('sha1').update(readFileSync(target)).digest('hex').slice(0, 16)}"`
    this.etags.set(target, etag)
    return etag
  }

  /** 处理一个请求；不属于自己的路由直接返回（交给别的 handler）。 */
  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      res.writeHead(400).end()
      return
    }
    // 构建产物用绝对路径引用 /assets/…（vite 默认 base '/'），故两者都伺服。
    let relative: string
    if (pathname === RENDERER_MOUNT || pathname === `${RENDERER_MOUNT}/`) relative = 'index.html'
    else if (pathname.startsWith(`${RENDERER_MOUNT}/`)) relative = pathname.slice(RENDERER_MOUNT.length + 1)
    else if (pathname.startsWith('/assets/')) relative = pathname.slice(1)
    else return
    // 防目录穿越：解析后必须仍在 dist 根内。
    const target = resolve(join(this.root, relative))
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      res.writeHead(403).end()
      return
    }
    let stat: Stats
    try {
      stat = statSync(target)
    } catch {
      res.writeHead(404).end('not found')
      return
    }
    if (!stat.isFile()) {
      res.writeHead(404).end('not found')
      return
    }
    // index.html 与 public 原样拷贝的文件内容会随版本变（no-cache，每次回源校验）；
    // 内容寻址产物地址不变即内容不变（immutable + ETag，命中就回 304 不传 body）。
    const immutable = isImmutable(relative)
    const cacheControl = immutable ? IMMUTABLE : REVALIDATE
    const etag = immutable ? this.etagOf(target) : undefined
    if (etag !== undefined && ifNoneMatchHit(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag, 'cache-control': cacheControl }).end()
      return
    }
    res.writeHead(200, {
      'content-type': mimeOf(target),
      'content-length': String(stat.size),
      'cache-control': cacheControl,
      ...(etag === undefined ? {} : { etag }),
      'last-modified': stat.mtime.toUTCString(),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(target).pipe(res)
  }
}
