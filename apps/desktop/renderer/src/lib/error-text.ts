/**
 * REST 失败的人话层（界面各处唯一的出口）。
 *
 * 对话轮次那条线由 {@link explainTurnError} 负责（内核 HarnessError 的 code 是
 * 给程序路由的），这一份管的是另一条线：**界面自己发起的 REST 调用**。那些失败在
 * api.ts 里被包成 ApiRequestError，message 一度直接取服务端 `{error}` 里的英文
 * 原话，于是同一个应用读起来像两个——聊天区的红条说「这条消息没发出去」，三步
 * 之后一个 toast 说 `conversation not found` 或 `HTTP 500`。
 *
 * 两件事都在这里做完：
 * - {@link humanError} 把失败翻成一句中文。认得出的失败说清「出了什么事、接下来
 *   怎么办」；认不出的走调用点给的中文兜底（那句必须描述用户当时想做什么），
 *   **绝不把英文原话原样递回去**——递回去就等于这个坑还在。
 * - {@link errorDetail} 交出原文，供 AsyncState / HistoryFailure 那种折叠的「详情」
 *   使用。原文对排障有用，但不该占据用户第一眼。
 *
 * 放在 lib/ 而不是并进 turn-errors.ts：那边认的是内核的轮次错误码（有 code 可
 * 路由、带可点的下一步），这边认的是服务端路由回的那几十条字面量，两者会共用一条
 * 上游解析（见 {@link UPSTREAM_CODES}）但不该混成一张表。纯函数、无副作用、便于
 * 逐条钉死。
 */
import { explainKnownTurnError } from './turn-errors.ts'

/**
 * api.ts 的 ApiRequestError 满足这个形状。
 *
 * 这里按**结构**认而不 import ApiRequestError：api.ts 要调 humanError 来生成
 * message，反向 import 会绕成环。代价是多写这一个接口，换来 lib 与传输层零耦合。
 */
interface ServerFailure {
  readonly status: number
  readonly code?: string
  /** 服务端 `{error}` 的原文（没有 body 时是 `HTTP <status>`）。 */
  readonly raw: string
}

/**
 * 只有这些 code 一定是"上游模型服务出的问题"，才敢按 code 走内核那套解释。
 *
 * describeFailure 只对 HarnessError 保留内核自己的码（见 apps/server/src/app.ts），
 * 所以 MISSING_CREDENTIAL / RATE_LIMIT 这类在 REST 回包上同样成立。但通用码不行：
 * 路由器的兜底 404 也叫 NOT_FOUND、鉴权失败也叫 UNAUTHORIZED，按码解释会把
 * 「这个会话已经不在了」说成「这个模型不存在」，把该重启应用的事说成该换 Key。
 */
const UPSTREAM_CODES: ReadonlySet<string> = new Set([
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'NO_ADAPTER',
  'RATE_LIMIT',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_ARGS',
  'TIMEOUT',
  'SERVER',
  'TRANSPORT',
  'EMPTY_RESPONSE',
])

/** 服务端已经用中文回话的标记：待办/提问路由与供应商去重都走这条路，别再翻一遍。 */
const HAS_CJK = /[\u4e00-\u9fff]/

/**
 * 服务端字面量 → 人话（逐条对着 apps/server/src/routes/*.ts 与 router.ts/app.ts
 * 的 `error:` 原句写的，不是照着印象补的）。
 *
 * 顺序即优先级：先命中先答，所以具体条目排在共用条目前面。认不出的条目不猜——
 * 那一条会落到调用点给的兜底句上，而兜底句至少说清了用户当时想做什么。
 */
const BY_TEXT: readonly { match: RegExp; text: string }[] = [
  // 鉴权与来源：窗口先于后端起来时 token 对不上，重启应用会重新发放一份。
  {
    match: /missing or invalid api token|origin not allowed|\b401\b/i,
    text: '本机服务的访问凭据对不上，重启应用会重新发放。',
  },
  // 路由器兜底的 404：界面要的那个接口根本没挂上，通常是服务端比界面旧。
  { match: /^not found: /, text: '本机服务没有这个接口，界面可能比服务端新。' },
  // 请求没写完整：几乎都是界面与服务端的版本差，或表单在这一跳之间被改动过。
  {
    match: /malformed request url|malformed url encoding|invalid json body/i,
    text: '这次请求没写完整，重试一次；一直这样就重启应用。',
  },
  // 「某某已经不在了」这一族：删除、清理或换绑之后，旧 id 还留在别处的引用里。
  { match: /^agent not found|^unknown agent\b/i, text: '这位助理已经不在了，可能刚被删掉。' },
  { match: /^conversation not found/i, text: '这个会话已经不在了，可能刚被删掉。' },
  { match: /^message not found/i, text: '这条消息已经不在了。' },
  { match: /^entry not found/i, text: '这条经验记录已经不在了。' },
  { match: /^memory not found/i, text: '这条记忆已经不在了。' },
  { match: /^provider not found|^unknown provider\b/i, text: '这家模型服务已经不在供应商列表里。' },
  { match: /^file not found/i, text: '工作区里没有这个文件了。' },
  { match: /^unknown plugin\b/i, text: '这个插件已经不在服务端的插件清单里。' },
  { match: /is built in and cannot be disabled/i, text: '内置插件不能关掉，它是底座。' },
  // 功能被关掉：这是配置，不是故障，说清去哪打开比说「失败」有用。
  { match: /memory system disabled/i, text: '记忆功能被关掉了，先在设置里打开它。' },
  { match: /evolution system disabled/i, text: '自我进化被关掉了，先在设置里打开它。' },
  { match: /embeddings are not configured/i, text: '还没配置向量模型，重建索引暂时做不了。' },
  { match: /^memory is not archived/i, text: '这条记忆不在归档区，可能已经被彻底移走了。' },
  // 删除前置条件：这一条要用户先改绑，而不是重试。
  { match: /is used by \d+ agent\(s\)/i, text: '还有助理在用这家模型服务，先去通讯录改绑再删。' },
  { match: /^builtin agent .* cannot be deleted/i, text: '内置助理不能删掉。' },
  { match: /^builtin provider .* cannot be deleted/i, text: '内置模型服务不能删掉。' },
  // 文件名与体积：都是"换个文件"而不是"重试"。
  { match: /^file name must be a leaf name/i, text: '这个名字带了目录，只写文件名就行。' },
  { match: /^file name is too long/i, text: '文件名太长了，换一个短一点的。' },
  { match: /^too many files with the same name/i, text: '工作区里已经有同名文件了，换个名字。' },
  { match: /^file escapes workspace root/i, text: '这个路径在工作区外面，只能操作工作区里的文件。' },
  { match: /^file is larger than|^file is too large to preview/i, text: '文件太大了，先压缩或截一段再发。' },
  // 供应商：预设不认识、Key 没填全。
  { match: /^unknown preset\b/i, text: '没有这个模型服务模板，重新挑一个。' },
  { match: /apikey are required/i, text: '模型服务和 Key 都要填上再保存。' },
  // 服务端自己没做完的那几种：说清是哪一步，别让用户以为重试就能成。
  { match: /^write failed/i, text: '内容没能写到本机，重试一次。' },
  { match: /^restore failed/i, text: '没能恢复这条记忆，再试一次。' },
  { match: /^consolidation failed/i, text: '这一轮整理没能跑完，稍后再试。' },
]

/** ApiRequestError 之外的抛出物：能拿到原文就拿，拿不到（抛的是个字符串以外的东西）就算没。 */
function rawTextOf(cause: unknown): string | undefined {
  const server = asServerFailure(cause)
  if (server !== undefined) return server.raw
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  return undefined
}

function asServerFailure(cause: unknown): ServerFailure | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined
  const candidate = cause as Partial<ServerFailure>
  if (typeof candidate.raw !== 'string' || typeof candidate.status !== 'number') return undefined
  return candidate as ServerFailure
}

/** 原文压成一行再匹配：服务端偶尔在字面量里带换行，正则锚点会因此全部落空。 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 把一次 REST 失败翻成一句给用户看的中文。
 *
 * @param cause 抛出物：ApiRequestError、Error、字符串都认。
 * @param fallback **调用点给的**中文兜底句，必须描述用户当时想做什么（例：「没能停住
 *   下一次生成，再点一次停止」）。认不出的失败只会说这句——绝不说英文原话。
 */
export function humanError(cause: unknown, fallback: string): string {
  const raw = rawTextOf(cause)
  if (raw === undefined) return fallback
  const text = flatten(raw)
  if (text.length === 0) return fallback
  // 字面量表先走：`file not found: 方案.docx` 是中英混排的——文件名是用户自己的，
  // 中文在这句话里，可整句的框架仍然是英文的，只看"有没有汉字"会把原话漏回界面。
  for (const rule of BY_TEXT) {
    if (rule.match.test(text)) return rule.text
  }
  // 表里认不出、服务端自己回了中文：原样递出，再翻一遍只会把它搅坏。
  // 表里的判据都是英文关键词（`not found` / `is required`），中文句子不会误命中。
  if (HAS_CJK.test(text)) return text
  // 上游模型服务的失败（限流、Key、没接进来……）：走内核那套解释，别在 REST 这头
  // 再抄一份措辞。**只有**内核自己的码才按码走——通用码（NOT_FOUND / INTERNAL …）
  // 在 REST 这头是另一回事，按码解释会把「这个会话已经不在了」说成「这个模型不存在」。
  // code 不给时 explainKnownTurnError 仍会扫原文（内核那套容错解析）。
  const server = asServerFailure(cause)
  const code = upstreamCodeOf(server)
  const explained = explainKnownTurnError(code, text)
  if (explained !== undefined) return `${explained.title}。${explained.hint}`
  return fallback
}

/** 是不是"这只可能是上游模型服务出的问题"的码；不是就返回 undefined（去扫原文）。 */
function upstreamCodeOf(server: ServerFailure | undefined): string | undefined {
  const code = (server?.code ?? '').trim().toUpperCase()
  return UPSTREAM_CODES.has(code) ? code : undefined
}

/**
 * 排障用的原文：折叠的「详情」里给的就是它。
 *
 * 与 {@link humanError} 是一对，但方向相反：这里一个字都不改，认不出也要给——
 * 认不出正是最需要原文的时候。给不出（抛的不是 Error / 没有 body）时返回
 * undefined，调用方据此连「详情」都不渲染。
 */
export function errorDetail(cause: unknown): string | undefined {
  const raw = rawTextOf(cause)
  if (raw === undefined) return undefined
  const text = flatten(raw)
  return text.length === 0 ? undefined : text
}
