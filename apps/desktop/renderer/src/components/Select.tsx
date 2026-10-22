/**
 * 自绘下拉：模型 / 供应商 / 协议 / 音色这类「有限集合但可能很长」的选择器。
 *
 * 为什么不再用原生 `<select>`：原生弹层是操作系统画的，样式完全不受应用 CSS 控制
 * （暗色主题下那一块是一枚亮白控件，与自绘语言正面冲突），而且选项一多弹层就顶出
 * 窗口边界——用户报的「点开就跑到屏幕外」就是它。因此这里三件事一起做掉：
 *   1. 弹层贴视口：下方放得下就向下，放不下就向上翻，`max-height` 由可用空间给、
 *      内部滚动，永远不越过视口；
 *   2. 选项多时可搜索（模型目录动辄二十项，翻列表不是选模型）；
 *   3. 当前值不在目录里时如实列出来，绝不静默落到第一项——那会让用户以为是自己
 *      操作错了，而不是「这个组合存不下来」。
 *
 * 焦点全程不离开这个控件：打开时落在搜索框（可搜索时）或留在触发按钮上，键盘高亮项
 * 经 `aria-activedescendant` 表达，与 ChatInput 的 @ 提及菜单同一套约定。这样弹层既
 * 可以 portal 到 body（不受祖先 overflow/transform 影响），也不需要焦点陷阱。
 */
import { type ChangeEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon.tsx'

export interface SelectOption {
  value: string
  label: string
  /** 分组标题（原生 `<optgroup>` 的等价物）。渲染成小标题，键盘与搜索都跳过它。 */
  group?: string
  /** 悬停才看得见的补充说明（例如排障用的原始 id），不进无障碍名。 */
  title?: string
}

export interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  /** 必填：这些字段此前是一批裸 `<select>`，其中一部分连可访问名都没有。 */
  ariaLabel: string
  disabled?: boolean
  /** 选项多时才值得开搜索框。 */
  searchable?: boolean
  /** value 不在 options 里时触发器上显示的字；不给就直接显示 value 本身。 */
  placeholder?: string
  /** 搜索没匹配到时的说明。 */
  emptyText?: string
  className?: string
}

/** 贴视口时留的呼吸；也是横向夹取的安全边。 */
const MARGIN = 8
/** 弹层自身的高度上限：再高就该让内部滚了（用户报告的 bug 是弹层越过窗口，不是太高）。 */
const POPOVER_MAX_H = 320
/** 下方不足这么多像素就翻上去；两侧都不够时选更宽敞的那一侧，绝不弹出屏幕外。 */
const MIN_OPEN_SPACE = 140
/** 触发器很窄时（侧栏里的一格）弹层仍要给选项留出读得下的宽度。 */
const MIN_POPOVER_W = 200

type Row = { kind: 'group'; id: string; group: string } | { kind: 'option'; id: string; option: SelectOption }

/** 弹层的位置。向上翻时用 `bottom` 锚定：那样不必先知道弹层多高。 */
interface Placed {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
}

/**
 * 按可用空间定弹层的位置。
 *
 * 「下方放得下就向下」而不是「上下哪边大就往哪边」：一个贴着窗口正中的触发器，上方
 * 可能有 900px、下方只有 200px，用户点它时视线还在这一格附近，凭空往上翻一屏反而是
 * 惊吓。只有下方真的放不下（< MIN_OPEN_SPACE）才翻。
 */
function place(rect: DOMRect, viewportW: number, viewportH: number): Placed {
  const below = viewportH - rect.bottom - MARGIN
  const above = rect.top - MARGIN
  const up = below < MIN_OPEN_SPACE && above > below
  const width = Math.min(Math.max(rect.width, MIN_POPOVER_W), viewportW - MARGIN * 2)
  return {
    left: Math.min(Math.max(rect.left, MARGIN), Math.max(MARGIN, viewportW - width - MARGIN)),
    width,
    maxHeight: Math.max(0, Math.min(POPOVER_MAX_H, up ? above : below)),
    ...(up ? { bottom: viewportH - rect.top + MARGIN } : { top: rect.bottom + MARGIN }),
  }
}

/** 搜索：大小写不敏感的子串，标签与取值都认（模型 id 常常是标签的另一种写法）。 */
function matches(option: SelectOption, needle: string): boolean {
  return option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle)
}

function filterOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...options]
  return options.filter((option) => {
    return matches(option, needle)
  })
}

/** ↑↓ 走位；当前高亮不在列表里（搜索把它筛掉了）时落到第一项。 */
function stepActive(list: readonly SelectOption[], current: string | undefined, step: number): string | undefined {
  if (list.length === 0) return undefined
  const at = list.findIndex((option) => {
    return option.value === current
  })
  if (at < 0) return list[0]?.value
  return list[Math.min(list.length - 1, Math.max(0, at + step))]?.value
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  searchable = false,
  placeholder,
  emptyText = '没有匹配的选项',
  className,
}: SelectProps) {
  const baseId = useId()
  const listId = `${baseId}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string | undefined>(undefined)
  const [placed, setPlaced] = useState<Placed | undefined>(undefined)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const visible = useMemo(() => {
    return filterOptions(options, query)
  }, [options, query])

  const rows = useMemo(() => {
    const out: Row[] = []
    let lastGroup: string | undefined
    for (const option of visible) {
      if (option.group !== undefined && option.group !== lastGroup) {
        out.push({ kind: 'group', id: `${baseId}-g${out.length}`, group: option.group })
      }
      // 每一行都要记住「上一个分组」：无分组的项夹在两组之间时，后一组的小标题必须回来。
      lastGroup = option.group
      out.push({ kind: 'option', id: `${baseId}-o${out.length}`, option })
    }
    return out
  }, [visible, baseId])

  const activeId = rows.find((row) => {
    return row.kind === 'option' && row.option.value === active
  })?.id

  /**
   * 当前值在目录里就显示它的名字，不在就显示 placeholder（没有就显示原值）。
   * 绝不回退到第一项的名字：原生 `<select>` 就是这么干的，用户于是以为是自己选错了。
   */
  const current = options.find((option) => {
    return option.value === value
  })
  const displayLabel = current?.label ?? placeholder ?? value

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  const commit = useCallback(
    (next: string | undefined) => {
      if (next === undefined) {
        close()
        return
      }
      close()
      if (next !== value) onChange(next)
    },
    [close, onChange, value],
  )

  /** 打开时高亮落哪：Enter/点击开就落在当前值，↑ 开落在最后一项，↓ 开落在第一项。 */
  const openList = useCallback(
    (from: 'value' | 'first' | 'last') => {
      if (disabled) return
      const list = filterOptions(options, '')
      setQuery('')
      setOpen(true)
      if (from === 'first') {
        setActive(list[0]?.value)
      } else if (from === 'last') {
        setActive(list[list.length - 1]?.value)
      } else {
        setActive(
          list.some((option) => {
            return option.value === value
          })
            ? value
            : list[0]?.value,
        )
      }
    },
    [disabled, options, value],
  )

  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    if (trigger === null) return
    setPlaced(place(trigger.getBoundingClientRect(), window.innerWidth, window.innerHeight))
  }, [])

  useEffect(() => {
    if (!open) {
      setPlaced(undefined)
      return
    }
    reposition()
    // 捕获阶段收滚动：弹层可能挂在一个会滚的祖先里（弹窗内容区、侧栏），
    // 只听 window 的冒泡滚动收不到那些容器。
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null): boolean => {
      if (target === null || !(target instanceof Node)) return false
      return triggerRef.current?.contains(target) === true || popoverRef.current?.contains(target) === true
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (!inside(event.target)) close()
    }
    // 失焦也算关闭：焦点被别处（Tab 走了、点了另一个控件）带走时，留一个空弹层在屏幕上。
    const onFocusIn = (event: FocusEvent): void => {
      if (!inside(event.target)) close()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
    }
  }, [close, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 抢在 Modal 的 document 捕获监听（关整窗弹窗）之前收掉：一次 Esc 只该关最上面那层。
        event.stopPropagation()
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'Tab') {
        // 不拦默认：焦点该去哪去哪，只是弹层不许跟着走。
        close()
        return
      }
      const list = visible
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((current) => {
          return stepActive(list, current, 1)
        })
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((current) => {
          return stepActive(list, current, -1)
        })
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        setActive(event.key === 'Home' ? list[0]?.value : list[list.length - 1]?.value)
        return
      }
      if (event.key === 'Enter') {
        // 搜索框住在 ProviderSettings 的 <form> 里：不拦这一下，回车会顺手提交整张表单。
        event.preventDefault()
        commit(active)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [active, close, commit, open, visible])

  useEffect(() => {
    // placed 也要在依赖里：弹层要等定位算出坐标才挂载，焦点得等它真的在页面上。
    if (!open || !searchable || placed === undefined) return
    searchRef.current?.focus()
  }, [open, placed, searchable])

  // 目录刷新（音色装好了、模型被供应商下架了）后高亮项可能已经不在列表里：
  // 悬空的高亮既没有 aria-activedescendant 可指，键盘也会停在原地动不了。
  useEffect(() => {
    if (!open) return
    if (
      visible.some((option) => {
        return option.value === active
      })
    ) {
      return
    }
    setActive(visible[0]?.value)
  }, [active, open, visible])

  // 选中项自动滚进视野：长列表里从键盘选到第 20 项时，它不能停在弹层之外看不见。
  useEffect(() => {
    if (!open || activeId === undefined) return
    const node = document.getElementById(activeId)
    // jsdom 没有 scrollIntoView（真机上一定有），别让测试环境整个塌掉。
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [activeId, open])

  const listbox = (
    <div ref={popoverRef} className="select-popover" style={placed} role="presentation">
      {searchable && (
        <div className="select-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            className="select-search-input"
            value={query}
            aria-label={`在「${ariaLabel}」里搜索`}
            aria-autocomplete="list"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeId}
            role="combobox"
            placeholder="输入以筛选"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const next = event.target.value
              setQuery(next)
              setActive(filterOptions(options, next)[0]?.value)
            }}
          />
        </div>
      )}
      <div className="select-list" role="listbox" id={listId} aria-label={ariaLabel}>
        {rows.length === 0 && <p className="select-empty">{emptyText}</p>}
        {rows.map((row) => {
          if (row.kind === 'group') {
            // 小标题不是选项：不进键盘序列，role=presentation 免得读屏把它当可选项念一遍。
            return (
              <div key={row.id} className="select-group" role="presentation">
                {row.group}
              </div>
            )
          }
          const { option } = row
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: 焦点全程留在触发按钮/搜索框上，高亮项经 aria-activedescendant 表达——与 ChatInput 的 @ 提及菜单同一套约定
            <div
              key={row.id}
              id={row.id}
              // 按取值定位一项，而不是按文案：文案随时会改，取值不会。
              data-value={option.value}
              className={`select-option${row.option.value === active ? ' is-active' : ''}`}
              role="option"
              aria-selected={option.value === value}
              title={option.title}
              // mousedown 而不是 click：默认行为先到，焦点已经跑掉了，收起就发生在 click 之前。
              onMouseDown={(event) => {
                event.preventDefault()
                commit(option.value)
              }}
              onMouseEnter={() => {
                setActive(option.value)
              }}
            >
              <span className="select-option-label">{option.label}</span>
              {option.value === value && <Icon name="check" size={14} />}
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <span className={`select${className === undefined ? '' : ` ${className}`}`}>
      {/*
        可搜索时焦点交给弹层里的搜索框（那才是 ARIA 里的 combobox）；否则这一个按钮
        自己就是 combobox，高亮项经 aria-activedescendant 挂在它上面。
        biome-ignore lint/a11y/useAriaPropsSupportedByRole: role 由 searchable 在运行期决定，两种取值里 combobox 都支持 aria-activedescendant，lint 只能看到那个表达式
      */}
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        disabled={disabled}
        role={searchable ? undefined : 'combobox'}
        aria-haspopup={searchable ? undefined : 'listbox'}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !searchable ? activeId : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          if (open) {
            close()
            return
          }
          openList('value')
        }}
        // 收起时的 ↑↓/Enter/Space：Enter 与 Space 由按钮自己派发 click（走上面的分支），
        // ↑↓ 必须自己接——原生 <select> 就是 ↑ 开在第一项、↓ 开在最后一项。
        onKeyDown={(event) => {
          if (open || event.altKey || event.ctrlKey || event.metaKey) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            openList('first')
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            openList('last')
          }
        }}
      >
        <span className="select-value">{displayLabel}</span>
        <span className="select-caret" aria-hidden="true" />
      </button>
      {open && placed !== undefined && createPortal(listbox, document.body)}
    </span>
  )
}
