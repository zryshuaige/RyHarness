import { stagger } from '../lib/stagger.ts'

/** 列表骨架屏（shimmer 1.5s）。 */
export function ConversationSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton-item" style={stagger(index)}>
          <span className="skeleton" style={{ width: 48, height: 48, borderRadius: '50%' }} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="skeleton" style={{ height: 14, width: '55%' }} />
            <span className="skeleton" style={{ height: 12, width: '80%' }} />
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * 面板骨架屏：遮住「还没拿到数据」的那一帧。
 * 形状贴合记忆/手册这类「标题条 + 若干条目」的列表，宽窄交替避免看着像一段乱码；
 * 比一句「载入中…」诚实的地方在于——它说的是"这里马上会有内容"，而不是"我在等"。
 */
export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="panel-skeleton" role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="panel-skeleton-row" style={stagger(index)}>
          <span className="skeleton panel-skeleton-kind" />
          <span className="skeleton panel-skeleton-line" style={{ width: `${88 - index * 18}%` }} />
        </div>
      ))}
    </div>
  )
}
