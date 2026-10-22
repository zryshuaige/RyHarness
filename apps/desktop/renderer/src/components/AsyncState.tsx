/**
 * 异步区块的四态：加载中 / 读取失败 / 空 / 就绪。
 *
 * 之前各区段各写一套「`undefined` 就当空」的分支：请求还在飞时显示「还没有内容」，
 * 请求失败时也被画成「还没有内容」——用户分不清是没数据、没加载，还是加载坏了。
 * 把四态收进一个组件，调用方只回答「现在是什么状态」，不再各自即兴。
 *
 * 失败态强制给一句人话，原始报错折进「详情」：错误码、HTTP 状态、英文异常串是
 * 排障用的，不该占据用户第一眼的位置。
 */
import type { ReactNode } from 'react'
import { Icon } from './Icon.tsx'
import { PanelSkeleton } from './Skeleton.tsx'

export function AsyncState({
  loading,
  error,
  detail,
  onRetry,
  retryLabel = '重试',
  empty,
  emptyView,
  skeleton,
  children,
}: {
  loading: boolean
  /** 读取失败的一句话解释；给了它就只画错误条，不画内容。 */
  error?: string | undefined
  /** 原始报错：默认收起，需要排障的人点开还能看到。 */
  detail?: string | undefined
  onRetry?: (() => void) | undefined
  retryLabel?: string
  /** 请求成功但确实没有内容；与「加载中」「失败」是三种不同的事。 */
  empty?: boolean | undefined
  emptyView?: ReactNode
  /** 骨架形状由调用方决定（列表 / 联系人卡 / 统计块各不相同）。 */
  skeleton?: ReactNode
  children: ReactNode
}) {
  if (loading) return <>{skeleton ?? <PanelSkeleton rows={3} />}</>
  if (error !== undefined) {
    return (
      <div
        className="apikey-error"
        role="alert"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '8px 0' }}
      >
        <Icon name="alert" size={16} />
        <span>{error}</span>
        {onRetry !== undefined && (
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              onRetry()
            }}
          >
            {retryLabel}
          </button>
        )}
        {detail !== undefined && detail.length > 0 && (
          <details style={{ flexBasis: '100%' }}>
            <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>详情</summary>
            <code
              style={{
                display: 'block',
                marginTop: 4,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-xs)',
              }}
            >
              {detail}
            </code>
          </details>
        )}
      </div>
    )
  }
  if (empty === true) return <>{emptyView ?? null}</>
  return <>{children}</>
}
