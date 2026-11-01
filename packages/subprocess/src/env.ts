/**
 * 环境清洗：子进程只拿到该拿的那几项。
 *
 * 为什么要洗：宿主进程的环境里通常躺着模型服务的 key、数据库口令、内部 token。
 * 子进程一旦是用户命令（`bash -c "env"`），这些变量就等于**公开**了。所以本包
 * 起的每一个子进程都从一份**白名单**环境起步，而不是继承宿主环境。
 *
 * 两条规则，都写在这里：
 * 1. 白名单之外的**一律不传**——不是「按需判断」，是默认不传。
 * 2. 白名单之内但**名字像密钥**的也不传（`*_API_KEY`、`*_TOKEN` 之类）。
 *    白名单是「系统运行要用的」，凭据不是；真要传凭据，走 `extra` 显式点名。
 *
 * 调用方追加的 `extra` 原样传下去：那是显式意图，不是猜测。
 * @module @ryharness/subprocess/env
 */

/**
 * 环境白名单：系统运行要用的那几项。
 *
 * **刻意不含任何凭据**：模型服务的 key 若在环境里，被命令 `echo $KEY` 就读走了。
 * 这与 `packages/sandbox` 的围栏口径一致（那边也在清环境），但本包不依赖那个包，
 * 两边各自有一份，改动时记得对一下。
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]

/**
 * 「这名字像密钥」的默认判据。
 *
 * 命中就**不传**，并且把名字记进 `blocked`——被拦下来这件事要能被看见，
 * 不然调用方会以为「传了呀」，然后去查一个根本不存在的环境变量。
 */
export const DEFAULT_SECRET_NAME_PATTERN: RegExp = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION)/i

/** 环境清洗的参数。 */
export interface ScrubEnvironmentOptions {
  /** 宿主环境；缺省用 `process.env`。 */
  readonly base?: NodeJS.ProcessEnv
  /** 白名单；缺省用 {@link DEFAULT_ENV_ALLOWLIST}。 */
  readonly allowlist?: readonly string[]
  /** 「像密钥」的名字（正则）；命中就不传。 */
  readonly deny?: readonly RegExp[]
  /** 调用方明确要追加的变量；这些原样传下去。 */
  readonly extra?: Readonly<Record<string, string>>
  /** 按哪个平台查环境变量（Windows 上名字大小写不敏感）。 */
  readonly platform?: NodeJS.Platform
}

/** 清洗的结果。 */
export interface ScrubbedEnvironment {
  /** 可以交给子进程的环境。 */
  readonly env: NodeJS.ProcessEnv
  /** 实际继承下来的变量名（按白名单顺序）。 */
  readonly inherited: readonly string[]
  /** 因为命中「像密钥」被拦下来的变量名。 */
  readonly blocked: readonly string[]
}

/**
 * 在 Windows 上按名字查环境变量（大小写不敏感）。
 *
 * Windows 的环境变量名本来就不区分大小写，`Path` 与 `PATH` 是同一个。宿主给过来的
 * 环境对象不一定用大写，所以查的时候得两边都试。
 */
function lookupEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  if (platform !== 'win32') return undefined
  const lowered = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowered) return value
  }
  return undefined
}

/**
 * 名字是不是命中了「像密钥」的判据。
 *
 * 正则带 `g` 标志时 `test` 会带着 lastIndex 往前走，同一个正则连续测两个名字会漏。
 * 所以每次测之前先把 lastIndex 归零——判据必须是确定的。
 */
function matchesDeny(name: string, deny: readonly RegExp[]): boolean {
  for (const pattern of deny) {
    pattern.lastIndex = 0
    if (pattern.test(name)) return true
  }
  return false
}

/**
 * 按白名单裁剪环境。
 *
 * 顺序有讲究：白名单里的变量按白名单的顺序取，所以同一份环境在不同机器上出来的
 * 子进程环境是**同一个顺序**——排查问题时 diff 出来的差异才是真差异。
 * @param options - 白名单、宿主环境与追加项。
 * @returns 清洗后的环境，以及继承/被拦下的变量名清单。
 */
export function scrubEnvironment(options: ScrubEnvironmentOptions = {}): ScrubbedEnvironment {
  const platform = options.platform ?? process.platform
  const base = options.base ?? process.env
  const allowlist = options.allowlist ?? DEFAULT_ENV_ALLOWLIST
  const deny = options.deny ?? [DEFAULT_SECRET_NAME_PATTERN]
  const env: NodeJS.ProcessEnv = {}
  const inherited: string[] = []
  const blocked: string[] = []
  const taken = new Set<string>()

  for (const name of allowlist) {
    const value = lookupEnv(base, name, platform)
    if (value === undefined) continue
    const key = platform === 'win32' ? name.toLowerCase() : name
    if (taken.has(key)) continue
    if (matchesDeny(name, deny)) {
      blocked.push(name)
      continue
    }
    taken.add(key)
    env[name] = value
    inherited.push(name)
  }

  for (const [name, value] of Object.entries(options.extra ?? {})) {
    env[name] = value
  }

  return { env, inherited, blocked }
}
