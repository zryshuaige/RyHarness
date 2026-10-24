import { useEffect, useRef } from 'react'
import {
  ANIMAL_FACES,
  ANIMAL_IDLE_FACES,
  type AnimalFace,
  type AnimalKind,
  animalAssetUrl,
  animalHueFilter,
  parseAnimalAvatar,
} from '../../lib/animal-3d.ts'
import type { AvatarAction, AvatarTemperament } from '../../lib/avatar-motion.ts'
import { Avatar } from './Avatar.tsx'

/**
 * 立体头像外壳。
 *
 * 形象本体是**3D 渲染**的动物头（assets/animals/*.webp），每只有六张脸：
 * 正面 / 左 3/4 / 右 3/4 三个视角，加上微笑、眨眼两个小表情和举爪挥手。
 * 这层壳负责：
 *
 * 1. **转头**：鼠标在头像上移动时，按左右位置换到对应视角的三张脸之一。照片级
 *    渲染图换的是真的侧脸，不是位移贴图糊出来的假象。
 * 2. **表情与动作**：闲置时偶尔微笑或眨一下眼；鼠标停在上面时抬爪打招呼。
 * 3. **跟着转**：整个头像做轻微的 CSS 3D 倾斜（7° 以内——再大就不是转头而是
 *    翻卡片了），并让高光跟着鼠标走，于是"光"和"脸"始终一致。
 * 4. **降级**：系统开了「减少动态效果」或指针是粗指针（触屏没有悬停）时不挂
 *    监听，静态呈现正面。
 *
 * 性能上有一条硬规矩：**换脸与倾斜都不进 React state**。mousemove 每帧只改
 * 几个 CSS 变量和元素上的 data 属性，组件零重渲染；列表里几十张卡各转各的
 * 时候，这一层是"跟手"和"卡顿"的分界线。事件还合帧（rAF）处理——mousemove
 * 的频率高于帧率时，多余的更新直接丢掉。
 */

/** 倾斜的最大角度（度）。 */
const MAX_TILT_DEG = 7

/** 换到侧脸的阈值：鼠标横向偏移超过这个比例（0~1）才换视角。 */
const VIEW_THRESHOLD = 0.28

/** 闲置表情之间的间隔（毫秒下限 / 上限）。 */
const IDLE_MIN_MS = 4000
const IDLE_MAX_MS = 9000

/** 一个表情持续多久（毫秒）。 */
const EXPRESSION_MS = 460

/**
 * 鼠标跟随：写 CSS 变量（倾斜角 + 高光位置）并切换脸。
 *
 * @param enabled - 是否启用（列表里的小头像不启用：几十张卡各转各的会抖）。
 * @returns 挂到元素上的 ref。
 */
function useTilt(enabled: boolean): React.RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!enabled || node === null) return
    // 减少动态效果：静态呈现就够，别让人不适。
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      // 触屏没有"悬停"，转起来只是噪声。
      if (window.matchMedia('(pointer: coarse)').matches) return
    }
    let frame = 0
    let tiltX = 0
    let tiltY = 0
    let lightX = 50
    let lightY = 38
    let view: AnimalFace = 'front'
    let face: AnimalFace = 'front'
    const apply = (): void => {
      frame = 0
      node.style.setProperty('--tilt-x', `${tiltX}deg`)
      node.style.setProperty('--tilt-y', `${tiltY}deg`)
      node.style.setProperty('--light-x', `${lightX}%`)
      node.style.setProperty('--light-y', `${lightY}%`)
      if (node.dataset.face !== face) {
        node.dataset.face = face
      }
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(apply)
    }
    const onMove = (event: PointerEvent): void => {
      const rect = node.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const dx = (event.clientX - rect.left) / rect.width - 0.5
      const dy = (event.clientY - rect.top) / rect.height - 0.5
      tiltY = Math.max(-1, Math.min(1, dx * 2)) * MAX_TILT_DEG
      tiltX = Math.max(-1, Math.min(1, dy * 2)) * -MAX_TILT_DEG
      // 高光跟着鼠标走：光源在指针的反侧（头转向哪边，受光面就转到另一边）。
      lightX = 50 - dx * 90
      lightY = 38 - dy * 70
      if (dx < -VIEW_THRESHOLD) {
        view = 'left'
      } else if (dx > VIEW_THRESHOLD) {
        view = 'right'
      } else {
        view = 'front'
      }
      // 一动鼠标就回到转脸：打招呼是"见面那一���"，不是常驻状态——
      // 指针一直压在上面还想看侧脸时，挥手会把它一直盖住。
      face = view
      // 转的时候不要过渡（否则每帧都在跟 280ms 的过渡打架，手感是"黏"的）；
      // 归位时撤掉这个类，过渡把角度送回 0。
      node.classList.add('is-tilting')
      schedule()
    }
    const onEnter = (): void => {
      // 指针刚停上来：先打个招呼（抬爪挥手）。
      face = 'wave'
      node.addEventListener('pointermove', onMove)
      schedule()
    }
    const onOut = (): void => {
      tiltX = 0
      tiltY = 0
      lightX = 50
      lightY = 38
      view = 'front'
      face = 'front'
      node.removeEventListener('pointermove', onMove)
      node.classList.remove('is-tilting')
      schedule()
    }
    node.addEventListener('pointerenter', onEnter)
    node.addEventListener('pointerleave', onOut)

    // 闲置时的偶发小表情：让它偶尔笑一下、眨一下眼，而不是永远一张扑克脸。
    // 只在**大头像**上跑（这里 enabled = 有 tilt 的那些）：列表里几十张小头像
    // 各跑一套定时器既费电又互相干扰。定时器直接改 DOM 属性，不触发 React 重渲染。
    let idleTimer = 0
    let restoreTimer = 0
    const idleTick = (): void => {
      idleTimer = window.setTimeout(
        () => {
          // 只在"没在转脸、没在打招呼"的时候换表情——不然会盖掉用户正在看的侧脸。
          if (node.dataset.face === 'front') {
            const face = ANIMAL_IDLE_FACES[Math.floor(Math.random() * ANIMAL_IDLE_FACES.length)]
            if (face !== undefined) {
              node.dataset.face = face
              restoreTimer = window.setTimeout(() => {
                if (node.dataset.face === face) {
                  node.dataset.face = 'front'
                }
              }, EXPRESSION_MS)
            }
          }
          idleTick()
        },
        IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS),
      )
    }
    idleTick()

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      window.clearTimeout(idleTimer)
      window.clearTimeout(restoreTimer)
      node.removeEventListener('pointerenter', onEnter)
      node.removeEventListener('pointerleave', onOut)
      node.removeEventListener('pointermove', onMove)
    }
  }, [enabled])
  return ref
}

/**
 * 立体动物：六张脸叠放，按指针位置换脸，闲置时偶尔换个表情。
 *
 * 监听由宿主（Avatar3D）创建并传进来：hook 必须在宿主无条件调用一次——头像
 * 字段会变（用户换了形象），若 hook 落在条件分支里，hook 数量会跟着变，React
 * 会直接把这棵树拆了。
 */
function AnimalFaces({
  kind,
  hue,
  name,
  size,
  tilt,
  className,
  tiltRef,
}: {
  kind: AnimalKind
  hue: number
  name: string
  size: number
  tilt: boolean
  className: string
  tiltRef: React.RefObject<HTMLSpanElement | null>
}) {
  const filter = animalHueFilter(kind, hue)
  // 大头像才把六张脸都挂上：列表里的小头像只留正面那一张，少下载五张。
  const faces = tilt ? ANIMAL_FACES : (['front'] as const)
  return (
    <span
      ref={tilt ? tiltRef : undefined}
      className={`avatar-3d avatar-3d-animal${tilt ? ' avatar-3d-tilt' : ''}${className.length > 0 ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      data-face="front"
      data-idle-face={tilt ? 'on' : 'off'}
      role="img"
      aria-label={name}
    >
      <span className="avatar-3d-stage">
        {faces.map((face) => {
          const src = animalAssetUrl(kind, face)
          if (src === undefined) return null
          return (
            <img
              key={face}
              className={`avatar-3d-face avatar-3d-face-${face}`}
              src={src}
              style={{ filter }}
              width={size}
              height={size}
              alt=""
              draggable={false}
              decoding="async"
            />
          )
        })}
      </span>
      <span className="avatar-3d-light" aria-hidden="true" />
      <span className="avatar-3d-rim" aria-hidden="true" />
    </span>
  )
}

/**
 * 立体头像。
 *
 * @param avatarKey - 头像字段（位图立绘 / DiceBear / `an3d:` 立体动物）。
 * @param name - 名字（首字母兜底与读屏标签用）。
 * @param seed - 兜底色 seed。
 * @param size - 边长（px）。
 * @param tilt - 是否随鼠标转头（只给大头像）。
 * @param className - 附加类名。
 */
export function Avatar3D({
  avatarKey,
  name,
  seed,
  size = 40,
  tilt = false,
  className = '',
  action = 'idle',
  temperament,
}: {
  avatarKey?: string
  name: string
  seed?: string
  size?: number
  tilt?: boolean
  className?: string
  /** 这位此刻在做哪件事（见 lib/avatar-motion.ts 的动作包）。 */
  action?: AvatarAction
  /** 性格三维：决定动效的幅度与节奏（见 lib/avatar-motion.ts）。 */
  temperament?: AvatarTemperament
}) {
  // hook 必须无条件调用一次（头像字段会变，条件 hook 会让 React 拆掉这棵树）
  const ref = useTilt(tilt)
  const animal = parseAnimalAvatar(avatarKey)
  if (animal !== undefined) {
    return (
      <AnimalFaces
        kind={animal.kind}
        hue={animal.hue}
        name={name}
        size={size}
        tilt={tilt}
        className={className}
        tiltRef={ref}
      />
    )
  }
  // 不是立体动物（品牌橘猫 / 立绘 / DiceBear）：走原来的壳 + 静态打光。
  return (
    <span
      ref={tilt ? ref : undefined}
      className={`avatar-3d${tilt ? ' avatar-3d-tilt' : ''}${className.length > 0 ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={name}
    >
      <span className="avatar-3d-stage">
        {/* 动效挂在内层这张图上：立体动物那支（上面的 AnimalFaces）是三视图叠放，
            换脸与倾斜已经占满了 transform，外层再动会打架。 */}
        <Avatar
          avatarKey={avatarKey}
          name={name}
          seed={seed}
          size={size}
          action={action}
          {...(temperament === undefined ? {} : { temperament })}
        />
      </span>
      <span className="avatar-3d-light" aria-hidden="true" />
      <span className="avatar-3d-rim" aria-hidden="true" />
    </span>
  )
}
