/**
 * 渲染层静态资源伺服。
 *
 * 以前渲染层以 file:// 加载，外部 module script 会被 CORS 拦截，只能靠
 * scripts/inline-dist.mjs 把 1.3MB 的 JS/CSS 全内联进单个 index.html——代价是
 * 丢掉并行加载、HTTP 缓存与 code splitting。这里改由主进程起一个回环 HTTP
 * server（随机端口）伺服 renderer/dist：同机读取，浏览器可以并行下载分片、
 * 走 HTTP 缓存，构建产物保持原样（不再内联）。
 *
 * 独立的端口（而不是挂在 @ryagent/server 的 http 上）是为了让窗口能与后端
 * **并行**启动：资源服务可以立刻就绪，窗口先渲染骨架，后端就绪后把 API 地址
 * 推给渲染层（见 main.ts）。
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join, resolve, sep } from 'node:path'

/** 渲染层挂载路径（主进程 loadURL(`${url}/app`)）。 */
export const RENDERER_MOUNT = '/app'

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

export class RendererAssets {
  private constructor(
    readonly root: string,
    private readonly server: Server,
  ) {}

  /** 监听回环随机端口，返回就绪的资源服务。 */
  static async start(distDir: string): Promise<RendererAssets> {
    const root = resolve(distDir)
    const server = createServer()
    const assets = new RendererAssets(root, server)
    server.on('request', (req, res) => {
      assets.handle(req, res)
    })
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolvePromise()
      })
    })
    return assets
  }

  /** 资源服务基址（渲染层页面 URL = `${url}${RENDERER_MOUNT}`）。 */
  get url(): string {
    const address = this.server.address() as { port: number } | null
    return `http://127.0.0.1:${address?.port ?? 0}`
  }

  close(): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      this.server.closeAllConnections?.()
      this.server.close(() => {
        resolvePromise()
      })
    })
  }

  /** 处理一个请求；不属于自己的路由直接返回（交给别的 handler）。 */
  private handle(req: { method?: string; url?: string }, res: import('node:http').ServerResponse): void {
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
    let stat
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
    // index.html 不缓存（升级后必须拿新的）；带 hash 的产物长缓存。
    const isIndex = target.endsWith('index.html')
    res.writeHead(200, {
      'content-type': mimeOf(target),
      'content-length': String(stat.size),
      'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
      'last-modified': stat.mtime.toUTCString(),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(target).pipe(res)
  }
}
