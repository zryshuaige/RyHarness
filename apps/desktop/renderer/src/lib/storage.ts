/**
 * 界面偏好的存取：改名那天的旧键回落。
 *
 * 产品从 RyAgent 改成 RyHarness 时，localStorage 的键前缀也跟着换了。键名一变，
 * 用户的主题、面板收起态、**没发出去的草稿**就都"消失"了——它们其实还在，只是不
 * 在新键名下。这里读的时候回落一次旧键：旧键有值就搬进新键（顺手删掉旧键），
 * 两次都没有才算没有。
 *
 * 键名都是 `ryharness-` 前缀，所以旧键名能由新键名推出来，不必各处各写一份映射
 * ——散落的映射表迟早漏掉一个键，而漏掉的那个就是用户丢的那一项偏好。
 *
 * @module @ryharness/renderer/lib/storage
 */

/** 当前键前缀。 */
const PREFIX = 'ryharness-'
/** 改名之前的键前缀。 */
const LEGACY_PREFIX = 'ryagent-'

/** 某个新键对应的旧键；不是新前缀的键没有旧键。 */
function legacyKeyOf(key: string): string | undefined {
  if (!key.startsWith(PREFIX)) return undefined
  return `${LEGACY_PREFIX}${key.slice(PREFIX.length)}`
}

/** localStorage 是否可用（隐私模式与部分测试环境里没有）。 */
function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    return localStorage
  } catch {
    // 某些环境访问 localStorage 本身就抛（安全策略）。
    return undefined
  }
}

/**
 * 读一项界面偏好；新键没有就回落旧键（并顺手搬进新键）。
 *
 * 读不出来与没有都是 null：调用方分不出"没设过"和"读不出来"，这两者都按缺省走。
 */
export function readSetting(key: string): string | null {
  const store = storage()
  if (store === undefined) return null
  try {
    const current = store.getItem(key)
    if (current !== null) return current
    const legacy = legacyKeyOf(key)
    if (legacy === undefined) return null
    const old = store.getItem(legacy)
    if (old === null) return null
    // 搬进新键：旧键删掉，免得下次又走回落，也免得两份值各说各话。
    store.setItem(key, old)
    store.removeItem(legacy)
    return old
  } catch {
    return null
  }
}

/** 写一项界面偏好；旧键顺手清掉。 */
export function writeSetting(key: string, value: string): void {
  const store = storage()
  if (store === undefined) return
  try {
    store.setItem(key, value)
    const legacy = legacyKeyOf(key)
    if (legacy !== undefined) store.removeItem(legacy)
  } catch {
    // 持久化失败不该连带界面出事（隐私模式、配额满）。
  }
}

/** 删掉一项界面偏好（新键与旧键都删）。 */
export function removeSetting(key: string): void {
  const store = storage()
  if (store === undefined) return
  try {
    store.removeItem(key)
    const legacy = legacyKeyOf(key)
    if (legacy !== undefined) store.removeItem(legacy)
  } catch {
    // 忽略：删不掉也只是下次启动时那项偏好还在。
  }
}
