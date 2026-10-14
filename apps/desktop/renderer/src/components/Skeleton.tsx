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
