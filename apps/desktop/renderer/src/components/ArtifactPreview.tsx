/**
 * 产物内嵌预览：点产物卡开的是这个框，不是浏览器下载页。
 *
 * 按类型分派（lib/preview.ts）之后各走各的渲染器：图片与 PDF 直接把字节 URL
 * 交给 `<img>` / `<iframe>`，HTML 挂进一个不授同源权限的 sandbox iframe，
 * Markdown 复用现有的 Markdown 渲染器，代码/文本进 `<pre>`。
 * docx / xlsx / 未知二进制**没有**纯前端渲染器——本仓不引新依赖，
 * 硬凑一个只会得到一个坏掉的预览，所以这一类明确说清不能内嵌，并给出三个
 * 动作：用系统程序打开、下载、复制路径。
 *
 * 绝对路径来自 GET /api/files/:name/info（服务端算好的），渲染层不猜路径——
 * 它连工作区根目录都不知道。
 */
import { useEffect, useRef, useState } from 'react'
import type { ApiClient, ArtifactInfo } from '../api.ts'
import { copyText, openInFileManager } from '../lib/desktop.ts'
import { errorDetail, humanError } from '../lib/error-text.ts'
import { formatSize } from '../lib/format.ts'
import { humanMime } from '../lib/humanize.ts'
import { HTML_PREVIEW_MAX_BYTES, needsTextBody, previewKindOf } from '../lib/preview.ts'
import { Icon } from './Icon.tsx'
import { Markdown } from './Markdown.tsx'

/** 产物卡的最小身份（气泡里的 file part 与右栏产物行共用同一形状）。 */
export interface ArtifactTarget {
  name: string
  mime: string
  size: number
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string; detail: string | undefined }
  // 超上限的 HTML：不读正文（读进来就已经卡住了），只把体积说清楚。
  | { status: 'toobig'; info: ArtifactInfo }
  | { status: 'ready'; info: ArtifactInfo; text: string }

const FOCUSABLE = 'button, [href], iframe, [tabindex]:not([tabindex="-1"])'

/** 预览框里的四个动作。PDF 靠 iframe 内嵌，Office 靠第一个动作——两者都要留着。 */
function PreviewActions({
  api,
  target,
  info,
  onHint,
}: {
  api: ApiClient
  target: ArtifactTarget
  info: ArtifactInfo | undefined
  onHint: (message: string) => void
}) {
  return (
    <span className="attach-preview-actions">
      <a href={api.fileRawUrl(target.name)} target="_blank" rel="noreferrer">
        在新窗口打开
      </a>
      <button
        type="button"
        onClick={() => {
          if (info === undefined) return
          void openInFileManager(info.path).then((ok) => {
            onHint(ok ? `已用系统程序打开 ${target.name}` : '系统程序打开失败，可以先复制路径')
          })
        }}
      >
        用系统程序打开
      </button>
      <a href={api.fileRawUrl(target.name, true)} download={target.name}>
        下载
      </a>
      <button
        type="button"
        onClick={() => {
          if (info === undefined) return
          void copyText(info.path).then((ok) => {
            onHint(ok ? '路径已复制' : '复制失败')
          })
        }}
      >
        复制路径
      </button>
    </span>
  )
}

/**
 * 一份 HTML 产物：整篇挂进 opaque origin 的 iframe 里渲染。
 *
 * 为什么不需要 HTML 消毒器：隔离来自 sandbox 而不是清洗。sandbox 不给
 * allow-same-origin，这份文档拿到的是一个 opaque origin——读不到本应用的
 * localStorage / origin / DOM，也导航不了顶层窗口。正因为隔离来自 sandbox，
 * `allow-same-origin` 是**不能**补的：补上就与宿主同源，产物里一个 `<script>`
 * 就等价于应用自己的脚本，那时才真的需要消毒器。
 *
 * 两种模式只有 sandbox 这一处不同：`sandbox=""` 是静态预览（脚本不跑），
 * `sandbox="allow-scripts"` 才让产物里的 <script> 与 onclick 生效——即便如此，
 * 仍然不给 allow-same-origin / allow-top-navigation / allow-popups。切换模式会换掉
 * iframe 的 key，于是上一模式里跑着的脚本随旧文档一起退休，而不是留在原地跑。
 */
function HtmlFrame({ name, html }: { name: string; html: string }) {
  const [interactive, setInteractive] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let created: string | undefined
    try {
      created = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
      setUrl(created)
      setFailed(false)
    } catch {
      // 畸形 UTF-8 走不到这里：fileText 用 response.text()，坏字节被替换成 U+FFFD
      // 而不是抛错。真正抛的是 createObjectURL 本身（受限上下文 / 超长串）。
      // 无论哪一种，框里都不能只剩一块空白。
      setUrl(undefined)
      setFailed(true)
    }
    // 不 revoke 就是泄漏：切产物或卸载都会在文档上留下一份完整副本，直到文档销毁。
    return () => {
      if (created !== undefined) URL.revokeObjectURL(created)
    }
  }, [html])

  if (failed || url === undefined) {
    return (
      <div className="attach-preview-none" role="alert">
        <p>这份 HTML 没能预览出来。</p>
        <p>用「在新窗口打开」或「下载」看它。</p>
      </div>
    )
  }
  return (
    <div className="attach-preview-html">
      {/* 复用动作条的样式：这两个键与右上角四个动作是同一种控件。 */}
      <span className="attach-preview-actions attach-preview-html-bar">
        <button type="button" aria-pressed={interactive} onClick={() => setInteractive((on) => !on)}>
          交互预览
        </button>
        <button type="button" onClick={() => setNonce((n) => n + 1)}>
          刷新
        </button>
      </span>
      <iframe
        key={`${interactive ? 'live' : 'static'}-${nonce}`}
        className="attach-preview-frame"
        src={url}
        sandbox={interactive ? 'allow-scripts' : ''}
        title={name}
      />
    </div>
  )
}

/** 渲染器分支：只有这一处决定「这份产物在框里长什么样」。 */
function PreviewBody({
  kind,
  name,
  rawUrl,
  text,
}: {
  kind: ReturnType<typeof previewKindOf>
  name: string
  rawUrl: string
  text: string
}) {
  if (kind === 'image') return <img className="attach-preview-img" src={rawUrl} alt={name} />
  // PDF 交给 Chromium 自带的阅读器：主进程开了 webPreferences.plugins 之后，
  // `<embed type="application/pdf">` 会真正渲染出页面，而不是一块空白框。
  // 早先这里写的是「Electron 没有内置 PDF 阅读器」——那是不完整的：阅读器在
  // Chromium 里一直都在，只是被 Electron 默认关掉的 plugins 开关挡在门外，
  // 所以 iframe/embed 才只得到空白。不是路径或 MIME 的问题。
  if (kind === 'pdf') {
    return (
      <object className="attach-preview-pdf" data={rawUrl} type="application/pdf" aria-label={name}>
        {/* 阅读器没起来时的兜底：宁可说清看不了，也不给一块空白。 */}
        <div className="attach-preview-none">
          <p>这份 PDF 没能预览出来。</p>
          <p>用右上角的「在新窗口打开」或「用系统程序打开」看它。</p>
        </div>
      </object>
    )
  }
  if (kind === 'html') return <HtmlFrame name={name} html={text} />
  if (kind === 'markdown') {
    return (
      <div className="attach-preview-md">
        <Markdown text={text} />
      </div>
    )
  }
  if (kind === 'external') {
    return <p className="attach-preview-none">这种格式不能内嵌预览。用右上角的动作把它交给系统程序，或下载下来再看。</p>
  }
  return <pre className="attach-preview-code">{text}</pre>
}

export function ArtifactPreview({
  api,
  target,
  onClose,
}: {
  api: ApiClient
  target: ArtifactTarget
  onClose: () => void
}) {
  const kind = previewKindOf(target.name, target.mime)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [hint, setHint] = useState<string | undefined>(undefined)
  const [retry, setRetry] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry 是「重试」按钮的唯一作用，effect 体内读不到它；把它从依赖里删掉，重试就永远不生效
  useEffect(() => {
    let alive = true
    setLoad({ status: 'loading' })
    setHint(undefined)
    const run = async (): Promise<void> => {
      try {
        const info = await api.fileInfo(target.name)
        // HTML 的正文不是「读进来贴上去」，是解码成字符串 → 塞进 Blob → 解析成
        // DOM，三趟都在渲染进程主线程上。先按体积拒绝，才不会为了拒绝它而先把它读完。
        if (kind === 'html' && info.size > HTML_PREVIEW_MAX_BYTES) {
          if (alive) setLoad({ status: 'toobig', info })
          return
        }
        const text = needsTextBody(kind) ? await api.fileText(target.name) : ''
        if (alive) setLoad({ status: 'ready', info, text })
      } catch (error) {
        // 一句人话留在正文，原文折进「详情」——与 AsyncState / HistoryFailure 同一套
        // 分工，`file not found: 报告.docx` 这种原话不该挂在预览框的第一行。
        if (alive)
          setLoad({ status: 'error', message: humanError(error, '这个文件暂时读不出来'), detail: errorDetail(error) })
      }
    }
    void run()
    // alive 守卫：切产物或卸载后，晚到的响应不该把上一份的正文画到框里。
    return () => {
      alive = false
    }
  }, [api, target.name, kind, retry])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (dialog === null) return
      // 框是模态的，Tab 就得在框里绕：焦点能跑到被遮住的聊天区去，键盘用户
      // 于是能在一块看得见的界面后面继续编辑消息。
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
        return !el.hasAttribute('disabled')
      })
      if (items.length === 0) return
      const first = items[0] as HTMLElement
      const last = items[items.length - 1] as HTMLElement
      const active = document.activeElement
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    dialogRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const info = load.status === 'ready' || load.status === 'toobig' ? load.info : undefined
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 遮罩点击关闭（Esc 由上面的全局 keydown 处理，它就是这条路径的键盘等价物）
    <div
      className="attach-preview-mask"
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${target.name}`}
      onClick={(event) => {
        // 点遮罩关闭；只认事件本身落在遮罩上，从框里冒泡出来的点击不算。
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="attach-preview" ref={dialogRef} tabIndex={-1}>
        <div className="attach-preview-head">
          <span className="attach-preview-title">
            <strong title={target.name}>{target.name}</strong>
            {/* MIME 是分派用的单位（application/vnd.openxmlformats-…），说「Word 文档」，
                原值留在 title 上给排障的人。 */}
            <small title={info?.mime}>
              {formatSize(info?.size ?? target.size)}
              {info === undefined ? '' : ` · ${humanMime(info.mime)}`}
            </small>
          </span>
          <PreviewActions api={api} target={target} info={info} onHint={setHint} />
          <button type="button" className="attach-preview-close" aria-label="关闭预览" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {hint !== undefined && (
          <p className="attach-preview-hint" role="status">
            {hint}
          </p>
        )}
        <div className="attach-preview-body">
          {load.status === 'loading' && <p className="attach-preview-none">正在读取…</p>}
          {load.status === 'error' && (
            // div 而不是 p：折叠的「详情」不能塞在 <p> 里（details 不能是 p 的后代）。
            <div className="attach-preview-none" role="alert">
              {load.message}
              <button
                type="button"
                onClick={() => {
                  setRetry((n) => {
                    return n + 1
                  })
                }}
              >
                重试
              </button>
              {load.detail !== undefined && (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>详情</summary>
                  <code>{load.detail}</code>
                </details>
              )}
            </div>
          )}
          {load.status === 'toobig' && (
            <div className="attach-preview-none" role="alert">
              <p>这份 HTML 有 {formatSize(load.info.size)}，太大了，内嵌预览会卡住界面。</p>
              <p>用「在新窗口打开」或「下载」看它。</p>
            </div>
          )}
          {load.status === 'ready' && (
            <PreviewBody kind={kind} name={target.name} rawUrl={api.fileRawUrl(target.name)} text={load.text} />
          )}
        </div>
      </div>
    </div>
  )
}
