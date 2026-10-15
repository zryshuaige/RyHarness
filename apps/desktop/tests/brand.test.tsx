// @vitest-environment jsdom

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
// 路径走 fs 而不是 URL：jsdom 环境会把全局 URL 换成 whatwg 实现，import.meta.url
// 在它那儿解析不出 file: 协议。
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import { AVATAR_SPEC, loadAvatarStyle } from '../renderer/src/components/avatars/avatars.tsx'
import { GroupAvatar } from '../renderer/src/components/avatars/GroupAvatar.tsx'

/**
 * 品牌一致性的验收网（复评 P0）：
 *
 *   1. 母版唯一性 —— 全应用只有 apps/desktop/assets/brand/cat-face*.svg 这一份猫的
 *      几何。派生图标（icon / favicon / icon-mono）、应用内 <Cat>、启动屏都必须能
 *      逐元素回溯到它；顺手钉住「零外部素材」。
 *   2. 暗色主题五官可见 —— 脸底色与五官墨色成对翻，实测对比度 ≥ 4.5:1。此前暗色下
 *      浅墨压在奶油脸底（#FFFDF8）上只有 1.23:1，等于那只猫没有五官。
 *   3. 头像规格一致 —— 猫 / DiceBear 风格 / 加载骨架 / 首字符兜底走同一块画布，
 *      24 / 32 / 48 / 64px 下规格一致且仍可辨识。
 */

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(DESKTOP, 'renderer/src')
const HTML_FILE = join(DESKTOP, 'renderer/index.html')
const BRAND = join(DESKTOP, 'assets/brand')
const CREAM = '#FFFDF8'
const AMBER_MID = '#E9A825'

const readBrand = (name: string): string => {
  return readFileSync(resolve(BRAND, name), 'utf8')
}

/** 折叠所有空白：用来跨文件比对同一段 SVG（缩进不同不算内容不同）。 */
const squash = (text: string): string => {
  return text.replace(/\s+/g, ' ').trim()
}
const stripComments = (css: string): string => {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

const html = readFileSync(HTML_FILE, 'utf8')
const catCss = readFileSync(resolve(SRC, 'assets/brand/cat.css'), 'utf8')
const stylesCss = stripComments(readFileSync(resolve(SRC, 'styles.css'), 'utf8'))

/** 取某条规则的声明块（按花括号配对，支持嵌在 @media 里的规则）。 */
function ruleBody(css: string, selector: string): string {
  const needle = squash(selector)
  let from = 0
  for (;;) {
    const at = css.indexOf(needle, from)
    if (at < 0) return ''
    const open = css.indexOf('{', at)
    // 选择器与 { 之间只允许空白，避免 `:root` 误命中 `:root[data-theme='light']`
    if (open >= 0 && css.slice(at + needle.length, open).trim() === '') {
      let depth = 0
      let end = open
      for (; end < css.length; end++) {
        if (css[end] === '{') depth++
        else if (css[end] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      return css.slice(open + 1, end)
    }
    from = at + needle.length
  }
}

/** 某个选择器块里声明的自定义属性。 */
function tokensOf(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const decl of ruleBody(css, selector).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(decl[1] as string, (decl[2] as string).trim())
  }
  return out
}

const hexOf = (value: string | undefined): string => {
  const hit = /#[0-9a-fA-F]{6}/.exec(value ?? '')
  if (hit === null) throw new Error(`not a 6-digit hex color: ${String(value)}`)
  return hit[0]
}

function luminance(hex: string): number {
  const hit = /^#([0-9a-f]{6})$/i.exec(hex)
  if (hit === null) throw new Error(`not a 6-digit hex color: ${hex}`)
  const packed = Number.parseInt(hit[1] as string, 16)
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const r = channel((packed >> 16) & 0xff)
  const g = channel((packed >> 8) & 0xff)
  const b = channel(packed & 0xff)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 相对亮度对比度。 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => {
    return y - x
  })
  return (hi + 0.05) / (lo + 0.05)
}

const splashCss = stripComments(/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '')
const splashSvg = /<svg class="splash-mark"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? ''

describe('母版唯一性：只有 assets/brand/cat-face*.svg 这一只猫', () => {
  it('品牌目录里只有「三态母版 + 三份派生图标」，没有第四份猫的造型', () => {
    expect(
      readdirSync(BRAND)
        .filter((name) => {
          return name.endsWith('.svg')
        })
        .sort(),
    ).toEqual([
      'cat-face-happy.svg',
      'cat-face-thinking.svg',
      'cat-face.svg',
      'favicon.svg',
      'icon-mono.svg',
      'icon.svg',
    ])
    // 手写过的第二只猫（AppIcon.tsx / lucide 里的 cat-face）不许复活
    expect(existsSync(resolve(SRC, 'components/AppIcon.tsx'))).toBe(false)
    expect(existsSync(resolve(SRC, 'assets/lucide/cat-face.svg'))).toBe(false)
    expect(existsSync(resolve(SRC, 'assets/lucide/cat.svg'))).toBe(false)
  })

  it('三态只换五官与星光：脸 + 双耳的轮廓逐字符相同', () => {
    const silhouette = (mood: string): string => {
      return readBrand(mood)
        .split('\n')
        .filter((line) => {
          return /cx="32" cy="36"|L19\.6 10\.4|L44\.4 10\.4/.test(line)
        })
        .map((line) => {
          return line.trim()
        })
        .join(' ')
    }
    const idle = silhouette('cat-face.svg')
    expect(squash(idle)).toContain('r="17"')
    expect(squash(silhouette('cat-face-thinking.svg'))).toBe(squash(idle))
    expect(squash(silhouette('cat-face-happy.svg'))).toBe(squash(idle))
    // 此前那只手工猫带胡须/领结，母版里不许再出现这些记号
    expect(readBrand('cat-face.svg')).not.toMatch(/bow|领结|whisker/)
  })

  it('派生图标与应用内 <Cat> 同源：icon / favicon 就是母版（class 钩子换成静态色值）', () => {
    // 与 scripts/gen-icon.mjs 同一套变换：墨色 class 换成写死的描边/填充，
    // 只服务应用内主题的 class（face）不参与静态导出。
    const derived = readBrand('cat-face.svg')
      .trim()
      .replaceAll('class="ink" ', 'stroke="#4a2e1a" ')
      .replaceAll('class="inkf" ', '')
      .replaceAll('class="face" ', '')
    expect(squash(readBrand('icon.svg'))).toContain(squash(derived))
    expect(squash(readBrand('favicon.svg'))).toContain(squash(derived))
  })

  it('单色剪影 icon-mono.svg 的头、耳、五官也都来自同一份母版', () => {
    // 单色版就是母版本身：只把主题钩子换成写死的颜色与描边，不另抄一份几何
    // （早期 gen-icon 里手抄过一份头与五官，母版一改就跟着跑偏）。
    const bare = (text: string): string => {
      return squash(text)
        .replaceAll(/ class="[a-z ]*"/g, '')
        .replaceAll(/ fill="#[0-9a-f]{6}"/gi, '')
        .replaceAll(/ stroke="#[0-9a-f]{6}"/gi, '')
        .replaceAll(/ style="[^"]*"/g, '')
        .replaceAll(' stroke-linecap="round"', '')
    }
    const mono = bare(readBrand('icon-mono.svg'))
    const master = bare(readBrand('cat-face.svg'))
    for (const geometry of [
      '<circle cx="32" cy="36" r="17"/>',
      '<path d="M21.5 22.6 L19.6 10.4 L29.1 19.3 Z"/>',
      '<path d="M42.5 22.6 L44.4 10.4 L34.9 19.3 Z"/>',
      '<circle cx="26.4" cy="34.8" r="2.7"/>',
      '<circle cx="37.6" cy="34.8" r="2.7"/>',
      '<path d="M29.8 39.4 L32 42.6 L34.2 39.4 Z"/>',
      '<path d="M27.5 44.2 q2.25 3.9 4.5 0 q2.25 3.9 4.5 0"',
    ]) {
      expect(mono, geometry).toContain(geometry)
      // 同一段几何必须原样出现在母版里
      expect(master, geometry).toContain(geometry)
    }
    // 单色版没有底板：深色底上直接可用
    expect(readBrand('icon-mono.svg')).not.toContain('ryagent-plate')
  })

  it('渲染层里再也没有第二处猫的几何（唯一出现处是启动屏那份母版原文）', () => {
    const ear = 'M21.5 22.6 L19.6 10.4 L29.1 19.3 Z'
    const offenders: string[] = []
    for (const file of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
      if (/\.(png|jpe?g|webp|gif|woff2?)$/.test(file)) continue
      const full = resolve(SRC, file)
      let text = ''
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (text.includes(ear)) offenders.push(file)
    }
    // Cat.tsx 走 ?raw 导入母版，源码里不该出现几何；真出现就是手抄了第二只猫
    expect(offenders).toEqual([])
    // 启动屏那份必须与母版逐字符相同（只允许换颜色，不允许第二个造型）
    expect(squash(splashSvg)).toContain(squash(readBrand('cat-face.svg').trim()))
  })

  it('零外部素材：品牌 SVG 与启动屏都不引用站外资源', () => {
    for (const name of readdirSync(BRAND)) {
      if (!name.endsWith('.svg')) continue
      const svg = readBrand(name)
      expect(svg, name).not.toMatch(/<(image|use)\b/)
      // 只允许 SVG 命名空间与 xlink 这类协议声明，不允许任何真实外链
      expect(svg.replace(/xmlns(:\w+)?="[^"]*"/g, ''), name).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    }
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => {
      return m[1] as string
    })
    for (const ref of refs) {
      expect(ref, ref).not.toMatch(/^https?:/)
    }
  })
})

describe('启动屏：同一只猫，只换颜色', () => {
  it('splash 里内联的就是母版本身，底板与应用图标同一个 squircle', () => {
    expect(splashSvg).not.toBe('')
    expect(splashSvg).toContain('viewBox="0 0 64 64"')
    // 此前是一版 1024 网格的手写猫（另起炉灶 + 领结 + 另一套墨色），现已退场
    expect(html).not.toContain('viewBox="0 0 1024 1024"')
    expect(squash(splashSvg)).toContain('id="ryen-cat-idle"')
    // 底板与应用图标 icon.svg 逐字符相同
    const plate = /d="(M32 2 C46\.375[^"]+)"/.exec(readBrand('icon.svg'))?.[1]
    expect(plate).toBeDefined()
    expect(squash(splashSvg)).toContain(squash(plate as string))
  })

  it('splash 的脸底色/墨色与应用内同一套口径，暗色下也看得见五官', () => {
    const light = tokensOf(splashCss, ':root')
    const dark = tokensOf(splashCss, ":root[data-theme='dark']")
    // 系统暗色兜底那条媒体查询也得给同一组值（脚本还没跑的那一瞬就在用它）
    const systemDark = tokensOf(splashCss, ":root:not([data-theme='light'])")
    expect(
      contrast(hexOf(light.get('--splash-cat-ink')), hexOf(light.get('--splash-cat-face'))),
    ).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hexOf(dark.get('--splash-cat-ink')), hexOf(dark.get('--splash-cat-face')))).toBeGreaterThanOrEqual(
      4.5,
    )
    // 系统暗色兜底那条媒体查询也得给同一组值（脚本没跑的那一瞬就在用）
    expect(systemDark.get('--splash-cat-face')).toBe(dark.get('--splash-cat-face'))
    expect(systemDark.get('--splash-cat-ink')).toBe(dark.get('--splash-cat-ink'))
  })
})

describe('暗色主题下吉祥物有五官（对比度 ≥ 4.5:1）', () => {
  // styles.css 里浅色主题是 :root[data-theme='light'] 这一份（基础 :root 不含 --cat-ink）
  const lightInk = hexOf(tokensOf(stylesCss, ":root[data-theme='light']").get('--cat-ink'))
  const darkInk = hexOf(tokensOf(stylesCss, ":root[data-theme='dark']").get('--cat-ink'))
  const lightFace = hexOf(ruleBody(catCss, '.cat .face').match(/fill:\s*([^;]+);/)?.[1])
  const darkFace = hexOf(ruleBody(catCss, "[data-theme='dark'] .cat .face").match(/fill:\s*([^;]+);/)?.[1])

  it('墨色确实跟着主题翻（浅色暖棕 → 暗色暖浅色）', () => {
    expect(lightInk).toBe('#4A2E1A')
    expect(darkInk).toBe('#F0E4D2')
    expect(luminance(darkInk)).toBeGreaterThan(luminance(lightInk))
  })

  it('脸底色跟着一起翻：否则浅墨压在奶油底上只有 1.23:1', () => {
    expect(lightFace).toBe(CREAM)
    // 这就是复评记的那 1.23:1 —— 本条存在的理由，钉住它不许回退
    expect(contrast(darkInk, CREAM)).toBeLessThan(4.5)
    expect(darkFace).not.toBe(CREAM)
    expect(contrast(darkInk, darkFace)).toBeGreaterThanOrEqual(4.5)
    // 脸底在暗色下还要与琥珀底板分得开，否则整只猫糊成一个琥珀块
    expect(contrast(darkFace, AMBER_MID)).toBeGreaterThanOrEqual(3)
  })

  it('两个主题下五官墨色对脸底都 ≥ 4.5:1', () => {
    expect(contrast(lightInk, lightFace)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(darkInk, darkFace)).toBeGreaterThanOrEqual(4.5)
  })

  it('母版的脸与双耳都挂了 .face 钩子（暗色规则才有着落点）', () => {
    for (const mood of ['cat-face.svg', 'cat-face-thinking.svg', 'cat-face-happy.svg']) {
      expect((readBrand(mood).match(/class="face"/g) ?? []).length, mood).toBe(3)
    }
    // 墨色钩子仍在（styles.css 的 .cat .ink / .inkf 靠它们取 token）
    expect(readBrand('cat-face.svg')).toContain('class="ink"')
    expect(readBrand('cat-face.svg')).toContain('class="inkf"')
  })
})

describe('头像规格一致（24 / 32 / 48 / 64px）', () => {
  const SIZES = [24, 32, 48, 64] as const

  it('四种内容共用同一块画布：尺寸、圆角、描边只有一处定义', () => {
    expect(AVATAR_SPEC.radius).toBe('50%')
    expect(AVATAR_SPEC.stroke(24)).toBe(1)
    expect(AVATAR_SPEC.stroke(32)).toBe(1)
    expect(AVATAR_SPEC.stroke(48)).toBe(2)
    expect(AVATAR_SPEC.stroke(64)).toBe(2)
  })

  it('每个尺寸下，猫 / 风格 / 骨架 / 首字符的画布样式逐字符相同', async () => {
    await loadAvatarStyle('dylan')
    for (const size of SIZES) {
      const variants = [
        renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={size} />),
        renderToStaticMarkup(<Avatar avatarKey="db:dylan:s1" name="助理" size={size} />),
        renderToStaticMarkup(<Avatar avatarKey="🐈" name="旧数据" size={size} />),
      ]
      const canvas = new RegExp(
        `width:${size}px;height:${size}px;border-radius:50%;outline:${AVATAR_SPEC.stroke(size)}px solid var\\(--edge\\)`,
      )
      for (const markup of variants) {
        expect(markup, String(size)).toMatch(canvas)
      }
      // 三种内容都真的渲染出来了（不是同一个占位换了 class）
      expect(variants[0], String(size)).toContain('<svg class="cat"')
      expect(variants[1], String(size)).toContain('<svg')
      expect(variants[2], String(size)).toContain('avatar-fallback')
    }
  })

  it('加载骨架与最终头像同规格（就绪前后不跳尺寸、不跳描边）', async () => {
    // 前一个用例已经把 dylan 加载进内存，这里换一份全新模块实例才能拿到「未就绪」态。
    vi.resetModules()
    const { Avatar: FreshAvatar } = await import('../renderer/src/components/avatars/Avatar.tsx')
    const fresh = await import('../renderer/src/components/avatars/avatars.tsx')
    const canvas = /width:32px;height:32px;border-radius:50%;outline:1px solid var\(--edge\)/
    const skeleton = renderToStaticMarkup(<FreshAvatar avatarKey="db:dylan:s2" name="助理" size={32} />)
    expect(skeleton).toContain('avatar-loading')
    expect(skeleton).toMatch(canvas)
    await fresh.loadAvatarStyle('dylan')
    const ready = renderToStaticMarkup(<FreshAvatar avatarKey="db:dylan:s2" name="助理" size={32} />)
    expect(ready).toMatch(canvas)
    expect(ready).not.toContain('avatar-loading')
    vi.resetModules()
  })

  it('橘猫头像是满幅圆画布：与 DiceBear 风格头像是同一个半径', () => {
    const markup = renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={48} />)
    expect(markup).toContain('d="M32 0 A32 32 0 1 1 32 64 A32 32 0 1 1 32 0 Z"')
  })

  it('24px 下仍然可辨识：猫的五官与首字符都留得住', () => {
    const cat = renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={24} />)
    // 母版眼半径 2.7（64 网格）→ 24px 画布上直径约 2px，低于 1.5px 就不算「看得见」
    const eyePx = (2 * 2.7 * 24) / 64
    expect(eyePx).toBeGreaterThanOrEqual(1.5)
    expect(cat).toContain('cx="26.4" cy="34.8" r="2.7"')
    const letter = renderToStaticMarkup(<Avatar avatarKey="🐈" name="旧数据" size={24} />)
    expect(letter).toContain(`font-size:${Math.round(24 * AVATAR_SPEC.letterRatio)}px`)
    expect(Math.round(24 * AVATAR_SPEC.letterRatio)).toBeGreaterThanOrEqual(11)
  })

  it('群聊九宫格单格与头像同一圆角规格（此前 2 人方格 / 3 人以上 4px 圆角）', () => {
    const html = renderToStaticMarkup(
      <GroupAvatar
        members={[
          { id: 'a', name: '甲' },
          { id: 'b', name: '乙' },
        ]}
        size={48}
      />,
    )
    expect((html.match(/border-radius:50%/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(html).not.toMatch(/border-radius:\s*[34]px/)
  })
})
