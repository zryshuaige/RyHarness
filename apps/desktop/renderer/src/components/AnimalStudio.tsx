import { useMemo, useState } from 'react'
import {
  ANIMAL_HUES,
  ANIMALS,
  type AnimalKind,
  animalAssetUrl,
  animalAvatar,
  animalHueFilter,
  animalHueOf,
  animalOf,
  parseAnimalAvatar,
} from '../lib/animal-3d.ts'
import { Avatar3D } from './avatars/Avatar3D.tsx'
import { Icon } from './Icon.tsx'

/**
 * 我的形象：一只**可定制**的立体动物。
 *
 * 形象本体是**照片级 3D 渲染**的动物头（assets/animals/*.webp，透明底，每只
 * 三张脸：正面 / 左 3/4 / 右 3/4）。渲染层只按路径消费——"渲染层里不写图形"
 * 是仓库的既有不变量（见 brand.test.tsx）。
 *
 * 毛色不是另存一套图，而是**一条 CSS filter 链**（sepia → hue-rotate →
 * saturate → brightness）：8 种毛色零额外资产，GPU 上跑，实时可切。所以两个
 * 选择器都直接用缩略图呈现——色块看不出毛发染成那个颜色是什么样，缩略图能。
 *
 * 三组选择器都用 radiogroup 语义（组内一枚 tabIndex=0，方向键移动），
 * 与通讯录头像选择器同一口径——键盘用户不必一格一格 Tab 过去。
 */

/** 一份形象设定。 */
export interface AnimalSpec {
  kind: AnimalKind
  hue: number
}

/** 把头像字段翻成形象设定；不是立体动物时返回 undefined。 */
export function specOf(avatar: string | undefined): AnimalSpec | undefined {
  const parsed = parseAnimalAvatar(avatar)
  if (parsed === undefined) return undefined
  return { kind: parsed.kind, hue: parsed.hue }
}

/** 头像字段 → 形象设定；不是立体动物时按默认（狗 / 暖橘）。 */
export function specOrDefault(avatar: string | undefined): AnimalSpec {
  return specOf(avatar) ?? { kind: 'dog', hue: 30 }
}

export function AnimalStudio({
  current,
  disabled,
  onSave,
  onPickOther,
}: {
  /** 当前形象（可能是别的形态，那就从默认开始）。 */
  current: AnimalSpec
  /** 服务端不支持保存时为 true：只看不改。 */
  disabled?: boolean
  /** 保存：把选好的形象存进 profile.avatar。 */
  onSave: (avatar: string) => void
  /** 换回别的头像（品牌猫 / DiceBear / 动物立绘）。 */
  onPickOther: () => void
}) {
  const [draft, setDraft] = useState<AnimalSpec>(current)
  const [focusKind, setFocusKind] = useState(0)
  const [focusHue, setFocusHue] = useState(0)

  const avatar = useMemo(() => {
    return animalAvatar(draft.kind, draft.hue)
  }, [draft])

  const dirty = avatar !== animalAvatar(current.kind, current.hue)

  /** 当前选的是什么：预览图旁边要写出名字，否则用户只看到"变了个样"。 */
  const currentName = `${animalOf(draft.kind)?.label ?? draft.kind} · ${animalHueOf(draft.hue).label}`

  /**
   * 个人资料是异步读回来的：首次渲染时 profile 还没到，面板会先按默认值起，
   * 资料到了之后得换成用户已经存好的那一只。
   *
   * 靠**宿主给 key** 换（MePage 传 key={profile?.avatar}）：资料到了 → 组件重挂
   * → useState 的初值重新取一遍。用 effect 同步 current 会踩两个坑——依赖整个
   * 对象则每次渲染都 setDraft（死循环），依赖两个原始值则 biome 判定"依赖比捕获
   * 更具体"（它是对的：捕获的是整个对象）。
   */

  /** 换动物或毛色后把焦点移到对应的按钮上（方向键走到头时要能继续走）。 */
  const moveKind = (index: number): void => {
    const next = (index + ANIMALS.length) % ANIMALS.length
    setFocusKind(next)
    setDraft((prev) => {
      return { ...prev, kind: ANIMALS[next]?.kind ?? prev.kind }
    })
  }
  const moveHue = (index: number): void => {
    const next = (index + ANIMAL_HUES.length) % ANIMAL_HUES.length
    setFocusHue(next)
    setDraft((prev) => {
      return { ...prev, hue: ANIMAL_HUES[next]?.hue ?? prev.hue }
    })
  }

  return (
    <div className="animal-studio">
      <div className="animal-studio-preview">
        {/* 预览用同一套光照与壳：用户在这里看到的就是聊天气泡与右栏里的样子。 */}
        <span className="animal-studio-preview-face">
          <Avatar3D avatarKey={avatar} name="你" seed="you" size={128} tilt />
          <span className="animal-studio-current">{currentName}</span>
        </span>
        <div className="animal-studio-preview-side">
          <p className="animal-studio-title">我的形象</p>
          <p className="me-note">选一只属于你的动物。形象会跟着对话走——助理们看到的是它，不是「你」。</p>
          <p className="me-note animal-studio-hint-line">鼠标移到头像上，它会跟着转头。</p>
          <div className="animal-studio-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || !dirty}
              onClick={() => {
                onSave(avatar)
              }}
            >
              {/* 服务端不支持改资料时不能写"已保存"——那是谎报：用户会以为存上了。 */}
              {disabled ? '这个版本不能改形象' : dirty ? '保存形象' : '已保存'}
            </button>
            <button type="button" className="btn" onClick={onPickOther}>
              换别的头像
            </button>
          </div>
        </div>
      </div>

      <fieldset className="animal-studio-group">
        <legend>哪种动物</legend>
        <div className="animal-studio-row" role="radiogroup" aria-label="选择动物">
          {ANIMALS.map((animal, index) => {
            const selected = draft.kind === animal.kind
            const src = animalAssetUrl(animal.kind, 'front')
            return (
              // biome-ignore lint/a11y/useSemanticElements: 卡片式单选，原生 radio 的样式与布局无法满足设计
              <button
                key={animal.kind}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={index === focusKind ? 0 : -1}
                className={`animal-studio-pick${selected ? ' is-selected' : ''}`}
                title={animal.hint}
                onClick={() => {
                  setFocusKind(index)
                  setDraft((prev) => {
                    return { ...prev, kind: animal.kind }
                  })
                }}
                onFocus={() => {
                  setFocusKind(index)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault()
                    moveKind(index + 1)
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    moveKind(index - 1)
                  }
                }}
              >
                {src !== undefined && (
                  <img
                    className="animal-studio-art"
                    src={src}
                    style={{ filter: animalHueFilter(draft.kind, draft.hue) }}
                    width={44}
                    height={44}
                    alt=""
                    draggable={false}
                  />
                )}
                <small>{animal.label}</small>
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="animal-studio-group">
        <legend>什么毛色</legend>
        <div className="animal-studio-row" role="radiogroup" aria-label="选择毛色">
          {ANIMAL_HUES.map((each, index) => {
            const selected = draft.hue === each.hue
            const src = animalAssetUrl(draft.kind, 'front')
            return (
              // biome-ignore lint/a11y/useSemanticElements: 缩略图式单选，原生 radio 的样式与布局无法满足设计
              <button
                key={each.hue}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={each.label}
                title={each.label}
                tabIndex={index === focusHue ? 0 : -1}
                className={`animal-studio-hue${selected ? ' is-selected' : ''}`}
                onClick={() => {
                  setFocusHue(index)
                  setDraft((prev) => {
                    return { ...prev, hue: each.hue }
                  })
                }}
                onFocus={() => {
                  setFocusHue(index)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault()
                    moveHue(index + 1)
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    moveHue(index - 1)
                  }
                }}
              >
                {src !== undefined && (
                  <img
                    className="animal-studio-art"
                    src={src}
                    style={{ filter: animalHueFilter(draft.kind, each.hue) }}
                    width={36}
                    height={36}
                    alt=""
                    draggable={false}
                  />
                )}
                <small>{each.label}</small>
              </button>
            )
          })}
        </div>
      </fieldset>

      <p className="animal-studio-hint">
        <Icon name="brain" size={16} />
        形象存在本机，随对话一起告诉助理；换形象不会改你的名字或历史。
      </p>
    </div>
  )
}
