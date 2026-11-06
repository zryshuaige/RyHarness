/**
 * 「我的」页的文档转换区块：**这台电脑上能不能把 Office 文件转成 PDF**。
 *
 * 这一块存在是因为「转不了」这件事用户看不到：助理调用转换工具失败时只会说
 * 「本机没装可用的转换引擎」，用户既不知道该装什么，也不知道自己其实已经装好了
 * （引擎探测走的是「能不能用」，不是「装没装」——注册表里有 ProgID 不等于能跑起来）。
 *
 * 所以这里直接把服务端探测到的**引擎状态**说出来：
 * - 用的是 Microsoft Word（系统自带 Office 就能用）；
 * - 用的是 LibreOffice；
 * - 还是没有引擎——这时给出该装什么。
 *
 * **读不到就说读不到**：文档转换是个可以关掉的插件，插件关着时这条路由压根不存在
 * （404）。这跟「没装引擎」是两回事——前者是功能被关了，后者是缺依赖。
 * @module @ryharness/renderer/components/DocumentEngineSection
 */
import { useEffect, useState } from 'react'
import { humanError } from '../lib/error-text.ts'
import { Icon } from './Icon.tsx'

/** 服务端探测到的引擎。 */
export interface DocumentEngineView {
  /** 引擎种类：word / libreoffice / none。 */
  kind: 'word' | 'libreoffice' | 'none'
  /** 引擎 id（进缓存键）。 */
  converterId: string
  /** 给界面看的一句中文。 */
  label: string
}

interface DocumentEngineApi {
  /**
   * 读本机的转换引擎状态。
   *
   * **可选**：测试替身与旧版本服务端不必实现——拿不到就只显示一句「读不到」。
   */
  documentEngines?(): Promise<{ engine: DocumentEngineView }>
}

export function DocumentEngineSection({ api }: { api: DocumentEngineApi }) {
  const [engine, setEngine] = useState<DocumentEngineView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const promise = api.documentEngines?.()
    if (promise === undefined) {
      setError('这个版本的服务端没有报转换引擎状态。')
      return () => {
        cancelled = true
      }
    }
    promise
      .then((resolved) => {
        if (cancelled) return
        const found = resolved?.engine
        // 形状对不上就别显示：半个引擎状态比没有更让人困惑。
        if (found === undefined || typeof found.kind !== 'string') {
          setError('服务端报回来的引擎状态看不懂。')
          return
        }
        setEngine(found)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(humanError(cause, '读不到本机的转换引擎状态'))
      })
    return () => {
      cancelled = true
    }
  }, [api])

  return (
    <div className="me-row me-row-block">
      <div className="me-row-body">
        <div className="me-row-title">
          <Icon name="file" size={16} /> 文档转换
        </div>
        <div className="me-row-sub">助理把 Word / Excel / PPT 转成 PDF 时用的引擎，就在这台电脑上。</div>
        {error !== undefined ? (
          <p className="me-row-sub">{error}</p>
        ) : engine === undefined ? (
          <p className="me-row-sub">正在看本机装了什么…</p>
        ) : engine.kind === 'none' ? (
          <p className="apikey-error">
            本机还没有可用的转换引擎。装 Microsoft Office 或 LibreOffice 任意一个就能用，装完重新打开这一页。
          </p>
        ) : (
          <p className="workspace-item-meta">现在用 {engine.label} 转换。</p>
        )}
      </div>
    </div>
  )
}
