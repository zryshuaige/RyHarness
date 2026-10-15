/**
 * 渲染层共用的时间格式化：会话列表的时间戳与聊天气泡间的分隔线必须是同一套口径，
 * 此前两边各写一份（其中一份还借道 ChatView 导出，形成了组件之间的反向依赖）。
 *
 * Intl 构造是这里的热路径：`toLocaleTimeString` / `toLocaleDateString` 每调一次都要
 * 重走一遍 ICU 初始化（会话列表一屏几十行、流式重绘又乘一遍），所以按
 * 「locale + options」把 DateTimeFormat 实例缓存到模块级——一次启动最多构造两个。
 */

/** 缓存条目：key 必须能唯一代表 locale + options。 */
interface FormatterSpec {
  key: string
  locale: string
  options: Intl.DateTimeFormatOptions
}

/** 今天显示的时刻（会话列表右上的 <time>、气泡间的分隔线）。 */
const TIME_FORMAT: FormatterSpec = {
  key: 'zh-CN|hour,minute',
  locale: 'zh-CN',
  options: { hour: '2-digit', minute: '2-digit' },
}

/** 非今天的日期。 */
const DATE_FORMAT: FormatterSpec = {
  key: 'zh-CN|month,day',
  locale: 'zh-CN',
  options: { month: 'numeric', day: 'numeric' },
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

/** 按 key 取（缺省时构造并缓存）。 */
function formatterOf(spec: FormatterSpec): Intl.DateTimeFormat {
  const cached = formatterCache.get(spec.key)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat(spec.locale, spec.options)
  formatterCache.set(spec.key, created)
  return created
}

/** 已缓存的 DateTimeFormat 个数（诊断与测试用：重复格式化不应让它增长）。 */
export function dateTimeFormatterCount(): number {
  return formatterCache.size
}

/**
 * 「本地日期串」缓存的有效期（毫秒）。
 *
 * 判今天要给两个时间各取一次日期串，而 toDateString 每次都新建 Date。按秒缓存：
 * 同一秒内的成百上千次格式化只付一次代价，跨零点最多错一秒（表现为边界那条时间戳
 * 走了日期格式，不影响正确性）。
 */
const DAY_KEY_TTL_MS = 1000

let dayKeyCache: { second: number; key: string } | undefined

function localDayKey(ts: number): string {
  const second = Math.floor(ts / DAY_KEY_TTL_MS)
  if (dayKeyCache?.second === second) return dayKeyCache.key
  const key = new Date(ts).toDateString()
  dayKeyCache = { second, key }
  return key
}

export function formatTime(ts: number): string {
  const date = new Date(ts)
  return localDayKey(ts) === localDayKey(Date.now())
    ? formatterOf(TIME_FORMAT).format(date)
    : formatterOf(DATE_FORMAT).format(date)
}
