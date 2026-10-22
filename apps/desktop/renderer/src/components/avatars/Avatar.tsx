import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { animalAssetUrl, animalHueFilter, parseAnimalAvatar } from '../../lib/animal-3d.ts'
import { portraitOf, portraitSrc, portraitSrcSet } from '../../lib/brand-portraits.ts'
import { Cat } from '../Cat.tsx'
import {
  AVATAR_SPEC,
  avatarCanvas,
  BRAND_AVATAR,
  dicebearSvg,
  fallbackColor,
  isAvatarStyleLoaded,
  loadAvatarStyle,
  parseAvatarSpec,
} from './avatars.tsx'

/**
 * 头像外壳：猫 / DiceBear 风格 / 加载骨架 / 首字符兜底四种内容走同一块画布
 * （见 AVATAR_SPEC）。内容不同，画布规格只有这一处。
 */
function AvatarShell({
  size,
  variant,
  className,
  label,
  busy,
  variantStyle,
  html,
  children,
}: {
  size: number
  /** 内容变体（avatar-cat / avatar-loading / avatar-fallback），风格头像无变体。 */
  variant?: string
  className: string
  label: string
  busy?: boolean
  /** 内容自己要的底色（兜底色块 / 骨架），不涉及画布规格。 */
  variantStyle?: { background: string; fontSize?: number }
  /** DiceBear 本地生成的 SVG（无外部输入）。 */
  html?: string
  children?: ReactNode
}) {
  return (
    <span
      className={['avatar', variant, className]
        .filter((part) => {
          return part !== undefined && part !== ''
        })
        .join(' ')}
      style={{
        ...avatarCanvas(size),
        ...(variantStyle?.background === undefined ? {} : { background: variantStyle.background }),
        ...(variantStyle?.fontSize === undefined ? {} : { fontSize: variantStyle.fontSize }),
      }}
      role="img"
      aria-label={label}
      aria-busy={busy}
      {...(html === undefined ? {} : { dangerouslySetInnerHTML: { __html: html } })}
    >
      {children}
    </span>
  )
}

/**
 * 统一头像组件：
 * - BRAND_AVATAR → Ryen 品牌橘猫（Cat.tsx，与应用图标同一只）
 * - `db:{style}:{seed}` → DiceBear 本地生成 SVG（dylan 人物 / mascot 吉祥物，
 *   按 styleKey 懒加载；未就绪时渲染等尺寸骨架，不产生布局抖动）
 * - 未知/旧值 → 首字符饱和色块兜底
 * 四者的画布、描边、圆角统一由 AVATAR_SPEC 给，24/32/48/64px 下规格一致。
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
  /** 风格 chunk 拉取失败：走首字母色块，而不是永远停在骨架上。 */
  const [failed, setFailed] = useState(false)
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
    setFailed(false)
    let alive = true
    void loadAvatarStyle(styleKey)
      .catch(() => {
        // 加载失败（chunk 404、离线、版本不一致）：落到首字母色块，不停在骨架上。
        // 此前 catch 是空的而 then 照样置 ready，dicebearSvg 查不到风格又返回 null，
        // 于是永久卡成一块带 aria-busy 的灰方块——通讯录、气泡、资料卡里全是它，
        // 而且永远不会自愈。首字母色块是早就写好的兜底，只是这条路径走不到它。
        if (alive) setFailed(true)
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
      <AvatarShell size={size} variant="avatar-cat" className={className} label={name}>
        <Cat shape="circle" size={size} />
      </AvatarShell>
    )
  }
  // 立体动物（`an3d:<种类>:<色相>`）：照片级 3D 渲染的动物头（assets/animals/
  // *.webp，透明底），毛色靠 CSS filter 实时染——8 种毛色零额外资产。
  // 这里只用正面那一张：聊天流、群头像这些地方要的是"一眼认得出谁"，
  // 能转头的三视图留给 Avatar3D（通讯录 / 身份卡 / 「我的」页）。
  const animal = parseAnimalAvatar(avatarKey)
  if (animal !== undefined) {
    const src = animalAssetUrl(animal.kind, 'front')
    if (src !== undefined) {
      return (
        <AvatarShell size={size} variant="avatar-animal" className={className} label={name}>
          <img
            className="avatar-portrait-img"
            src={src}
            style={{ filter: animalHueFilter(animal.kind, animal.hue) }}
            width={size}
            height={size}
            alt=""
            draggable={false}
            decoding="async"
          />
        </AvatarShell>
      )
    }
  }
  // 立绘头像（柴犬/灰狐/剪影）：与品牌橘猫共用同一块圆形画布，
  // 图本身已经是「圆形透明底 + 24/64/256 三档 WebP」，这里只负责按布局宽度选档。
  const portrait = portraitOf(avatarKey)
  if (portrait !== undefined) {
    return (
      <AvatarShell size={size} variant="avatar-portrait" className={className} label={name}>
        <img
          className="avatar-portrait-img"
          src={portraitSrc(portrait.key, 256)}
          srcSet={portraitSrcSet(portrait.key)}
          sizes={`${size}px`}
          width={size}
          height={size}
          alt=""
          draggable={false}
          decoding="async"
        />
      </AvatarShell>
    )
  }
  if (dicebear !== null) {
    return <AvatarShell size={size} className={className} label={name} html={dicebear} />
  }
  if (spec !== null && !failed) {
    // 骨架：容器尺寸与最终头像完全一致，加载完成只是内部替换，无跳动。
    return (
      <AvatarShell
        size={size}
        variant="avatar-loading"
        className={className}
        label={name}
        busy
        variantStyle={{ background: 'var(--bg-subtle)' }}
      />
    )
  }
  return (
    <AvatarShell
      size={size}
      variant="avatar-fallback"
      className={className}
      label={name}
      variantStyle={{
        background: fallbackColor(seed ?? name),
        fontSize: Math.round(size * AVATAR_SPEC.letterRatio),
      }}
    >
      {initial}
    </AvatarShell>
  )
}
