/**
 * 内联 SVG 图标注册表：stroke 风格（1.8px 线宽、圆角线帽/连接、fill 无），
 * Lucide/Feather 审美，手绘。替代全部 emoji chrome（Windows 上 emoji
 * 渲染成不一致色块是界面最脏的元素）。
 * 用法：<Icon name="send" size={18} />，颜色跟随 currentColor。
 */

export interface IconDef {
  name: string
  /** svg 内部元素（stroke 继承 currentColor）。 */
  body: string
}

const I: IconDef[] = [
  { name: 'chat-bubble', body: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>' },
  {
    name: 'users', body: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>'
      + '<circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'
      + '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  },
  {
    name: 'cat-face', body: '<path d="M5.2 4.2 7.6 9M18.8 4.2 16.4 9"/>'
      + '<circle cx="12" cy="13" r="7.5"/>'
      + '<circle cx="9.4" cy="12.4" r="0.9" fill="currentColor" stroke="none"/>'
      + '<circle cx="14.6" cy="12.4" r="0.9" fill="currentColor" stroke="none"/>'
      + '<path d="M10 16q2 1.5 4 0"/><path d="M3.5 12.5H6M3.8 15.2l2.2-.6M20.5 12.5H18M20.2 15.2l-2.2-.6"/>',
  },
  {
    name: 'sun', body: '<circle cx="12" cy="12" r="4"/>'
      + '<path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M2.5 12h2M19.5 12h2M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5"/>',
  },
  { name: 'moon', body: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a7 7 0 0 0 9.7 9.7Z"/>' },
  {
    name: 'gear', body: '<circle cx="12" cy="12" r="3.4"/>'
      + '<circle cx="12" cy="12" r="8.6" stroke-dasharray="3.4 3.6"/>',
  },
  { name: 'search', body: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>' },
  { name: 'send', body: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>' },
  {
    name: 'brain', body: '<path d="M12 5a3 3 0 1 0-5.997.14 4 4 0 0 0-2.53 5.75 4 4 0 0 0 .56 6.6A4 4 0 1 0 12 18Z"/>'
      + '<path d="M12 5a3 3 0 1 1 5.997.14 4 4 0 0 1 2.53 5.75 4 4 0 0 1-.56 6.6A4 4 0 1 1 12 18Z"/>'
      + '<path d="M12 5v13"/>',
  },
  { name: 'plus', body: '<path d="M12 5v14M5 12h14"/>' },
  { name: 'x', body: '<path d="M18 6 6 18M6 6l12 12"/>' },
  { name: 'chevron-right', body: '<path d="m9 18 6-6-6-6"/>' },
  { name: 'chevron-left', body: '<path d="m15 18-6-6 6-6"/>' },
  { name: 'panel-right', body: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15.5 4v16"/>' },
  { name: 'copy', body: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' },
  { name: 'check', body: '<path d="M20 6 9 17l-5-5"/>' },
  { name: 'file', body: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>' },
  {
    name: 'thumbs-up', body: '<path d="M7 10v12"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/>',
  },
  {
    name: 'thumbs-down', body: '<path d="M17 14V2"/><path d="M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9Z"/>',
  },
  { name: 'at-sign', body: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>' },
  {
    name: 'group', body: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/>'
      + '<circle cx="17.5" cy="9" r="2.5"/><path d="M15.5 15.6a5 5 0 0 1 6 4.4"/>',
  },
  { name: 'pencil', body: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>' },
  { name: 'alert', body: '<path d="M12 3 2.5 20h19Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>' },
]

export const ICONS: Readonly<Record<string, IconDef>> = Object.freeze(
  Object.fromEntries(I.map((icon) => { return [icon.name, icon] })),
)

export type IconName = keyof typeof ICONS

/** 统一图标组件：颜色继承 currentColor，尺寸默认 18。 */
export function Icon({ name, size = 18, className = '', strokeWidth = 1.8 }: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}) {
  const def = ICONS[name]
  if (def === undefined) return null
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: def.body }}
    />
  )
}
