import { useMemo } from 'react'
import { AVATAR_BY_KEY, fallbackColor } from './avatars.tsx'
import { Cat } from '../Cat.tsx'

/**
 * 统一头像组件：按 avatarKey 渲染预置 SVG；'cat' 走 Ryen 的 Cat 组件；
 * 未知 key 回退首字符暖色色块。
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
  const def = avatarKey === undefined ? undefined : AVATAR_BY_KEY[avatarKey]
  const initial = (name.trim().slice(0, 1) || '?').toUpperCase()

  const fallback = useMemo(() => {
    return (
      <span
        className={`avatar avatar-fallback ${className}`}
        style={{
          width: size, height: size,
          background: fallbackColor(seed ?? name),
          fontSize: Math.round(size * 0.44),
        }}
        role="img"
        aria-label={name}
      >
        {initial}
      </span>
    )
  }, [seed, name, size, initial, className])

  if (def === undefined) return fallback
  if (def.key === 'cat') {
    return (
      <span className={`avatar avatar-cat ${className}`} style={{ width: size, height: size }} role="img" aria-label={name}>
        <Cat mood="idle" size={size} />
      </span>
    )
  }
  return (
    <span
      className={`avatar ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${name}（${def.name}）`}
      dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 64 64" width="${size}" height="${size}">${def.svg}</svg>` }}
    />
  )
}
