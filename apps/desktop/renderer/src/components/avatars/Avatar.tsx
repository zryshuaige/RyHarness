import { useEffect, useMemo, useState } from 'react'
import { Cat } from '../Cat.tsx'
import {
  BRAND_AVATAR,
  dicebearSvg,
  fallbackColor,
  isAvatarStyleLoaded,
  loadAvatarStyle,
  parseAvatarSpec,
} from './avatars.tsx'

/**
 * 统一头像组件：
 * - BRAND_AVATAR → Ryen 品牌橘猫（Cat.tsx，与应用图标同一只）
 * - `db:{style}:{seed}` → DiceBear 本地生成 SVG（dylan 人物 / mascot 吉祥物，
 *   按 styleKey 懒加载；未就绪时渲染等尺寸骨架，不产生布局抖动）
 * - 未知/旧值 → 首字符饱和色块兜底
 */
export function Avatar({
  avatarKey,
  name,
  seed,
  size = 40,
  className = '',
}: {
  avatarKey?: string
  name: string
  /** 兜底色计算 seed，默认用 name。 */
  seed?: string
  size?: number
  className?: string
}) {
  const initial = (name.trim().slice(0, 1) || '?').toUpperCase()

  const spec = useMemo(() => {
    return parseAvatarSpec(avatarKey)
  }, [avatarKey])

  // DiceBear 风格按需加载：加载完成后同一 key 只渲染一次骨架。
  const styleKey = spec?.styleKey
  const [ready, setReady] = useState(() => {
    return styleKey === undefined || isAvatarStyleLoaded(styleKey)
  })
  useEffect(() => {
    if (styleKey === undefined) {
      setReady(true)
      return
    }
    if (isAvatarStyleLoaded(styleKey)) {
      setReady(true)
      return
    }
    setReady(false)
    let alive = true
    void loadAvatarStyle(styleKey)
      .catch(() => {
        /* 加载失败：保持骨架，语义上退化为占位 */
      })
      .then(() => {
        if (alive) setReady(true)
      })
    return () => {
      alive = false
    }
  }, [styleKey])

  const dicebear = useMemo(() => {
    if (spec === null || !ready) return null
    return dicebearSvg(spec.styleKey, spec.seed)
  }, [spec, ready])

  if (avatarKey === BRAND_AVATAR) {
    return (
      <span
        className={`avatar avatar-cat ${className}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label={name}
      >
        <Cat mood="idle" shape="circle" size={size} />
      </span>
    )
  }
  if (dicebear !== null) {
    return (
      <span
        className={`avatar ${className}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label={name}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: DiceBear 本地生成的 SVG，无外部输入
        dangerouslySetInnerHTML={{ __html: dicebear }}
      />
    )
  }
  if (spec !== null) {
    // 骨架：容器尺寸与最终头像完全一致，加载完成只是内部替换，无跳动。
    return (
      <span
        className={`avatar avatar-loading ${className}`}
        style={{
          width: size,
          height: size,
          background: 'var(--bg-subtle)',
          borderRadius: '50%',
        }}
        role="img"
        aria-label={name}
        aria-busy="true"
      />
    )
  }
  return (
    <span
      className={`avatar avatar-fallback ${className}`}
      style={{
        width: size,
        height: size,
        background: fallbackColor(seed ?? name),
        fontSize: Math.round(size * 0.44),
      }}
      role="img"
      aria-label={name}
    >
      {initial}
    </span>
  )
}
