// @vitest-environment jsdom
/**
 * 视觉设计系统的验收网：把几条约定钉成断言，防止回退。
 *
 *   1. 轻提示必须浮在弹窗遮罩之上（.toast-host > .modal-mask），否则弹窗里
 *      新建/删除 agent 的报错被整块吃掉，只剩一个不动的弹窗。
 *   2. token 是唯一真源：不允许 var(--x, fallback) 这类「就地兜底」把同一个值
 *      抄成第二份，也不允许引用一个根本没定义的 token。
 *   3. 一个组件的边缘只在 styles.css 里定义一次；产品层与扩展层不得各写一套。
 *   4. line-height 一律相对单位：写死 px 会在下级字号上把 CJK 字面压掉。
 *   5. 够不着的东西必须还在：窄窗口下气泡操作条、右栏展开键都不得被裁掉。
 *   6. 暗色用户不被按在浅色上：无存储时跟随系统，启动闪屏也跟主题走。
 *   7. 首屏栅格：消息列与输入卡同宽同缘，两侧 gutter 取同一个 token。
 *   8. 窗口化列表：行进场只在首帧播一次，滚回来的行不重播。
 *   9. Markdown 层级与表格：标题/清单/引用/分隔线/链接各有一档，表格自己横滚。
 *  10. 窄窗口：列表面板先让宽度，且保留一条收起的窄边（折叠键不被裁掉）。
 *
 * 另外两条资产/组件层的约定：品牌猫单源、橘猫是一等头像选项。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
// 路径走 fs 而不是 URL：jsdom 环境会把全局 URL 换成 whatwg 实现，import.meta.url
// 在它那儿解析不出 file: 协议（"The URL must be of scheme file"）。
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { loadTheme } from '../renderer/src/App.tsx'
import type { AgentDef, ApiClient, Conversation } from '../renderer/src/api.ts'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import {
  AVATAR_STYLE_BY_KEY,
  BRAND_AVATAR,
  parseAvatarSpec,
  randomAvatarSpec,
} from '../renderer/src/components/avatars/avatars.tsx'
import { ICONS } from '../renderer/src/components/Icon.tsx'
import { RightPanel } from '../renderer/src/components/RightPanel.tsx'
import { ChatStore } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/src')
const HTML = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/index.html')
const BRAND = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/brand')

/** 去注释后的样式源码：注释里提到的 token / 选择器不算数。 */
const strip = (css: string): string => {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

const STYLESHEETS = ['styles.css', 'styles-product.css', 'styles-provider.css', 'styles-memory.css'] as const
const sheet = (name: (typeof STYLESHEETS)[number]): string => {
  return strip(readFileSync(resolve(SRC, name), 'utf8'))
}
const brandAsset = (name: string): string => {
  return readFileSync(resolve(BRAND, name), 'utf8')
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

/**
 * 顶层规则（不在 @media / @keyframes / @container 内）的「选择器组 → 声明块」。
 * 选择器组按逗号拆开并压掉多余空白，所以 `.a,\n.b { … }` 里问 `.b` 也问得到。
 */
function topLevelRules(css: string): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = []
  let depth = 0
  let ruleStart = 0
  let bodyStart = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth !== 0) continue
      const prelude = css.slice(ruleStart, bodyStart - 1).trim()
      if (!prelude.startsWith('@')) {
        out.push({
          selectors: prelude.split(',').map((sel) => {
            return sel.trim().replace(/\s+/g, ' ')
          }),
          body: css.slice(bodyStart, i),
        })
      }
      ruleStart = i + 1
    }
  }
  return out
}

/** 取某条顶层规则的声明块（找不到返回空串）。 */
function ruleBody(css: string, selector: string): string {
  for (const rule of topLevelRules(css)) {
    if (rule.selectors.includes(selector)) return rule.body
  }
  return ''
}

/**
 * 同一条选择器可能被「规则组」和「逐级覆盖」各写一次，层叠里生效的是靠后的那条。
 * 查具体档位（字号、上边距…）时必须用它，否则会读到规则组那条通用声明。
 */
function effectiveBody(css: string, selector: string): string {
  let found = ''
  for (const rule of topLevelRules(css)) {
    if (rule.selectors.includes(selector)) found = rule.body
  }
  return found
}

/** 某个 at-rule（@media / @container）内部的整段文本（含嵌套规则）。 */
function blockAfter(css: string, marker: string): string {
  const start = css.indexOf(marker)
  if (start < 0) return ''
  const open = css.indexOf('{', start + marker.length)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return ''
}

/** 把 `var(--x)` 链解成它最终指向的数值（只走本文件的 token 图，够用即可）。 */
function resolveValue(value: string, tokens: Map<string, string>): string {
  let current = value.trim()
  for (let depth = 0; depth < 5; depth++) {
    const name = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(current)?.[1]
    if (name === undefined) break
    const next = tokens.get(name)
    if (next === undefined) break
    current = next
  }
  return current
}

/** 某条规则里某个盒模型简写的四边 px 值（padding / margin 通用）。 */
function boxSides(
  body: string,
  prop: string,
  tokens: Map<string, string>,
): { top: number; right: number; bottom: number; left: number } {
  const raw = new RegExp(`${prop}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? ''
  const parts = raw.split(/\s+/).filter((part) => {
    return part !== ''
  })
  const top = parts[0] ?? '0'
  const right = parts[1] ?? top
  const bottom = parts[2] ?? top
  const left = parts[3] ?? right
  return {
    top: Number.parseFloat(resolveValue(top, tokens)),
    right: Number.parseFloat(resolveValue(right, tokens)),
    bottom: Number.parseFloat(resolveValue(bottom, tokens)),
    left: Number.parseFloat(resolveValue(left, tokens)),
  }
}

/** 选择器特异性：id ×1e4 + class/属性/伪类 ×1e2 + 元素。数够这几条规则用。 */
function specificity(selector: string): number {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g)?.length ?? 0
  const types = selector.match(/(^|[\s>+~,])([a-zA-Z][\w-]*)/g)?.length ?? 0
  return ids * 10_000 + classes * 100 + types
}

/**
 * 文件顶层（不在 @media / @keyframes 内）的 class 选择器集合。
 * 两个文件同时给出同一个选择器，就是同一个组件被画了两遍边缘。
 */
function topLevelClassSelectors(css: string): Set<string> {
  const found = new Set<string>()
  for (const rule of topLevelRules(css)) {
    for (const sel of rule.selectors) {
      if (!/\.[a-zA-Z]/.test(sel)) continue
      found.add(sel)
    }
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
    expect(readFileSync(resolve(SRC, 'styles-product.css'), 'utf8')).not.toContain('--accent')
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

describe('够不着的东西必须还在：窄窗口下操作条不被裁掉', () => {
  const base = sheet('styles.css')
  const tokens = themeTokens(base)

  it('操作条通道随消息列自适应，不再是写死的 118px', () => {
    const gutter = tokens.get('--action-gutter') ?? ''
    expect(gutter.startsWith('clamp(')).toBe(true)
    // 3 枚按钮 + 2 道间隙 + 8px 呼吸 = 通道下限；改了按钮尺寸却不同步改下限，
    // 通道就会短一截，按钮重新被裁——所以这条下限从按钮几何算出来。
    const barWidth = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.bubble-action'))?.[1] ?? 0)
    const barGap = Number(/gap:\s*(\d+)px/.exec(ruleBody(base, '.bubble-actions'))?.[1] ?? 0)
    const [lo, middle, hi] = gutter
      .slice('clamp('.length, -1)
      .split(',')
      .map((part) => {
        return part.trim()
      })
    expect(Number.parseFloat(lo ?? '')).toBe(barWidth * 3 + barGap * 2 + 8)
    // 自变量必须是消息列宽（cqw）：同一窗口下收起右栏与否，列宽能差一倍
    expect(middle).toContain('cqw')
    // 上限仍是当初那条 118px 的通道
    expect(Number.parseFloat(hi ?? '')).toBe(118)
  })

  it('窄列断点就是外置通道排不下的那一条（几何自洽，不是拍脑袋的数）', () => {
    const breakpoint = Number(/@container \(max-width: (\d+)px\)/.exec(base)?.[1])
    expect(Number.isFinite(breakpoint)).toBe(true)
    // 气泡最宽 75% 列宽；agent 行左侧还占 40px 头像 + 8px 间隙 ⇒ 右侧只剩
    // 25%W - 48px，加 8px 呼吸；通道要 100px：100 ≤ 25%W - 40 ⟺ W ≥ 560px。
    expect(breakpoint).toBe((100 + 40) * 4)
  })

  it('窄列里操作条贴气泡下沿内侧并常显（窄栏没有 hover 的余裕）', () => {
    const narrow = blockAfter(base, '@container')
    expect(narrow).toContain('.chat-col .from-agent .bubble-actions')
    expect(narrow).toContain('.chat-col .from-user .bubble-actions')
    expect(narrow).toContain('opacity: 1')
    expect(narrow).toContain('pointer-events: auto')
    // 挂在气泡下沿而不是压在气泡上：正文一个字都不能被盖住
    expect(narrow).toMatch(/top:\s*calc\(100%/)
    // 基线仍是 hover 才显，窄列是唯一一条常显的例外
    expect(ruleBody(base, '.bubble-actions')).toContain('opacity: 0')
  })

  it('.chat-scroll 横向溢出被吃掉，.chat-col 有 min-width 保护', () => {
    const scroll = ruleBody(base, '.chat-scroll')
    expect(scroll).toContain('overflow-x: hidden')
    expect(scroll).not.toContain('overflow-x: clip')
    const col = ruleBody(base, '.chat-col')
    expect(col).toContain('min-width: 0')
    // 通道的 cqw 锚在这里：没有容器，clamp 的自变量无处可解
    expect(col).toContain('container-type: inline-size')
  })
})

describe('右栏：收起之后还展得开', () => {
  const base = sheet('styles.css')
  const tokens = themeTokens(base)

  it('收起态留一条够放展开键的窄边，不是 0 宽', () => {
    const collapsed = ruleBody(base, '.right-panel.is-collapsed')
    expect(collapsed).toContain('width: var(--panel-collapsed-w)')
    expect(collapsed).not.toContain('width: 0')
    // 本面板 overflow: hidden：窄边小于展开键宽度，键会被裁掉，右栏就此锁死
    expect(ruleBody(base, '.right-panel')).toContain('overflow: hidden')
    const edge = Number.parseFloat(tokens.get('--panel-collapsed-w') ?? '')
    const btnWidth = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.panel-expand-btn'))?.[1] ?? 0)
    const btnOffset = Number.parseFloat(
      /left:\s*(\d+)px/.exec(ruleBody(base, '.right-panel.is-collapsed .panel-expand-btn'))?.[1] ?? '0',
    )
    expect(edge).toBeGreaterThanOrEqual(btnWidth + btnOffset)
  })

  it('收起时内容退场走 visibility，跟得上 width 过渡', () => {
    expect(ruleBody(base, '.right-panel.is-collapsed .panel-body')).toContain('visibility: hidden')
    expect(ruleBody(base, '.right-panel.is-collapsed .panel-banner')).toContain('visibility: hidden')
    // 延时与宽度过渡等长：内容是滑出去的，不是动画一开始就凭空消失
    expect(ruleBody(base, '.panel-body')).toContain('transition: visibility 0s linear')
    expect(ruleBody(base, '.panel-banner')).toContain('transition: visibility 0s linear')
  })

  it('collapsed 时展开键在，面板本体也还在（否则宽度过渡两向都是硬切）', async () => {
    const agent: AgentDef = {
      id: 'ryen',
      name: 'Ryen',
      systemPrompt: '你是 Ryen。',
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V3',
      tools: [],
      isBuiltin: true,
    }
    const conversation: Conversation = {
      id: 'c1',
      kind: 'direct',
      title: '与 Ryen',
      memberAgentIds: ['ryen'],
      lastReadSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <RightPanel
          api={
            {
              conversationDetail: () => {
                return Promise.resolve({
                  conversation,
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, messages: 0 },
                })
              },
            } as unknown as ApiClient
          }
          store={new ChatStore()}
          conversation={conversation}
          agents={[agent]}
          conversations={[conversation]}
          fileUrl={(name) => {
            return `/api/files/${name}`
          }}
          collapsed={true}
          onToggle={() => {}}
        />,
      )
      await Promise.resolve()
    })
    expect(container.querySelector('.right-panel')?.className).toBe('right-panel is-collapsed')
    expect(container.querySelector('.panel-expand-btn')).not.toBeNull()
    // 早返回会把 .panel-body 一起带走：收起就成了硬切，展开时内容整块重画
    expect(container.querySelector('.panel-body')).not.toBeNull()
    expect(container.textContent).toContain('Ryen')
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})

describe('暗色用户不被按在浅色上', () => {
  const html = readFileSync(HTML, 'utf8')
  const app = readFileSync(resolve(SRC, 'App.tsx'), 'utf8')
  /** index.html 里的内联 splash 样式（整份 HTML 当 CSS 解析会被 <script> 里的括号带偏）。 */
  const splashCss = strip(/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '')

  /** 假系统偏好：vitest 的 jsdom 环境不装 window.matchMedia。 */
  function stubPrefersDark(dark: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => {
      return { matches: query.includes('dark') && dark } as unknown as MediaQueryList
    })
  }

  it('没有存储时跟随系统深浅色（此前一律硬回浅色）', () => {
    localStorage.removeItem('ryagent-theme')
    try {
      stubPrefersDark(true)
      expect(loadTheme()).toBe('dark')
      stubPrefersDark(false)
      expect(loadTheme()).toBe('light')
    } finally {
      vi.unstubAllGlobals()
      localStorage.removeItem('ryagent-theme')
    }
  })

  it('用户自己选过就听用户的，系统偏好不再插手', () => {
    localStorage.setItem('ryagent-theme', 'light')
    try {
      stubPrefersDark(true)
      expect(loadTheme()).toBe('light')
    } finally {
      vi.unstubAllGlobals()
      localStorage.removeItem('ryagent-theme')
    }
  })

  it('index.html：splash 跟系统深色，不再闪一片奶油色', () => {
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/)
    // 底色改由局部 token 给出：写死 #FAF7F2 的正是深色用户看到的那一下闪屏
    expect(ruleBody(splashCss, '#splash')).toContain('background: var(--splash-bg)')
    expect(html).not.toMatch(/#splash \{[^}]*background: #FAF7F2/)
  })

  it('index.html：挂载前那段内联脚本就把 data-theme 定好，且与 App 同一口径', () => {
    const keyInHtml = /localStorage\.getItem\('([^']+)'\)/.exec(html)?.[1]
    const keyInApp = /localStorage\.getItem\('([^']+)'\)/.exec(app)?.[1]
    expect(keyInHtml).toBe(keyInApp)
    expect(html).toContain('document.documentElement.dataset.theme')
    expect(html).toContain('(prefers-color-scheme: dark)')
    // 脚本必须排在 </head> 之前，也排在 React 挂载脚本之前
    expect(html.indexOf('dataset.theme')).toBeLessThan(html.indexOf('</head>'))
    expect(html.indexOf('dataset.theme')).toBeLessThan(html.indexOf('/src/main.tsx'))
  })

  it('暗色下品牌方块仍然看得见（moonshot / ollama 的品牌色几乎就是背景色）', () => {
    const provider = sheet('styles-provider.css')
    // 常驻描边：品牌色再深也还有一圈边
    expect(ruleBody(provider, '.provider-logo')).toContain('0 0 0 1px var(--edge-strong)')
    const lifted = topLevelRules(provider).find((rule) => {
      return rule.selectors.includes(":root[data-theme='dark'] .provider-logo svg")
    })
    expect(lifted?.body).toMatch(/filter:\s*brightness\(/)
  })
})

describe('禁用态会说话', () => {
  const base = sheet('styles.css')

  it('输入框禁用态不是静默吞键：禁用即降亮度与 not-allowed', () => {
    const disabled = ruleBody(base, '.chat-input-box textarea:disabled')
    expect(disabled).toContain('cursor: not-allowed')
    expect(disabled).toContain('color: var(--text-disabled)')
    const wrapper = ruleBody(base, '.chat-input-box:has(textarea:disabled)')
    expect(wrapper).toMatch(/opacity:\s*\./)
    expect(wrapper).toContain('cursor: not-allowed')
  })

  it('载入更早的按钮禁用时退到背景里（文案已经变成「载入中…」）', () => {
    expect(ruleBody(base, '.load-earlier:disabled')).toMatch(/opacity:\s*\./)
    expect(ruleBody(base, '.load-earlier:disabled')).toContain('cursor: default')
  })
})

describe('品牌猫单源', () => {
  it('手写的第二只猫已经退场', () => {
    expect(existsSync(resolve(SRC, 'components/AppIcon.tsx'))).toBe(false)
    expect(existsSync(resolve(SRC, 'assets/lucide/cat-face.svg'))).toBe(false)
    // Lucide 注册表里也不再登记 cat-face / cat：那是几何完全不同的另外两只猫
    const registered: readonly string[] = Object.keys(ICONS)
    expect(registered).not.toContain('cat-face')
    expect(registered).not.toContain('cat')
  })

  it('母版在 assets/brand/cat-face*.svg，且没有领结', () => {
    for (const mood of ['cat-face.svg', 'cat-face-thinking.svg', 'cat-face-happy.svg']) {
      expect(existsSync(resolve(BRAND, mood)), mood).toBe(true)
    }
    const idle = brandAsset('cat-face.svg')
    // 轮廓：脸底板 + 两只三角耳 + 圆眼 + 三角鼻 + 笑嘴，就这些
    expect(idle).toContain('<circle cx="32" cy="36" r="17"')
    expect(idle).toContain('d="M21.5 22.6 L19.6 10.4 L29.1 19.3 Z"')
    expect(idle).toContain('d="M42.5 22.6 L44.4 10.4 L34.9 19.3 Z"')
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

describe('首屏栅格：消息列与输入卡同宽同缘', () => {
  const base = sheet('styles.css')
  const tokens = themeTokens(base)

  it('两侧 gutter 全取同一个 token（此前消息列 32px、输入卡 20px，差出 12px）', () => {
    const gutter = Number.parseFloat(resolveValue('var(--gutter-x)', tokens))
    expect(gutter).toBe(32)
    // 消息列、输入卡、聊天顶栏、断线提示条：四处的左右留白必须是这一个值
    expect(boxSides(ruleBody(base, '.chat-scroll'), 'padding', tokens).left).toBe(gutter)
    expect(boxSides(ruleBody(base, '.chat-input-wrap'), 'padding', tokens).left).toBe(gutter)
    expect(boxSides(ruleBody(base, '.chat-header'), 'padding', tokens).left).toBe(gutter)
    expect(boxSides(ruleBody(base, '.conn-banner'), 'margin', tokens).left).toBe(gutter)
  })

  it('每一处自身左右对称，且没有任何一处再写裸 gutter 值', () => {
    for (const [selector, prop] of [
      ['.chat-scroll', 'padding'],
      ['.chat-input-wrap', 'padding'],
      ['.chat-header', 'padding'],
      ['.conn-banner', 'margin'],
    ] as const) {
      const sides = boxSides(ruleBody(base, selector), prop, tokens)
      expect(sides.left, `${selector} 左右不对称`).toBe(sides.right)
      expect(ruleBody(base, selector), `${selector} 仍在写裸 gutter`).toContain('var(--gutter-x)')
    }
  })

  it('两列宽度上限与居中方式同源，窄窗下也不会差出 24px', () => {
    const col = ruleBody(base, '.chat-col')
    const input = ruleBody(base, '.chat-input-col')
    for (const body of [col, input]) {
      expect(body).toContain('max-width: var(--chat-col)')
      expect(body).toContain('margin: 0 auto')
    }
    // 几何自证：从两个外壳各自的内边距算出两列的宽与左缘，逐个聊天区宽度比对。
    // 未触到 --chat-col 时左缘就等于各自的外壳内边距（32 vs 20 立刻分叉 12px，
    // 宽度差则是两侧各 12px 合计 24px）；触到上限后两边都贴到同一上限，居中后重合。
    const cap = Number.parseFloat(resolveValue('var(--chat-col)', tokens))
    const geometry = (wrapper: string, prop: string) => {
      const gutter = boxSides(ruleBody(base, wrapper), prop, tokens).left
      return (areaWidth: number): { width: number; left: number } => {
        const available = areaWidth - gutter * 2
        const width = Math.min(available, cap)
        return { width, left: gutter + (available - width) / 2 }
      }
    }
    const messageCol = geometry('.chat-scroll', 'padding')
    const composer = geometry('.chat-input-wrap', 'padding')
    for (const areaWidth of [372, 408, 560, 900, 1600]) {
      expect(messageCol(areaWidth), `聊天区 ${areaWidth}px 下两列不同宽`).toEqual(composer(areaWidth))
    }
  })
})

describe('窗口化列表：行进场只在首帧播一次', () => {
  const base = sheet('styles.css')

  it('基线仍给整列错落进场（--i 照旧封顶 8 档）', () => {
    const item = ruleBody(base, '.conversation-item')
    expect(item).toContain('animation: item-in')
    expect(item).toContain('calc(min(var(--i, 0), 8) * 30ms)')
  })

  it('data-windowed="true" 的列表把默认动画关掉，只留 .is-animated 的首帧行', () => {
    const off = `.conversation-list[data-windowed='true'] .conversation-item`
    const on = `${off}.is-animated`
    expect(ruleBody(base, off)).toMatch(/animation:\s*none/)
    expect(ruleBody(base, on)).toContain('animation: item-in')
    expect(ruleBody(base, on)).toContain('calc(min(var(--i, 0), 8) * 30ms)')
  })

  it('恢复动画那条必然赢过关掉它那条，不靠源码顺序', () => {
    const off = `.conversation-list[data-windowed='true'] .conversation-item`
    const on = `${off}.is-animated`
    expect(specificity(on)).toBeGreaterThan(specificity(off))
    expect(specificity(off)).toBeGreaterThan(specificity('.conversation-item'))
  })
})

describe('Markdown 层级与表格', () => {
  const base = sheet('styles.css')

  it('标题层级：越浅越大、离上一段越远（五级往下改用次级色分层）', () => {
    const tokens = themeTokens(base)
    const read = (depth: string, prop: string): number => {
      return Number.parseFloat(
        resolveValue(
          new RegExp(`${prop}:\\s*([^;]+);`).exec(effectiveBody(base, `.bubble-md ${depth}`))?.[1] ?? '0',
          tokens,
        ),
      )
    }
    const fontSizes = ['h1', 'h2', 'h3', 'h4', 'h5'].map((depth) => {
      return read(depth, 'font-size')
    })
    const margins = ['h1', 'h2', 'h3', 'h4', 'h5'].map((depth) => {
      return read(depth, 'margin-top')
    })
    // 一到四级：字号与上边距逐级收。两档撞成同一号，层级就白设了
    for (let i = 1; i < 4; i++) {
      expect(fontSizes[i], `h${i + 1} 没比 h${i} 小`).toBeLessThan(fontSizes[i - 1] as number)
      expect(margins[i], `h${i + 1} 没比 h${i} 收`).toBeLessThanOrEqual(margins[i - 1] as number)
    }
    // 五级往下不再靠字号分层：再降就掉到 --fs-xs 的 CJK 可读下限以下，
    // 改用次级色当「这是小节标签」的唯一信号。
    expect(fontSizes[4]).toBe(fontSizes[3])
    expect(effectiveBody(base, '.bubble-md h5')).toContain('color: var(--text-secondary)')
    expect(effectiveBody(base, '.bubble-md h6')).toContain('color: var(--text-secondary)')
    // 首块不留上边距：标题再浅也不该把气泡顶出一个台阶
    expect(specificity('.bubble-md > :first-child')).toBeGreaterThan(specificity('.bubble-md h1'))
  })

  it('清单逐级缩进，标记压次级色', () => {
    const tokens = themeTokens(base)
    const indent = (selector: string): number => {
      return Number.parseFloat(
        resolveValue(/padding-left:\s*([^;]+);/.exec(effectiveBody(base, selector))?.[1] ?? '0', tokens),
      )
    }
    expect(indent('.bubble-md ul')).toBe(24)
    expect(indent('.bubble-md ol')).toBe(24)
    // 嵌套一档收 8px：浏览器默认一缩就是 40px，在气泡里直接顶到正文上沿
    expect(indent('.bubble-md li ul')).toBe(20)
    expect(indent('.bubble-md li ol')).toBe(20)
    expect(ruleBody(base, '.bubble-md li::marker')).toContain('color: var(--text-tertiary)')
  })

  it('表格自己横向滚：宽表不撑破气泡（外壳是 overflow-x: hidden）', () => {
    const table = ruleBody(base, '.bubble-md table')
    // <table> 自身当滚动容器：没有包装节点可依赖
    expect(table).toContain('display: block')
    expect(table).toContain('overflow-x: auto')
    expect(table).toContain('max-width: 100%')
    expect(ruleBody(base, '.chat-scroll')).toContain('overflow-x: hidden')
  })

  it('表格边框、表头底色、单元格留白各有一档，且都走 token', () => {
    const cell = ruleBody(base, '.bubble-md td')
    expect(cell).toContain('border: 1px solid var(--edge)')
    expect(cell).toContain('text-align: left')
    expect(ruleBody(base, '.bubble-md th')).toContain('border: 1px solid var(--edge)')
    expect(effectiveBody(base, '.bubble-md th')).toContain('background: var(--bg-subtle)')
  })

  it('引用块 / 分隔线 / 链接 / 行内代码都有配套，且无裸色值', () => {
    expect(ruleBody(base, '.bubble-md blockquote')).toContain('border-left: 3px solid var(--amber-text)')
    expect(ruleBody(base, '.bubble-md hr')).toContain('border-top: 1px solid var(--divider)')
    expect(ruleBody(base, '.bubble-md a:hover')).toContain('color: var(--amber-primary-hover)')
    expect(ruleBody(base, '.bubble-md a:focus-visible')).toContain('outline: 2px solid var(--focus-outline)')
    // 行内代码不能顺手把围栏代码也画上底色（围栏那块由 styles-content.css 复位）
    expect(ruleBody(base, '.bubble-md code:not(.md-code *)')).toContain('background: var(--bg-subtle)')
    const markdown = topLevelRules(base).filter((rule) => {
      return rule.selectors.some((sel) => {
        return sel.startsWith('.bubble-md')
      })
    })
    for (const rule of markdown) {
      expect(rule.body.match(/#[0-9A-Fa-f]{3,8}|\brgba?\(/g), `${rule.selectors.join(' ')} 有裸色值`).toBeNull()
    }
  })

  it('自己的琥珀气泡里，引用块与表格的底色/描边跟着翻过来', () => {
    expect(base).toContain('.bubble-row.from-user .bubble-bubble .bubble-md blockquote')
    expect(base).toContain('.bubble-row.from-user .bubble-bubble .bubble-md th')
    // 翻面规则只改底色与描边，不碰字号/间距（否则两条气泡的排版会分叉）
    const flipped = topLevelRules(base).filter((rule) => {
      return rule.selectors.some((sel) => {
        return sel.startsWith('.bubble-row.from-user .bubble-bubble .bubble-md')
      })
    })
    expect(flipped.length).toBeGreaterThan(0)
    for (const rule of flipped) {
      expect(rule.body, rule.selectors.join(' ')).not.toMatch(/font-size|margin-top|padding:/)
    }
  })
})

describe('窄窗口：列表面板先让宽度', () => {
  const base = sheet('styles.css')
  const tokens = themeTokens(base)

  it('1200px 以下列表让到 240px，1040px 以下让到 200px（1024 窗口的聊天区不再只剩 372px）', () => {
    expect(ruleBody(base, '.list-panel')).toContain('width: var(--list-panel-w)')
    const md = blockAfter(base, '@media (max-width: 1199px)')
    const sm = blockAfter(base, '@media (max-width: 1040px)')
    expect(md).toContain('.list-panel')
    expect(sm).toContain('.list-panel')
    const mdWidth = Number.parseFloat(resolveValue(/width:\s*([^;]+);/.exec(md)?.[1] ?? '0', tokens))
    const smWidth = Number.parseFloat(resolveValue(/width:\s*([^;]+);/.exec(sm)?.[1] ?? '0', tokens))
    const full = Number.parseFloat(resolveValue('var(--list-panel-w)', tokens))
    expect([full, mdWidth, smWidth]).toEqual([300, 240, 200])
    // 1024px 窗口：72(rail) + 200(列表) + 280(右栏) 之外，聊天区还剩 472px
    const rail = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.rail'))?.[1] ?? 0)
    const right = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.right-panel'))?.[1] ?? 0)
    expect(1024 - rail - smWidth - right).toBeGreaterThan(372)
  })

  it('收起态留一条够放折叠键的窄边，不是 0 宽（宽度归零就再也展不开）', () => {
    const collapsed = ruleBody(base, '.list-panel.is-collapsed')
    expect(collapsed).toContain('width: var(--panel-collapsed-w)')
    expect(collapsed).not.toContain('width: 0')
    expect(collapsed).toContain('overflow: hidden')
    const edge = Number.parseFloat(tokens.get('--panel-collapsed-w') ?? '')
    const btnWidth = Number(/width:\s*(\d+)px/.exec(ruleBody(base, '.list-panel-toggle'))?.[1] ?? 0)
    const btnOffset = Number.parseFloat(
      /left:\s*(\d+)px/.exec(ruleBody(base, '.list-panel.is-collapsed .list-panel-toggle'))?.[1] ?? '0',
    )
    expect(edge).toBeGreaterThanOrEqual(btnWidth + btnOffset)
    // 内容退场走 visibility，延时跟得上 width 过渡（与右栏同一套降级对）
    expect(ruleBody(base, '.list-panel.is-collapsed .list-panel-header')).toContain('visibility: hidden')
    expect(ruleBody(base, '.list-panel')).toContain('transition: width')
  })

  it('折叠键让开搜索框，且只在真的挂了键时才让', () => {
    expect(ruleBody(base, '.list-panel:has(.list-panel-toggle) .search-box')).toContain('padding-right: 40px')
    expect(specificity('.list-panel:has(.list-panel-toggle) .search-box')).toBeGreaterThan(
      specificity('.search-box.has-icon'),
    )
  })
})
