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
  savedAvatar,
  pending,
  disabled,
  onSave,
  onPickOther,
}: {
  /** 已存着的那一只（可能是别的形态，那就从默认开始）。 */
  current: AnimalSpec
  /**
   * 头像字段原样传进来（`an3d:…` 或别的）。
   *
   * 为什么不能只看 current：头像字段不是立体动物时（品牌猫、DiceBear 立绘），
   * current 会退回默认的一只动物——那时候「已保存」是在说谎：这一只根本没存过。
   * 有了原字段才分得清「存着的」和「正要选的」。
   */
  savedAvatar?: string
  /**
   * 资料还没读到：此刻「存着的是哪只」是未知的。
   *
   * 没说清楚就会说谎：面板先按默认的一只动物起，保存键写「已保存」——可用户真正
   * 存着的可能是另一只，甚至压根不是动物。资料到了会重挂面板（见 key），所以这里
   * 只需要老实说「还在读」。
   */
  pending?: boolean
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

  /**
   * 存着的头像是不是一只动物。
   *
   * 不是的话（品牌猫、DiceBear），面板里这只只是「还没存的那只」，
   * 保存键得是可点的——按「已保存」告诉用户一只从没存过的动物已经存好了。
   */
  const savedIsAnimal = savedAvatar === undefined ? true : parseAnimalAvatar(savedAvatar) !== undefined

  const dirty = savedIsAnimal ? avatar !== animalAvatar(current.kind, current.hue) : true

  /** 当前选中的那一只叫什么。 */
  const draftName = `${animalOf(draft.kind)?.label ?? draft.kind} · ${animalHueOf(draft.hue).label}`

  /** 已经存着的那一只叫什么。 */
  const savedName = `${animalOf(current.kind)?.label ?? current.kind} · ${animalHueOf(current.hue).label}`

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

  /** 保存键上的字：说清这一步能不能做、做完会怎样。 */
  const saveLabel = pending ? '正在读你的形象…' : disabled ? '这个版本不能改形象' : dirty ? '保存形象' : '已保存'

  /** 一句话说清「存着的是哪只」和「挑的是哪只」。 */
  const statusText = pending
    ? '正在读你存着的形象…'
    : savedIsAnimal
      ? dirty
        ? `现在用的是「${savedName}」，改完点「保存形象」就换过去。`
        : `这就是你现在用的形象：${savedName}。`
      : '你原来的头像还在。选一只保存，就会换掉它。'

  return (
    <div className="animal-studio">
      {/* 预览：这一块是主角（大头像 + 名字 + 动作）。挑选器在下面，只是备选。 */}
      <div className="animal-studio-preview">
        <span className="animal-studio-preview-face">
          <Avatar3D avatarKey={avatar} name="你" seed="you" size={144} tilt action="breathing" />
          <span className="animal-studio-current">{draftName}</span>
        </span>
        <div className="animal-studio-preview-side">
          <p className="animal-studio-title">我的形象</p>
          <p className="animal-studio-desc">选一只动物当你的形象，它会跟着你走进每一段对话。</p>
          <p className="animal-studio-status">{statusText}</p>
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
              {saveLabel}
            </button>
            <button type="button" className="btn" onClick={onPickOther}>
              换别的头像
            </button>
          </div>
          <p className="animal-studio-hint-line">鼠标停在头像上，它会跟着转头。</p>
        </div>
      </div>

      <fieldset className="animal-studio-group">
        <legend>动物</legend>
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
                <span className="animal-studio-pick-art">
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
                  {/* 选中标记：颜色之外的第二重信号（色觉障碍的用户也分得出哪一格被选中）。 */}
                  {selected && (
                    <span className="animal-studio-tick" aria-hidden="true">
                      <Icon name="check" size={16} />
                    </span>
                  )}
                </span>
                <small>{animal.label}</small>
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="animal-studio-group">
        <legend>毛色</legend>
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
                <span className="animal-studio-pick-art">
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
                  {selected && (
                    <span className="animal-studio-tick" aria-hidden="true">
                      <Icon name="check" size={16} />
                    </span>
                  )}
                </span>
                <small>{each.label}</small>
              </button>
            )
          })}
        </div>
      </fieldset>

      <p className="animal-studio-hint">
        <Icon name="user" size={16} />
        形象存在本机，随对话一起告诉助理；换形象不会改你的名字或历史。
      </p>
    </div>
  )
}
