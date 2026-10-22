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
 * 端口固定也就意味着这个地址是**猜得到的**：任意网页都能拿它当 iframe 套自己
 * 的页面（点击劫持）。因此所有响应都统一带防嵌套的头，见 {@link securityHeaders}。
 *
 * 独立的端口（而不是挂在 @ryharness/server 的 http 上）是为了让窗口能与后端
 * **并行**启动：资源服务可以立刻就绪，窗口先渲染骨架，后端就绪后把 API 地址
 * 推给渲染层（见 main.ts）。
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, type Stats, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { createGzip } from 'node:zlib'

/** 渲染层挂载路径（主进程 loadURL(`${url}/app`)）。 */
export const RENDERER_MOUNT = '/app'

/** 每次使用前都要回源校验：index.html 与 public 原样拷贝的无 hash 文件。 */
const REVALIDATE = 'no-cache'
/** 内容寻址产物（文件名带 hash）：地址不变即内容不变，可以放心长缓存。 */
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** vite 的产物名尾段是 base64url 内容 hash（如 index-B6_i5xWc.js）。 */
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/

/** 可压缩的文本产物。回环传输本身不是瓶颈，但少 1/3 的字节就少一次整块复制与解析前的等待。 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map'])
/** 低于这个体积不必压：gzip 头 + 额外一次内存复制的开销会比省下的字节更贵。 */
const GZIP_MIN_BYTES = 1024

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

/**
 * 防嵌套响应头：这个资源服务跑在**固定**回环端口上（DEFAULT_ASSETS_PORT =
 * DEFAULT_BACKEND_PORT + 1），而固定端口是任何网页都能猜到的。
 *
 * 危害形态是点击劫持：网页 A 用 `<iframe src="http://127.0.0.1:32101/app">` 把
 * RyHarness 真界面套进自己的页面——假页面里那个输入框是真的，用户敲进去的提示词
 * 会真的发给本地 agent（其中带 shellExec 权限的那种）。用户以为在跟别的站点
 * 说话，其实在跟本地 agent 说话。
 *
 * 两条头各挡一半浏览器：X-Frame-Options 是老机制（IE/旧 Chromium 都认），
 * CSP 的 frame-ancestors 是现代机制（认 XFO 的引擎不一定认它，反之亦然），
 * 两个都发才能覆盖全部引擎。
 *
 * 注意 frame-ancestors **不能**写进 index.html 的 meta CSP：meta 形式的那条
 * directive 会被浏览器直接忽略（只有响应头里的才生效），写了等于没写。
 *
 * 抽成纯函数是为了能直接单测「每条响应都带这两条头」——漏一条就等于给
 * 「猜路径」开了个口子，而 404 页面同样能被套进 iframe。
 */
export function securityHeaders(): Record<string, string> {
  return {
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  }
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

  /** 处理一个请求；不属于本服务的路径一律回 404（不留悬挂响应）。 */
  private handle(req: IncomingMessage, res: ServerResponse): void {
    // 防嵌套的头必须**每条响应**都带：200/304/400/403/404/405 一条不漏。
    // 漏掉的那些同样是可被 iframe 套住的文档（404 页面尤其容易被忽略）。
    const security = securityHeaders()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res
        .writeHead(405, { ...security, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
        .end('method not allowed')
      return
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      res.writeHead(400, { ...security }).end()
      return
    }
    // 构建产物用绝对路径引用 /assets/…（vite 默认 base '/'），故两者都伺服。
    let relative: string
    if (pathname === RENDERER_MOUNT || pathname === `${RENDERER_MOUNT}/`) relative = 'index.html'
    else if (pathname.startsWith(`${RENDERER_MOUNT}/`)) relative = pathname.slice(RENDERER_MOUNT.length + 1)
    else if (pathname.startsWith('/assets/')) relative = pathname.slice(1)
    else {
      // 直接 return 会让 socket 一直挂着直到对端超时：浏览器看到的是"加载卡住"
      // 而不是明确的 404，排障时无从判断是路径错了还是服务没起来。
      res.writeHead(404, { ...security, 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    // 防目录穿越：解析后必须仍在 dist 根内。
    const target = resolve(join(this.root, relative))
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      res.writeHead(403, { ...security }).end()
      return
    }
    let stat: Stats
    try {
      stat = statSync(target)
    } catch {
      res.writeHead(404, { ...security }).end('not found')
      return
    }
    if (!stat.isFile()) {
      res.writeHead(404, { ...security }).end('not found')
      return
    }
    // index.html 与 public 原样拷贝的文件内容会随版本变（no-cache，每次回源校验）；
    // 内容寻址产物地址不变即内容不变（immutable + ETag，命中就回 304 不传 body）。
    const immutable = isImmutable(relative)
    const cacheControl = immutable ? IMMUTABLE : REVALIDATE
    const etag = immutable ? this.etagOf(target) : undefined
    /**
     * gzip：只给文本产物，且只在对端声明接受时。
     * 编码不同就是不同实体，因此 ETag 分成两个变体（`"…"` / `"…-gzip"`），
     * 否则一份被缓存住的 gzip 响应可能被当成同一份 identity 实体回出来。
     */
    const dot = target.lastIndexOf('.')
    const ext = dot === -1 ? '' : target.slice(dot).toLowerCase()
    const gzipAccepted = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    const useGzip = gzipAccepted && COMPRESSIBLE.has(ext) && stat.size >= GZIP_MIN_BYTES
    const entityTag = etag === undefined ? undefined : useGzip ? `${etag.slice(0, -1)}-gzip"` : etag
    if (entityTag !== undefined && ifNoneMatchHit(req.headers['if-none-match'], entityTag)) {
      res.writeHead(304, { ...security, etag: entityTag, 'cache-control': cacheControl }).end()
      return
    }
    res.writeHead(200, {
      ...security,
      'content-type': mimeOf(target),
      ...(useGzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : { 'content-length': String(stat.size) }),
      'cache-control': cacheControl,
      ...(entityTag === undefined ? {} : { etag: entityTag }),
      'last-modified': stat.mtime.toUTCString(),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    // createReadStream 的 error 是异步的（文件被删、权限变了、杀毒软件锁住…）。
    // 不挂监听就是一次未捕获异常：主进程直接崩，窗口白屏，用户只看到"应用闪退"。
    const stream = createReadStream(target)
    stream.on('error', () => {
      res.destroy()
    })
    res.on('close', () => {
      stream.destroy()
    })
    if (!useGzip) {
      stream.pipe(res)
      return
    }
    const gzip = createGzip()
    gzip.on('error', () => {
      res.destroy()
    })
    res.on('close', () => {
      gzip.destroy()
    })
    stream.pipe(gzip).pipe(res)
  }
}
