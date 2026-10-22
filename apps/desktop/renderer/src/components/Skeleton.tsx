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

/**
 * 通讯录骨架：形状贴合联系人卡（头像圆 + 名字 + 两行摘要），
 * 让「正在读联系人」和「通讯录还是空的」在屏幕上长得不一样。
 */
export function ContactSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="contact-grid" role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="contact-card" style={stagger(index)}>
          <span className="skeleton" style={{ width: 56, height: 56, borderRadius: '50%' }} />
          <span className="skeleton" style={{ width: '52%', height: 16 }} />
          <span className="skeleton" style={{ width: '78%', height: 12 }} />
          <span className="skeleton" style={{ width: '64%', height: 12 }} />
          <span className="skeleton" style={{ width: 72, height: 28, borderRadius: 'var(--radius-md)' }} />
        </div>
      ))}
    </div>
  )
}
