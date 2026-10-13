import { useMemo } from 'react'
import { Cat } from '../Cat.tsx'
import { dicebearSvg, fallbackColor, parseAvatarSpec } from './avatars.tsx'

/**
 * 统一头像组件：
 * - 'cat' → Ryen 定制橘猫（品牌主角，保留）
 * - `db:{style}:{seed}` → DiceBear 本地生成 SVG（6 个可爱风格）
 * - 未知/旧值 → 首字符暖色块兜底
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
  const dicebear = useMemo(() => {
    return spec === null ? null : dicebearSvg(spec.styleKey, spec.seed)
  }, [spec])

  if (avatarKey === 'cat') {
    return (
      <span
        className={`avatar avatar-cat ${className}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label={name}
      >
        <Cat mood="idle" size={size} />
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
