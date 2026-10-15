/**
 * 一轮对话失败的人话解释。
 *
 * 内核 {@link HarnessError} 的 code 是给程序路由的稳定标识，message 是给排障看的
 * 原文——直接把它们甩进红条，用户看到的是「no adapter registered for provider
 * "siliconflow"」和「needs its API key in the RYAGENT_KEY_SILICONFLOW environment
 * variable」这类他既看不懂、也根本没法照做的信息（桌面应用里根本没有环境变量
 * 可设，key 是在「我的 → 模型供应商」里填的）。
 *
 * 这里只做一件事：把 (code, message) 翻成「出了什么事 + 下一步点哪里」。纯函数、
 * 无副作用、便于逐条钉死。查不到的失败走容错解析（扫 message 里的特征串），再查不到
 * 就老实把原文递出去并给出重试——绝不吞掉，也不假装认得。
 */

/** 错误条上的动作要跳到哪里（由 App 的导航接线消费，见 ChatView 的 onNavigate）。 */
export type TurnErrorTarget = 'me' | 'contacts' | 'retry'

export interface TurnErrorAction {
  /** 按钮文案。 */
  label: string
  /** 点击后要去的面板。 */
  target: TurnErrorTarget
}

export interface TurnErrorExplanation {
  /** 一句话说清出了什么事（红条首行）。 */
  title: string
  /** 下一步怎么弄（红条次行）。 */
  hint: string
  /** 可行动作；没有可做的（纯信息）时缺省。 */
  action?: TurnErrorAction
  /**
   * 原始报错。仅在**认不出**这条失败时给出：认得出的都在 title/hint 里说清楚了，
   * 再把原文挂上去只会把环境变量名、包名重新倒回用户眼前。
   */
  detail?: string
}

/** 原文最多保留这么长（红条一行放不下更多，且原文常常带整段响应体）。 */
const DETAIL_LIMIT = 160

const toMe: TurnErrorAction = { label: '去我的 → 模型供应商', target: 'me' }
const toContacts: TurnErrorAction = { label: '去通讯录改 agent', target: 'contacts' }
const retry: TurnErrorAction = { label: '重试这一轮', target: 'retry' }

/**
 * 认得出的失败码 → 人话。
 *
 * code 取自 packages/llm（{@link HarnessError.code} 的取值）与 apps/server 的
 * turn 错误码。同一码在不同供应商下措辞略有差别，这里给的是"用户该做什么"，
 * 不是供应商的原始措辞。
 */
const BY_CODE: Record<string, TurnErrorExplanation> = {
  MISSING_CREDENTIAL: {
    title: '这家模型服务还没配 API Key',
    hint: '在「我的 → 模型供应商」里选它、填上 Key，之后再重试这一轮。',
    action: toMe,
  },
  INVALID_CREDENTIAL: {
    title: 'API Key 没能通过验证',
    hint: 'Key 可能已失效、被撤销，或复制时带上了空格。换个 Key 再试。',
    action: toMe,
  },
  NO_ADAPTER: {
    title: '这个模型服务没接进来',
    hint: 'agent 绑的供应商在本机没有可用的接入配置，去「我的 → 模型供应商」确认它还在。',
    action: toMe,
  },
  RATE_LIMIT: {
    title: '模型服务在限流',
    hint: '等几十秒再重试，通常一两下就过去了。',
    action: retry,
  },
  QUOTA: {
    title: '账户额度或余额用完了',
    hint: '去模型服务商的网站充值或提额，回来再重试。',
    action: toMe,
  },
  NOT_FOUND: {
    title: '这个模型不存在',
    hint: '模型 id 变了或被下架了，去通讯录里给这个 agent 换一个。',
    action: toContacts,
  },
  CONTEXT_WINDOW_EXCEEDED: {
    title: '这段对话已经超出模型的上下文了',
    hint: '新开一个会话接着聊，或者先把很长的附件收一收。',
    action: retry,
  },
  INVALID_ARGS: {
    title: '模型服务不认这次请求',
    hint: '多半是模型名或参数不对，去通讯录里检查这个 agent 的模型设置。',
    action: toContacts,
  },
  TIMEOUT: {
    title: '模型服务没在时限内应答',
    hint: '多半是网络或服务商在抖，直接重试。',
    action: retry,
  },
  SERVER: {
    title: '模型服务那边出错了',
    hint: '这是服务商侧的问题，稍后重试。',
    action: retry,
  },
  TRANSPORT: {
    title: '连不上模型服务',
    hint: '检查网络或本机代理后重试。',
    action: retry,
  },
  EMPTY_RESPONSE: {
    title: '模型这次什么都没回',
    hint: '重试一次通常就正常了。',
    action: retry,
  },
  DISPATCHER_NOT_MEMBER: {
    title: '这个群没有调度员',
    hint: '把调度员加回群成员，或在通讯录里重建一个群。',
    action: toContacts,
  },
  /** 发送阶段就失败：消息根本没到服务端（正文自己派不上用场，解释权交给发送方）。 */
  HTTP: {
    title: '这条消息没发出去',
    hint: '它还留在输入框旁边，点「重试」再发一次。',
    action: retry,
  },
}

/**
 * 认不出的 code（UNKNOWN / INTERNAL / 服务端自造码）下的容错解析：扫 message。
 *
 * 内核里若干失败是普通 Error 抛的（code 落到 UNKNOWN），但 message 里带着足够
 * 定位故障的线索。这里只在**认不出**时才扫——扫出来的解释和 code 命中的同一条
 * 没有区别，用户看到的东西不该因为他那条失败"碰巧"少了 code 而变样。
 */
const BY_MESSAGE: { match: RegExp; explanation: TurnErrorExplanation }[] = [
  {
    match: /needs its api key|missing[_ ]credential|api[_ ]?key.*(not configured|未配置|not set)/i,
    explanation: BY_CODE.MISSING_CREDENTIAL as TurnErrorExplanation,
  },
  {
    match: /no adapter registered|no provider route .* is configured/i,
    explanation: BY_CODE.NO_ADAPTER as TurnErrorExplanation,
  },
  {
    match: /unknown agent|agent .*(not found|不存在|被删)/i,
    explanation: {
      title: '这个 agent 已经不在了',
      hint: '它可能刚被删除。去通讯录里挑一个还在的 agent 重建会话。',
      action: toContacts,
    },
  },
  {
    match: /model[_ ]?not[_ ]?found|unknown model|model .*(does not exist|not found)/i,
    explanation: BY_CODE.NOT_FOUND as TurnErrorExplanation,
  },
  {
    match: /invalid[_ ]?api[_ ]?key|unauthorized|\b401\b/i,
    explanation: BY_CODE.INVALID_CREDENTIAL as TurnErrorExplanation,
  },
  {
    match: /rate[_ ]?limit|\b429\b|too many requests/i,
    explanation: BY_CODE.RATE_LIMIT as TurnErrorExplanation,
  },
  {
    match: /insufficient[_ ]quota|quota exceeded|余额不足|额度用尽/i,
    explanation: BY_CODE.QUOTA as TurnErrorExplanation,
  },
  {
    match: /context[_ ]length|context[_ ]window.*exceed|too long for this model/i,
    explanation: BY_CODE.CONTEXT_WINDOW_EXCEEDED as TurnErrorExplanation,
  },
]

/** 截断原文并压成一行（红条里换行的报错会撑破布局）。 */
function detailOf(message: string): string | undefined {
  const flat = message.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return undefined
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT)}…` : flat
}

/**
 * 把一轮失败翻成「标题 + 怎么办 + 可点的下一步」。
 *
 * @param code 内核 HarnessError / 服务端 turn 错误码（大小写不敏感，缺省或空串视为未知）。
 * @param message 原始报错文本；仅当 code 与特征串都没命中时才原样递出。
 */
export function explainTurnError(code: string | undefined, message: string): TurnErrorExplanation {
  const normalized = (code ?? '').trim().toUpperCase()
  const known = BY_CODE[normalized]
  if (known !== undefined) return known
  for (const candidate of BY_MESSAGE) {
    if (candidate.match.test(message)) return candidate.explanation
  }
  const detail = detailOf(message)
  return {
    title: '这一轮没跑起来',
    hint: '重试一次；还是不行就把下面这句报给开发者，里面有具体原因。',
    action: retry,
    ...(detail === undefined ? {} : { detail }),
  }
}
