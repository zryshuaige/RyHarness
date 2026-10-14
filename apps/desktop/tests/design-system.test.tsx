/**
 * 视觉设计系统的验收网：把几条约定钉成断言，防止回退。
 *
 *   1. 轻提示必须浮在弹窗遮罩之上（.toast-host > .modal-mask），否则弹窗里
 *      新建/删除 agent 的报错被整块吃掉，只剩一个不动的弹窗。
 *   2. token 是唯一真源：不允许 var(--x, fallback) 这类「就地兜底」把同一个值
 *      抄成第二份，也不允许引用一个根本没定义的 token。
 *   3. 一个组件的边缘只在 styles.css 里定义一次；产品层与扩展层不得各写一套。
 *   4. line-height 一律相对单位：写死 px 会在下级字号上把 CJK 字面压掉。
 *
 * 另外两条资产/组件层的约定：品牌猫单源、橘猫是一等头像选项。
 */
import { existsSync, readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import {
  AVATAR_STYLE_BY_KEY,
  BRAND_AVATAR,
  parseAvatarSpec,
  randomAvatarSpec,
} from '../renderer/src/components/avatars/avatars.tsx'
import { ICONS } from '../renderer/src/components/Icon.tsx'

const SRC = new URL('../renderer/src/', import.meta.url)
const BRAND = new URL('../assets/brand/', import.meta.url)

/** 去注释后的样式源码：注释里提到的 token / 选择器不算数。 */
const strip = (css: string): string => {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

const STYLESHEETS = ['styles.css', 'styles-product.css', 'styles-provider.css', 'styles-memory.css'] as const
const sheet = (name: (typeof STYLESHEETS)[number]): string => {
  return strip(readFileSync(new URL(name, SRC), 'utf8'))
}
const brandAsset = (name: string): string => {
  return readFileSync(new URL(name, BRAND), 'utf8')
}

/** :root / :root[data-theme=...] 块里声明的 token（含各主题覆盖）。 */
function themeTokens(css: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const block of css.matchAll(/(?:^|[{};])\s*:root[^{]*\{([^}]*)\}/g)) {
    for (const decl of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out.set(decl[1] as string, (decl[2] as string).trim())
    }
  }
  return out
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g

/** 取某条顶层规则的声明块（找不到返回空串）。 */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(`(?:^|})\\s*${selector.replace(ESCAPE, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')
  return re.exec(css)?.[1] ?? ''
}

/**
 * 文件顶层（不在 @media / @keyframes 内）的 class 选择器集合。
 * 两个文件同时给出同一个选择器，就是同一个组件被画了两遍边缘。
 */
function topLevelClassSelectors(css: string): Set<string> {
  const found = new Set<string>()
  let depth = 0
  let prelude = ''
  for (const ch of css) {
    if (ch === '{') {
      if (depth === 0) {
        for (const part of prelude.split(',')) {
          const sel = part.trim().replace(/\s+/g, ' ')
          if (sel.startsWith('@') || !/\.[a-zA-Z]/.test(sel)) continue
          found.add(sel)
        }
      }
      depth += 1
      prelude = ''
      continue
    }
    if (ch === '}') {
      depth -= 1
      prelude = ''
      continue
    }
    prelude += ch
  }
  return found
}

describe('层级：轻提示必须高于弹窗遮罩', () => {
  const tokens = themeTokens(sheet('styles.css'))

  it('z 层级走 token，且 --z-toast > --z-modal', () => {
    const sticky = Number(tokens.get('--z-sticky'))
    const popover = Number(tokens.get('--z-popover'))
    const modal = Number(tokens.get('--z-modal'))
    const toast = Number(tokens.get('--z-toast'))
    expect([sticky, popover, modal, toast].every(Number.isFinite)).toBe(true)
    // 本轮修的那个 bug 的核心断言
    expect(toast).toBeGreaterThan(modal)
    // 层级顺序本身也得成立，否则遮罩会盖住 @ 提及菜单
    expect(popover).toBeLessThan(modal)
    expect(sticky).toBeLessThan(popover)
  })

  it('.toast-host 与 .modal-mask 都从 token 取值，不各自写死', () => {
    expect(ruleBody(sheet('styles-product.css'), '.toast-host')).toContain('z-index: var(--z-toast)')
    expect(ruleBody(sheet('styles.css'), '.modal-mask')).toContain('z-index: var(--z-modal)')
    // 宿主整块不吃点击：浮到弹窗之上后只有提示本体与关闭键可点
    expect(ruleBody(sheet('styles-product.css'), '.toast-host')).toContain('pointer-events: none')
    expect(ruleBody(sheet('styles-product.css'), '.toast')).toContain('pointer-events: auto')
    // 全站不再有裸 z-index 数字
    for (const name of STYLESHEETS) {
      expect(sheet(name).match(/z-index:\s*\d/), `${name} 仍有裸 z-index`).toBeNull()
    }
  })
})

describe('token 是唯一真源', () => {
  it('没有 var(--x, fallback) 形式的第二真源', () => {
    // --i 例外：它是组件通过 style={{ '--i': 序号 }} 就地传入的 stagger 序号，
    // 不是设计 token，兜底 0 是语义默认值而不是抄来的样式值。
    for (const name of STYLESHEETS) {
      const hits = sheet(name)
        .replace(/var\(\s*--i\s*,\s*0\s*\)/g, '')
        .match(/var\(\s*--[a-z0-9-]+\s*,/g)
      expect(hits, `${name} 仍有就地兜底: ${hits?.join(' ')}`).toBeNull()
    }
    // --accent 曾是 styles-product.css 里就地兜底出来的幽灵 token，已彻底退场
    expect(readFileSync(new URL('styles-product.css', SRC), 'utf8')).not.toContain('--accent')
  })

  it('用到的 token 都在样式里定义过', () => {
    const defined = new Set<string>(['--i']) // 组件内联传入
    for (const name of STYLESHEETS) {
      for (const m of sheet(name).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1] as string)
    }
    for (const name of STYLESHEETS) {
      for (const m of sheet(name).matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        const token = m[1] as string
        expect(defined.has(token), `${name} 引用了未定义的 ${token}`).toBe(true)
      }
    }
  })

  it('line-height 不写死像素（px 会在下级字号上压掉 CJK 字面）', () => {
    for (const name of STYLESHEETS) {
      expect(sheet(name).match(/line-height:\s*[\d.]+px/), `${name} 仍有 px line-height`).toBeNull()
    }
  })
})

describe('一个组件的边缘只定义一次', () => {
  it('扩展层不重画 styles.css 的选择器', () => {
    const base = topLevelClassSelectors(sheet('styles.css'))
    for (const name of ['styles-product.css', 'styles-provider.css', 'styles-memory.css'] as const) {
      const overlap = [...topLevelClassSelectors(sheet(name))].filter((sel) => base.has(sel))
      expect(overlap, `${name} 与 styles.css 重复定义: ${overlap.join(' / ')}`).toEqual([])
    }
  })

  it('欢迎页与聊天页的 composer 是同一个长相（同一档阴影，不叠描边）', () => {
    const inputCol = ruleBody(sheet('styles.css'), '.chat-input-col')
    const welcome = ruleBody(sheet('styles-product.css'), '.welcome-compose')
    expect(inputCol).toContain('box-shadow: var(--shadow-2)')
    expect(welcome).toContain('box-shadow: var(--shadow-2)')
    // 抬起面只用阴影：两个 composer 都不再叠描边
    expect(inputCol).toMatch(/border:\s*none/)
    expect(welcome).toMatch(/border:\s*none/)
  })

  it('.btn 是白底控件，靠那 1px --edge 站住（阴影在纯白底上等于没有）', () => {
    const btn = ruleBody(sheet('styles.css'), '.btn')
    expect(btn).toContain('border: 1px solid var(--edge)')
    expect(btn).toContain('box-shadow: var(--shadow-1)')
  })
})

describe('品牌猫单源', () => {
  it('手写的第二只猫已经退场', () => {
    expect(existsSync(new URL('components/AppIcon.tsx', SRC))).toBe(false)
    expect(existsSync(new URL('assets/lucide/cat-face.svg', SRC))).toBe(false)
    // Lucide 注册表里也不再登记 cat-face / cat：那是几何完全不同的另外两只猫
    const registered: readonly string[] = Object.keys(ICONS)
    expect(registered).not.toContain('cat-face')
    expect(registered).not.toContain('cat')
  })

  it('母版在 assets/brand/cat-face*.svg，且没有领结', () => {
    for (const mood of ['cat-face.svg', 'cat-face-thinking.svg', 'cat-face-happy.svg']) {
      expect(existsSync(new URL(mood, BRAND)), mood).toBe(true)
    }
    const idle = brandAsset('cat-face.svg')
    // 轮廓：脸底板 + 两只三角耳 + 圆眼 + 三角鼻 + 笑嘴，就这些
    expect(idle).toContain('<circle cx="32" cy="35.5" r="15.2"')
    expect(idle).toContain('d="M24 26.4 L17 10.4 L34 22 Z"')
    expect(idle).toContain('d="M40 26.4 L47 9 L30 21.8 Z"')
    // 领结是此前 AppIcon 那只手绘猫的记号，母版里不许再出现
    expect(idle).not.toMatch(/bow|领结/)
  })

  it('墨色走 token：母版只挂 class，颜色由 CSS 决定', () => {
    expect(brandAsset('cat-face.svg')).toContain('class="ink"')
    expect(brandAsset('cat-face.svg')).toContain('class="inkf"')
    const base = sheet('styles.css')
    expect(ruleBody(base, '.cat .ink')).toContain('stroke: var(--cat-ink)')
    expect(ruleBody(base, '.cat .inkf')).toContain('fill: var(--cat-ink)')
    // 浅色是暖棕手绘感，暗色必须翻成暖浅色，否则整只猫糊进背景：两个主题各一份
    expect([...base.matchAll(/--cat-ink:\s*(#[0-9A-Fa-f]{6})/g)].map((m) => m[1])).toHaveLength(2)
  })
})

describe('橘猫是一等头像选项', () => {
  it("品牌键是常量 'cat'，由 Avatar 的品牌分支接手而非 DiceBear 白名单", () => {
    expect(BRAND_AVATAR).toBe('cat')
    expect(AVATAR_STYLE_BY_KEY.cat).toBeUndefined()
    expect(parseAvatarSpec(BRAND_AVATAR)).toBeNull()
  })

  it('「换一批」随时能产出品牌橘猫（品牌必须可达，不能只在数据库里）', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      expect(randomAvatarSpec()).toBe('cat')
    } finally {
      random.mockRestore()
    }
  })

  it("avatarKey='cat' 渲染真正的猫，既不是首字母色块也不是骨架", () => {
    const html = renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={40} />)
    expect(html).toContain('avatar-cat')
    expect(html).toContain('<svg class="cat"')
    expect(html).not.toContain('avatar-fallback')
    expect(html).not.toContain('avatar-loading')
  })
})
