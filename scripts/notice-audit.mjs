/**
 * NOTICE.md 的事实层：把「装了什么」从人脑搬到磁盘，并给出可断言的对照。
 *
 * 为什么要它：NOTICE 是本项目唯一一份对外的许可总账，它以「可核对」为卖点，但
 * 长期是人手维护——实测已经漂了两处（写着「Lucide 图标（30 个）」而目录里有 31 个、
 * 写着「@ryharness/*（10 个工作区包）」而实际随包的有 18 个）。漂了没人知道，因为
 * 唯一的核对方法是让人去跑一次 electron-builder 打包，然后 `ls` 一遍安装目录。
 *
 * 做法照搬 deepseek-harness 的 gen-third-party-notices（生成 + pre-commit 钩子 +
 * 「提交字节必须匹配」的断言），落法收敛成两件事：
 *   1. 事实从真实来源扫出来——图标目录、已安装的包树（版本与 license 都取自
 *      实际会被打进去的 node_modules，而不是 pnpm-lock.yaml 的文本），工作区依赖
 *      图闭包算出来的「随包交付清单」；
 *   2. NOTICE.md 里每个会漂的数都用标记围起来，本模块负责生成它们的值；
 *      `verify-notice.mjs` 重算一遍并与已提交字节比对，对不上就非 0 退出。
 *
 * 标记是行内的（`<!-- notice:key -->旧值<!-- /notice -->`），因此散文与解释性
 * 文字留在原处、可照常评审，只有「这个数是多少」由机器负责。
 *
 * 本模块不含任何副作用，可以直接 import；命令行入口是 scripts/verify-notice.mjs。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 行内标记：开标记带键名，闭标记不带。块内容允许跨行。 */
const MARKER_RE = /<!--\s*notice:([\w.-]+)\s*-->[\s\S]*?<!--\s*\/notice\s*-->/g
const OPEN_RE = /<!--\s*notice:([\w.-]+)\s*-->/g

/** Lucide 图标的入库目录（由 gen-lucide-icons.mjs 从 lucide-static 拷入，随源码分发）。 */
const LUCIDE_DIR = 'apps/desktop/renderer/src/assets/lucide'
/** 供应商品牌标识的入库目录（随源码分发，因此是分发物的一部分，必须署名）。 */
const PROVIDER_LOGOS_DIR = 'apps/desktop/assets/providers'
/** electron-builder 的应用入口：随包交付的运行期依赖闭包从它的 dependencies 起算。 */
const APP_MANIFEST = 'apps/desktop/package.json'
/** 桌面应用的分发目录，打包产物的实际位置（用于判断某工作区包是否真的进包）。 */
const APP_DIR = 'apps/desktop'

/**
 * 逐项核对「这个数现在是多少」的清单。
 *
 * `from` 指明事实取自哪里，`pick` 说明如何从事实里取值——两者合起来就是「凭什么
 * 这么写」的完整依据。改依赖或资产时，先改这里的取数方式，再跑 `--write`，
 * 于是 NOTICE 里的数字永远跟着仓库事实走，而不是跟着某次手改走。
 */
const CHECKS = [
  // ---- 第三方图形资源 ----
  { key: 'icons.count', from: `${LUCIDE_DIR}/*.svg`, pick: (f) => `${f.icons.length}` },
  { key: 'icons.version', from: 'lucide-static（已安装）', pick: (f) => f.tools['lucide-static'].version },
  { key: 'icons.list', from: `${LUCIDE_DIR}/*.svg`, pick: (f) => f.icons.join('、') },
  { key: 'avatars.styles', from: 'renderer 的头像样式注册表', pick: (f) => `${f.avatarStyles.length}` },
  { key: 'avatars.stylesList', from: 'renderer 的头像样式注册表', pick: (f) => f.avatarStyles.join('、') },
  { key: 'providerLogos.count', from: `${PROVIDER_LOGOS_DIR}/*.png`, pick: (f) => `${f.providerLogos.length}` },

  // ---- 运行时依赖 ----
  { key: 'runtime.react', from: 'react（已安装）', pick: (f) => f.runtime.react.version },
  { key: 'runtime.reactDom', from: 'react-dom（已安装）', pick: (f) => f.runtime['react-dom'].version },
  { key: 'runtime.scheduler', from: 'scheduler（已安装）', pick: (f) => f.runtime.scheduler.version },
  { key: 'runtime.marked', from: 'marked（已安装）', pick: (f) => f.runtime.marked.version },
  { key: 'runtime.dicebearCore', from: '@dicebear/core（已安装）', pick: (f) => f.runtime['@dicebear/core'].version },
  {
    key: 'runtime.dicebearCollection',
    from: '@dicebear/collection（已安装）',
    pick: (f) => f.runtime['@dicebear/collection'].version,
  },
  { key: 'runtime.ws', from: 'ws（已安装）', pick: (f) => f.runtime.ws.version },
  { key: 'runtime.workspaceCount', from: '@ryharness/server 的工作区依赖闭包', pick: (f) => `${f.shipped.length}` },
  { key: 'runtime.workspaceVersion', from: '各工作区包 package.json#version', pick: (f) => f.shippedVersion },
  { key: 'runtime.workspaceLicense', from: '各工作区包 package.json#license', pick: (f) => f.shippedLicense },
  { key: 'runtime.workspaceList', from: '@ryharness/server 的工作区依赖闭包', pick: (f) => renderPackages(f.shipped) },
  {
    key: 'runtime.workspaceNonVendorCount',
    from: '闭包中非 vendor 的工作区包',
    pick: (f) => `${f.shippedNonVendor.length}`,
  },
  {
    key: 'runtime.workspaceNonVendorList',
    from: '闭包中非 vendor 的工作区包',
    pick: (f) => renderPackages(f.shippedNonVendor),
  },
  { key: 'runtime.vendorShipped', from: 'vendor/* 是否在闭包里', pick: (f) => f.vendorShipped.join(' · ') },
  {
    key: 'runtime.vendorUnshipped',
    from: 'vendor/* 是否在闭包里',
    pick: (f) => f.vendorUnshipped.join('、'),
  },

  // ---- 平台运行时 ----
  { key: 'platform.electron', from: 'electron（已安装）', pick: (f) => f.runtime.electron.version },

  // ---- 构建期工具 ----
  { key: 'build.sharp', from: 'sharp（已安装）', pick: (f) => f.tools.sharp.version },
  { key: 'build.pngToIco', from: 'png-to-ico（已安装）', pick: (f) => f.tools['png-to-ico'].version },
  { key: 'build.vite', from: 'vite（已安装）', pick: (f) => f.tools.vite.version },
  {
    key: 'build.pluginReact',
    from: '@vitejs/plugin-react（已安装）',
    pick: (f) => f.tools['@vitejs/plugin-react'].version,
  },
  { key: 'build.tsdown', from: 'tsdown（已安装）', pick: (f) => f.tools.tsdown.version },
  { key: 'build.typescript', from: 'typescript（已安装）', pick: (f) => f.tools.typescript.version },
  {
    key: 'build.electronBuilder',
    from: 'electron-builder（已安装）',
    pick: (f) => f.tools['electron-builder'].version,
  },
  { key: 'build.vitest', from: 'vitest（已安装）', pick: (f) => f.tools.vitest.version },

  // ---- 许可（法务字段，与版本同等严格）----
  { key: 'license.marked', from: 'marked（已安装）', pick: (f) => `**${f.runtime.marked.license}**` },
  { key: 'license.sharp', from: 'sharp（已安装）', pick: (f) => `**${f.tools.sharp.license}**` },
  { key: 'license.typescript', from: 'typescript（已安装）', pick: (f) => `**${f.tools.typescript.license}**` },
  { key: 'license.pngToIco', from: 'png-to-ico（已安装）', pick: (f) => `**${f.tools['png-to-ico'].license}**` },
  {
    key: 'license.lucideStatic',
    from: 'lucide-static（已安装）',
    pick: (f) => `**${f.tools['lucide-static'].license}**`,
  },
  {
    key: 'license.electronBuilder',
    from: 'electron-builder（已安装）',
    pick: (f) => `**${f.tools['electron-builder'].license}**`,
  },
]

function fail(message) {
  throw new Error(`[notice] ${message}`)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 找出一个已安装包的 package.json。
 *
 * 优先在「引用它的工作区目录」下找，其次根目录——pnpm 只在被引用的包旁边建链接，
 * 于是同一份依赖在根目录可能根本不存在。版本与 license 都取自这里而不是锁文件：
 * 打进去的是这棵树里的字节，锁文件只是一段描述。
 *
 * 传递依赖（scheduler 是 react-dom 带进来的）在 pnpm 的严格布局下压根不在链接树里，
 * 只存在于 `.pnpm/<pkg>@<ver>/node_modules/` 这个虚拟 store 里。它们与宿主包并排摆放，
 * 所以先解析任意一个已链接包的真实路径，再从它所在的 node_modules 目录起逐级上溯即可。
 */
function installedPackage(name, searchFrom = ROOT) {
  const bases = [path.join(searchFrom, 'node_modules'), path.join(ROOT, 'node_modules')]
  for (const base of bases) {
    const direct = path.join(base, name, 'package.json')
    if (existsSync(direct)) return readJson(direct)
  }
  for (const base of bases) {
    for (const entry of readdirSafe(base)) {
      for (let dir = path.dirname(realpathSync(path.join(base, entry))); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, name, 'package.json')
        if (existsSync(candidate)) return readJson(candidate)
        const parent = path.dirname(dir)
        if (parent === dir) break
      }
    }
  }
  return fail(`找不到已安装的 ${name}（先 pnpm install）。查找过 ${bases.join('、')} 及 pnpm 虚拟 store`)
}

function readdirSafe(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
}

/**
 * 工作区包的清单：name → { name, dir, manifest }。
 *
 * 目录深度跟着 pnpm-workspace.yaml 的四条 glob 走：apps 一层、vendor 一层、
 * packages 一层、packages 两层。最后一条是必要的——`packages/llm/llm`、
 * `packages/util/brand` 这类分组目录自身没有 package.json，只扫一层会把它们整组
 * 漏掉（实测会少算 5 个包，于是「随包交付清单」直接少一半）。
 */
function workspacePackages() {
  const out = new Map()
  for (const dir of workspacePackageDirs()) {
    const manifestPath = path.join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    if (typeof manifest.name !== 'string') continue
    out.set(manifest.name, { name: manifest.name, dir: path.relative(ROOT, dir).split(path.sep).join('/'), manifest })
  }
  return out
}

function workspacePackageDirs() {
  const dirs = []
  for (const group of ['apps', 'vendor']) {
    for (const child of listDirs(path.join(ROOT, group))) dirs.push(child)
  }
  for (const child of listDirs(path.join(ROOT, 'packages'))) {
    dirs.push(child)
    for (const grand of listDirs(child)) dirs.push(grand)
  }
  return dirs
}

function listDirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
}

/**
 * 随安装包交付的工作区包：桌面应用唯一的工作区运行期依赖是 @ryharness/server，
 * 它（经 dependencies 传递）拉进来的那些才是真正随包走的代码。
 *
 * 只看直接依赖会严重少算（server 自己只声明了 10 个，闭包是 18 个）；只看
 * `packages/*` 目录又会多算（@ryharness/desktop 是应用本身，@ryharness/schemastery
 * 目前无人依赖、根本没进包）。这条闭包同时是 NOTICE 里「我方重命名的 vendor」
 * 那一行的事实依据。
 */
function shippedWorkspacePackages(root) {
  const all = workspacePackages()
  const appManifest = readJson(path.join(ROOT, APP_MANIFEST))
  const seeds = Object.keys(appManifest.dependencies ?? {}).filter((name) => all.has(name))
  const seen = new Set()
  const queue = [...seeds]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name) || !all.has(name)) continue
    seen.add(name)
    const entry = all.get(name)
    for (const dep of Object.keys(entry.manifest.dependencies ?? {})) {
      if (!seen.has(dep)) queue.push(dep)
    }
  }
  return [...seen].sort().map((name) => ({ name, ...all.get(name) }))
}

/** 工作区包清单渲染成一行 `名字（路径）` 串，供 NOTICE 内联。 */
function renderPackages(packages) {
  return packages
    .map((entry) => {
      return `${entry.name}（\`${entry.dir}\`）`
    })
    .join('、')
}

/**
 * 扫出全部事实。
 *
 * 每项都来自会进分发物的那棵树或那个目录，没有一项是「记得是这样」——这也是它能
 * 发现漂移的前提。扫描失败一律抛错而不是返回缺省值：门禁悄悄放行比变红更糟。
 */
export function scanRepo(root = ROOT) {
  if (root !== ROOT) fail('scanRepo 只接受仓库根目录（依赖固定的相对路径）')
  const lucideDir = path.join(ROOT, LUCIDE_DIR)
  const icons = existsSync(lucideDir)
    ? readdirSync(lucideDir)
        .filter((name) => name.endsWith('.svg'))
        .map((name) => name.slice(0, -'.svg'.length))
        .sort()
    : fail(`找不到 Lucide 图标目录：${LUCIDE_DIR}`)

  const providerLogosDir = path.join(ROOT, PROVIDER_LOGOS_DIR)
  const providerLogos = existsSync(providerLogosDir)
    ? readdirSync(providerLogosDir)
        .filter((name) => name.endsWith('.png'))
        .map((name) => name.slice(0, -'.png'.length))
        .sort()
    : fail(`找不到供应商品牌标识目录：${PROVIDER_LOGOS_DIR}`)

  const shipped = shippedWorkspacePackages(ROOT)
  const shippedLicenses = new Set(shipped.map((entry) => entry.manifest.license ?? '未声明'))
  if (shippedLicenses.size !== 1) {
    fail(`随包交付的工作区包 license 不一致：${[...shippedLicenses].join('、')}`)
  }
  const shippedVersions = new Set(shipped.map((entry) => entry.manifest.version))
  if (shippedVersions.size !== 1) {
    fail(`随包交付的工作区包 version 不一致：${[...shippedVersions].join('、')}`)
  }
  const shippedVersion = shippedVersions.values().next().value

  const vendor = workspacePackages()
  const vendored = [...vendor.values()].filter((entry) => entry.dir.startsWith('vendor/'))
  const shippedNames = new Set(shipped.map((entry) => entry.name))
  const vendorShipped = vendored
    .filter((entry) => shippedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort()
  const vendorUnshipped = vendored
    .filter((entry) => !shippedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort()

  return {
    icons,
    providerLogos,
    shipped,
    shippedNonVendor: shipped.filter((entry) => {
      return !entry.dir.startsWith('vendor/')
    }),
    shippedLicense: shippedLicenses.values().next().value,
    shippedVersion,
    vendorShipped,
    vendorUnshipped,
    avatarStyles: scanAvatarStyles(),
    // 运行期：会随渲染层分片或主进程 node_modules 进安装包的第三方包。
    runtime: {
      react: installedPackage('react', path.join(ROOT, APP_DIR)),
      'react-dom': installedPackage('react-dom', path.join(ROOT, APP_DIR)),
      scheduler: installedPackage('scheduler', path.join(ROOT, APP_DIR)),
      marked: installedPackage('marked', path.join(ROOT, APP_DIR)),
      '@dicebear/core': installedPackage('@dicebear/core', path.join(ROOT, APP_DIR)),
      '@dicebear/collection': installedPackage('@dicebear/collection', path.join(ROOT, APP_DIR)),
      ws: installedPackage('ws'),
      electron: installedPackage('electron', path.join(ROOT, APP_DIR)),
    },
    // 构建期：只跑在开发机上，产物进分发物但它们自己不进。
    tools: {
      'lucide-static': installedPackage('lucide-static', path.join(ROOT, APP_DIR)),
      'png-to-ico': installedPackage('png-to-ico', path.join(ROOT, APP_DIR)),
      sharp: installedPackage('sharp', path.join(ROOT, APP_DIR)),
      vite: installedPackage('vite', path.join(ROOT, APP_DIR)),
      '@vitejs/plugin-react': installedPackage('@vitejs/plugin-react', path.join(ROOT, APP_DIR)),
      tsdown: installedPackage('tsdown'),
      typescript: installedPackage('typescript'),
      'electron-builder': installedPackage('electron-builder', path.join(ROOT, APP_DIR)),
      vitest: installedPackage('vitest'),
    },
  }
}

/**
 * 当前真正接进界面的 DiceBear 风格键名。
 *
 * 取自渲染层的头像样式注册表而不是 NOTICE 的散文——「已停用」那一节声称
 * lorelei/thumbs 等不再分发，而这句话唯一能被证伪的方式就是注册表里有没有它。
 */
function scanAvatarStyles() {
  const file = path.join(ROOT, 'apps/desktop/renderer/src/components/avatars/styles-avatar.ts')
  if (!existsSync(file)) fail(`找不到头像样式注册表：${file}`)
  const source = readFileSync(file, 'utf8')
  const block = /LAZY_RENDERERS\s*:[^=]*=\s*\{([\s\S]*?)\n\}/u.exec(source)
  if (block === null) fail(`头像样式注册表里没找到 LAZY_RENDERERS 对象：${file}`)
  const keys = [...block[1].matchAll(/^\s{2}([a-z][a-zA-Z]*)\s*:/gmu)].map((match) => match[1])
  if (keys.length === 0) fail(`头像样式注册表里没解析出任何风格键：${file}`)
  return keys.sort()
}

/** 按 CHECKS 算出每个标记应当取到的值。 */
export function renderMarkers(facts = scanRepo()) {
  const out = new Map()
  for (const check of CHECKS) {
    const value = String(check.pick(facts))
    out.set(check.key, value)
  }
  return out
}

/** 把生成值填回标记围住的区域，其余字节原样保留。 */
export function applyMarkers(source, rendered) {
  return source.replace(MARKER_RE, (_match, key) => {
    const value = rendered.get(key)
    if (value === undefined) return `<!-- notice:${key} --><!-- /notice -->`
    return `<!-- notice:${key} -->${value}<!-- /notice -->`
  })
}

/**
 * 核对 NOTICE.md：每个已登记的键都必须出现，且围住的当前值与扫描结果逐字节相同。
 *
 * 「出现」和「相等」是两条独立断言：漏了键说明有人删了标记（于是这个数又变成手维护
 * 的了），不相等说明事实漂了。只报不相等会让「删标记」变成一条绕过门禁的后门。
 */
export function auditNotice(root = ROOT) {
  const facts = scanRepo(root)
  const rendered = renderMarkers(facts)
  const file = path.join(root, 'NOTICE.md')
  if (!existsSync(file)) fail(`找不到 ${file}`)
  const source = readFileSync(file, 'utf8')

  const checks = []
  for (const check of CHECKS) {
    const expected = rendered.get(check.key)
    const pattern = new RegExp(
      `<!--\\s*notice:${check.key.replaceAll('.', '\\.')}\\s*-->([\\s\\S]*?)<!--\\s*\\/notice\\s*-->`,
    )
    const match = pattern.exec(source)
    if (match === null) {
      checks.push({ key: check.key, from: check.from, expected, actual: null, ok: false, reason: '标记缺失' })
      continue
    }
    const actual = match[1]
    checks.push({
      key: check.key,
      from: check.from,
      expected,
      actual,
      ok: actual === expected,
    })
  }

  // 已登记却漏在 CHECKS 之外的标记：事实无人负责，它会悄悄变成手维护。
  const known = new Set(CHECKS.map((check) => check.key))
  for (const match of source.matchAll(OPEN_RE)) {
    if (!known.has(match[1])) {
      checks.push({ key: match[1], from: '（未登记）', expected: null, actual: null, ok: false, reason: '标记未登记' })
    }
  }

  return { checks, ok: checks.every((check) => check.ok), rendered, source }
}
