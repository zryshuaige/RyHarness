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
 * 品牌一致性的验收网：
 *
 *   1. 母版唯一性 —— 全应用只有 apps/desktop/assets/brand/mark.png 这一份橘猫。
 *      应用图标、托盘、favicon、应用内 <Cat>、启动屏都要能指回它；顺手钉住「零外部素材」。
 *   2. 同源 —— 渲染层与启动屏吃的那张图，是 gen:icon 从母版导出的、登记在 tiers.json
 *      里的产物，且 renderer/public 下的副本与 assets/ 逐字节一致。
 *   3. 头像规格一致 —— 猫 / DiceBear 风格 / 加载骨架 / 首字符兜底走同一块画布，
 *      24 / 32 / 48 / 64px 下规格一致。
 *
 * 「暗色主题五官可见」那组对比度断言随矢量母版一起退场：位图的颜色是烤进像素里的，
 * 没有可翻的图元；琥珀底板自带一圈实色描边，深浅任务栏上都立得住。
 */

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(DESKTOP, 'renderer/src')
const HTML_FILE = join(DESKTOP, 'renderer/index.html')
const BRAND = join(DESKTOP, 'assets/brand')
const ASSETS = join(DESKTOP, 'assets')
const PUBLIC = join(DESKTOP, 'renderer/public')

const html = readFileSync(HTML_FILE, 'utf8')

const tiers = JSON.parse(readFileSync(join(BRAND, 'tiers.json'), 'utf8')) as {
  master: string
  brand: string
  favicon: string
  faviconLarge: string
}

describe('母版唯一性：只有 assets/brand/mark.png 这一只猫', () => {
  it('品牌目录里只有母版与分级契约', () => {
    expect(readdirSync(BRAND).sort()).toEqual([tiers.master, 'tiers.json'])
    // 手写过的第二只猫（AppIcon.tsx / lucide 里的 cat-face）不许复活
    expect(existsSync(resolve(SRC, 'components/AppIcon.tsx'))).toBe(false)
    expect(existsSync(resolve(SRC, 'assets/lucide/cat-face.svg'))).toBe(false)
    expect(existsSync(resolve(SRC, 'assets/lucide/cat.svg'))).toBe(false)
  })

  it('没有「内嵌位图的假矢量」：品牌与渲染层里都不产出 .svg 包装', () => {
    // 母版是位图，产不出真矢量。此前那三份 svg（icon / favicon / icon-mono）随之退场：
    // 留一个自称矢量、实际内嵌 PNG 的文件，只会给「这是一张真矢量」的错觉。
    const svgs = readdirSync(BRAND).filter((name) => {
      return name.endsWith('.svg')
    })
    expect(svgs).toEqual([])
    for (const href of [...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => {
      return m[1] as string
    })) {
      expect(href, href).not.toContain('.svg')
    }
  })

  it('渲染层里没有任何第二处猫的几何', () => {
    // 矢量母版时代，这里钉的是「源码里不出现母版的耳朵路径原文」。现在母版是位图，
    // 同一条不变量换成更强的形式：渲染层里根本不写图形——品牌标记只有一个 <img src>。
    // assets/lucide/ 是第三方图标库（ISC，由 icons.test.tsx 钉住它的登记表），
    // 里面的 <path> 属于 Lucide 而不属于这只猫，排除掉。
    const offenders: string[] = []
    for (const file of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
      if (/\.(png|jpe?g|webp|gif|woff2?|css)$/.test(file)) continue
      if (file.includes(`assets${'\\'}lucide`) || file.includes('assets/lucide')) continue
      const full = resolve(SRC, file)
      let text = ''
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (/<ellipse|<path[^>]*\bd="/.test(text) && !file.endsWith('Icon.tsx')) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('零外部素材：index.html 不引站外资源，登记的每一份产物都在', () => {
    for (const ref of [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => {
      return m[1] as string
    })) {
      expect(ref, ref).not.toMatch(/^https?:/)
    }
    for (const name of [tiers.brand, tiers.favicon, tiers.faviconLarge]) {
      expect(existsSync(join(ASSETS, name)), `assets/${name}`).toBe(true)
      expect(readFileSync(join(PUBLIC, name)).equals(readFileSync(join(ASSETS, name))), name).toBe(true)
    }
  })
})

describe('启动屏与应用内徽标：同一张图', () => {
  it('splash 与 <Cat> 引的是同一个文件，且它来自母版', () => {
    const splash = /<img[^>]*class="splash-mark"[^>]*>/.exec(html)?.[0] ?? ''
    expect(splash).not.toBe('')
    expect(splash).toContain(`src="/app/${tiers.brand}"`)
    // 此前这里内联过一整段手绘猫 SVG（1024 网格另起炉灶），等于全应用第二只猫
    expect(html).not.toContain('<svg class="splash-mark"')
    expect(html).not.toContain('viewBox="0 0 1024 1024"')
  })

  it('splash 的底色跟主题走，徽标不需要跟着改', () => {
    const splashCss = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''
    expect(splashCss).toMatch(/--splash-bg:\s*#/)
    expect(splashCss, '系统暗色兜底那条媒体查询也得给同一组值').toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--splash-bg:/,
    )
    // 位图徽标没有颜色钩子：这里留着任何 fill/stroke 覆写都是上一只矢量猫的残留
    expect(splashCss).not.toMatch(/#splash\s+\.(face|inkf|ink|ear|sheen)\b/)
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
      expect(variants[0], String(size)).toContain('<img class="cat cat-circle"')
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
    expect(markup).toContain('class="cat cat-circle"')
    // 徽标自己是正方形位图，圆是画出来的；外壳的画布与风格头像逐字符相同
    expect(markup).toMatch(/border-radius:50%;outline:2px solid var\(--edge\)/)
  })

  it('猫与首字符在 24px 下仍留得住各自的可辨识特征', () => {
    const cat = renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={24} />)
    // 徽标是 256 档母版图，缩到 24px 由浏览器取样；这里钉的是「画的是同一张图、尺寸对得上」
    expect(cat).toContain('src="/app/cat.png"')
    expect(cat).toContain('width="24" height="24"')
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
