/**
 * 轮次引擎：会话内串行的并发轮次链（enqueueTurn / cancelTurn / rewriteHistory /
 * runTurn）与其全部运行时状态（排队/在途/预占序号/AbortController）。
 *
 * 从组合根（app.ts）抽出：这段链路此前埋在 1800 行的组合根里，想验证它的排队、
 * 取消与历史改写语义只能把整个服务起起来。抽成类 + 显式依赖注入（组合根给依赖
 * 对象，本模块不反向依赖 server 类）后，它仍然只做名字里的事——「这一轮怎么排队、
 * 怎么取消、怎么把协调器事件流翻成 WS 事件」；HTTP/WS/插件与停机顺序等生命周期
 * 留在 RyHarnessServer。runTurn 的 RyVibe 状态机、遥测打点、审批撤卡全部经构造
 * 参数注入（vibeStore / telemetry / approvals）。
 * @module @ryharness/server/turn-engine
 */

import type { RunContext, SessionCoordinator, SessionStore } from '@ryharness/session'
import type { ApprovalBroker } from './approvals.ts'
import type { EventHub } from './bus.ts'
import type { WsEvent } from './events.ts'
import type { QuestionStore } from './plugins/ask-user-store.ts'
import type { TurnConversation } from './routes/conversations.ts'
import type { Telemetry } from './telemetry.ts'
import {
  createTurnTranslator,
  normalizeDirectEvents,
  normalizeGroupEvents,
  type TurnTranslationState,
} from './turn-events.ts'
import type { VibeStore } from './vibe/store.ts'

/**
 * 排队中、还没开始的一轮对话（会话内串行链上等在别人后面的那些）。
 *
 * `cancelled` 由取消端点置位：链条轮到它时直接跳过——不落库、不调模型——但仍要为它
 * 补一条终局事件。跳过而不收口的话，渲染层那条排队的用户消息永远停在"排队中"：
 * 用户点了一次停止，却只停掉了在途那一轮，队列里剩下的照跑不误。
 */
interface QueuedTurn {
  conversation: TurnConversation
  cancelled: boolean
  /** 重放轮次：库里已有那条用户消息，不追加新的。 */
  replay: boolean
  /**
   * 本轮的轮次序号：**入队那一刻**就预占了。
   *
   * 库里 max(turn_index)+1 只能反映已经落库的那几轮；同一会话串行排队时，后面
   * 几轮在入队那一刻都还没落库，按库里最大值推会拿到同一个号——两轮共用一个
   * 轮次序号，事件的对帧、气泡的键、渲染层的分组全都会串。
   */
  turnIndex: number
}

/**
 * 在途轮次的运行时状态。
 *
 * `superseded` 记的是"这一轮是被**历史改写**顶掉的（编辑 / 重新生成），不是用户
 * 按了停止"。两者都表现为中止，但含义不同：用户按停止是一次明确的操作，界面该
 * 告诉他"已停止生成"；历史改写是用户主动要求重来，那一轮的输出马上要作废，再弹
 * 一条红色横幅只会让人以为出了故障。
 */
interface ActiveTurn {
  controller: AbortController
  /** 已被历史改写顶掉：中止时不发 ABORTED 错误。 */
  superseded: boolean
}

/** 轮次引擎的依赖（组合根显式注入）。 */
export interface TurnEngineOptions {
  readonly store: SessionStore
  readonly coordinator: SessionCoordinator
  /** WS 事件出口：发布时打每会话单调递增的 seq（EventHub）。 */
  readonly hub: EventHub
  /** 一轮一条计量：首 token 延迟、总耗时、记忆召回（scopedTurn 的异步上下文也在这里）。 */
  readonly telemetry: Telemetry
  /** 工具读写文件的工作区根目录（RunContext.workspaceRoot）。 */
  readonly workspaceRoot: string
  /** RyVibe 会话存储：runTurn 开跑置 building、收工按结局置 done/asking/failed。 */
  readonly vibeStore: VibeStore
  /** 提问存储：RyVibe 终态看「还有没有待答题」。 */
  readonly questionStore: QuestionStore
  /** 工具执行审批桥：取消/顶掉轮次时把挂起的审批一起收口（只调用，不改它）。 */
  readonly approvals: ApprovalBroker
}

/**
 * 并发轮次引擎：同会话消息串行处理（每个会话一条 turn 链），新消息在上一轮
 * 结束后运行；取消与历史改写沿各自语义打断链条。
 */
export class TurnEngine {
  /** 每个会话一条 turn 链：同会话消息串行处理，新消息在上一 turn 结束后运行。 */
  private readonly turnChains = new Map<string, Promise<void>>()
  /** 在途轮次的中止器（取消端点用它打断 LLM 流与工具执行）。 */
  private readonly activeTurns = new Map<string, ActiveTurn>()
  /**
   * 各会话**已预占**的轮次序号：排队中的轮次也要占一个号，否则它们会共用同一个号。
   *
   * 库里 max(turn_index)+1 只看得到已经落库的那几轮。入队那一刻后面几轮都还没
   * 落库，按库里最大值推必然撞号。这里的水位线让每一轮入队就领走一个号，执行时
   * 原样用回（同时传给协调器，两边对得上）。
   */
  private readonly reservedTurns = new Map<string, number>()
  /**
   * 各会话「已入队但还没开始」的轮次：取消端点靠它把队列一起清掉。
   *
   * 与 turnChains 分开记：链条上跑着的那一轮该由 activeTurns 中止，而排队里的
   * 那些还没有 AbortController，中止它们要靠跳过执行 + 补终局事件。
   */
  private readonly queuedTurns = new Map<string, Set<QueuedTurn>>()

  constructor(private readonly options: TurnEngineOptions) {}

  private publish(event: WsEvent): void {
    this.options.hub.publish(event)
  }

  /** 该会话此刻有没有在跑/在排队的轮次（RyVibe 页面区分「还在做」与「做完了」）。 */
  isTurnActive(conversationId: string): boolean {
    return this.activeTurns.has(conversationId) || this.queuedTurns.has(conversationId)
  }

  /** 各会话链条上尚未收口的 Promise（优雅停机等在途 turn 完成用）。 */
  pendingTurns(): Promise<void>[] {
    return [...this.turnChains.values()]
  }

  /**
   * 给该会话预占一个轮次序号。
   *
   * 号从两个来源里取大的那个：库里已经落库的最大值（+1），以及本会话已预占的水位
   * 线（+1）。前者覆盖"库里已有历史"的情况，后者覆盖"同一会话正在排队、后面几轮
   * 还没落库"的情况——后者才是排队撞号的根源。
   */
  private reserveTurnIndex(conversationId: string): number {
    const base = this.options.store.nextTurnIndex(conversationId)
    const reserved = this.reservedTurns.get(conversationId)
    const next = reserved === undefined || base > reserved ? base : reserved + 1
    this.reservedTurns.set(conversationId, next)
    return next
  }

  /**
   * 把一轮对话排进该会话的串行链；上一 turn 未结束时先发 queued 事件。
   *
   * @returns 本轮领到的轮次序号（调用方拿它发事件，两端才对得上）。
   */
  enqueueTurn(conversation: TurnConversation, text: string, options: { replay?: boolean } = {}): number {
    const tail = this.turnChains.get(conversation.id)
    const turnIndex = this.reserveTurnIndex(conversation.id)
    const entry: QueuedTurn = { conversation, cancelled: false, replay: options.replay === true, turnIndex }
    if (tail !== undefined) {
      // 登记在册：/cancel 要能清掉「已排队、还没开始」的轮次，而不只是中止在途那一轮。
      const queued = this.queuedTurns.get(conversation.id) ?? new Set<QueuedTurn>()
      queued.add(entry)
      this.queuedTurns.set(conversation.id, queued)
      /**
       * queued 事件**不报 turnIndex**：这一轮此刻还没有自己的序号（同一会话串行，
       * 它的序号要等真正执行时由 runTurn 取），入队时刻独立读一次 nextTurnIndex
       * 只会给出一个「排队者」的错值——留着一个会骗人的字段不如不带。
       */
      this.publish({ type: 'queued', conversationId: conversation.id, senderId: 'user' })
    }
    const run = (tail ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        // 从「还没开始」升格为「在途」：取消端点此后改由 activeTurns 中止它。
        this.forgetQueuedTurn(entry)
        if (entry.cancelled) return
        // 会话 id 随整轮对话的异步链一起传下去：记忆钩子的 recall 拿不到它，
        // 遥测靠这个上下文把召回耗时记到正确的轮次上（多会话并发时不会记串）。
        return this.options.telemetry.scopedTurn(conversation.id, () => {
          return this.runTurn(conversation, text, { replay: entry.replay, turnIndex: entry.turnIndex })
        })
      })
    const chain = run.then(
      () => {
        if (this.turnChains.get(conversation.id) === chain) this.turnChains.delete(conversation.id)
      },
      () => {
        if (this.turnChains.get(conversation.id) === chain) this.turnChains.delete(conversation.id)
      },
    )
    this.turnChains.set(conversation.id, chain)
    return turnIndex
  }

  /** 摘掉一条已经轮到执行（或已被取消）的排队记录。 */
  private forgetQueuedTurn(entry: QueuedTurn): void {
    const queued = this.queuedTurns.get(entry.conversation.id)
    if (queued === undefined) return
    queued.delete(entry)
    if (queued.size === 0) this.queuedTurns.delete(entry.conversation.id)
  }

  /**
   * 取消该会话：中止在途的一轮，并把还没开始的排队轮次一起清掉。
   *
   * 队列语义是必要的：点「停止」的人在 UI 上看到的是"这一串消息我都不想它跑了"，
   * 而排队里那几条在渲染层同样是刚发出去、正显示着"排队中"的消息。只中止在途
   * 那一轮的话，它们会在前一轮结束后自己接着跑——用户以为停了，对话框却又冒出一条
   * 没人期待的回复。
   *
   * 被清掉的每一轮都要留一条终局事件：senderId 为 'user' 的 message-done，正对
   * 应 POST /messages 时推过的那条 message-start(user)，渲染层靠这对事件把排队的
   * 用户气泡收口、退出排队态（取消是用户自己的动作，不该冒成一条错误横幅）。
   *
   * 回执里的 queueCleared 是**实际清掉的条数**：没有排队项时是 0，调用方据此知道
   * "只中止了在途那一轮"，而不是被一句笼统的 cancelled=true 骗过去。
   */
  cancelTurn(conversationId: string): { cancelled: boolean; queueCleared: number } {
    const active = this.activeTurns.get(conversationId)
    if (active !== undefined) active.controller.abort()
    // 在途轮次里等批准的命令全部按取消收口：不留一张永远等不来的审批卡。
    this.options.approvals.cancelConversation(conversationId)
    let queueCleared = 0
    const queued = this.queuedTurns.get(conversationId)
    if (queued !== undefined) {
      this.queuedTurns.delete(conversationId)
      /**
       * 被清掉的每一轮都要报**它自己**的轮次序号，不是同一个号发两遍。
       *
       * 序号在这里现算（库里 max+1 起）而不是用 entry.turnIndex：被取消的轮次
       * 永远不会执行、也永远不会落库，它预占的号要让给后面真正会跑的轮次。但
       * 渲染层那条排队的用户气泡是按号认领的（见 store 的 message-done 兜底），
       * 几条排队消息共用一个号就只有第一条能被收口，其余永远停在"排队中"。
       */
      let turnIndex = this.options.store.nextTurnIndex(conversationId)
      for (const entry of queued) {
        entry.cancelled = true
        queueCleared += 1
        this.publish({ type: 'message-done', conversationId, senderId: 'user', turnIndex })
        turnIndex += 1
      }
    }
    return { cancelled: active !== undefined, queueCleared }
  }

  /**
   * 顶掉该会话在途的一轮：中止它，并记下"这是被历史改写顶掉的，不是用户按了停止"。
   *
   * 供「编辑并重发 / 重新生成」用：那两件事要把一段历史整个换掉，在途那一轮正
   * 按**旧历史**生成，输出马上就要作废——继续烧 token 没有意义。
   */
  private supersedeTurn(conversationId: string): void {
    const active = this.activeTurns.get(conversationId)
    if (active === undefined) return
    active.superseded = true
    active.controller.abort()
    // 被顶掉的轮次等批准的命令同样按取消收口（同 cancelTurn 的理由）。
    this.options.approvals.cancelConversation(conversationId)
  }

  /**
   * 丢掉该会话还没开始的排队轮次（它们的上下文马上要作废）。
   *
   * 与取消端点的差别只在于**不动在途那一轮**、也不发"已停止"横幅：这是历史改写
   * 的一部分，不是用户喊停。被丢掉的轮次同样要各自报自己的轮次序号，渲染层才能
   * 把那几条排队的用户气泡一条条收口。
   */
  private discardQueuedTurns(conversationId: string): void {
    const queued = this.queuedTurns.get(conversationId)
    if (queued === undefined) return
    this.queuedTurns.delete(conversationId)
    let turnIndex = this.options.store.nextTurnIndex(conversationId)
    for (const entry of queued) {
      entry.cancelled = true
      this.publish({ type: 'message-done', conversationId, senderId: 'user', turnIndex })
      turnIndex += 1
    }
  }

  /**
   * 改写该会话的历史，并把被改写的那一轮重放一遍。
   *
   * 这是对会话历史的**独占**改写，必须与同会话的其他轮次串行，顺序一步都不能换：
   *
   * 1. 中止在途那一轮——它正按**旧历史**生成，输出马上就要作废；
   * 2. 丢掉排队里的轮次——它们的上下文同样作废；
   * 3. 等在途那一轮**彻底收工**——它收工时还会往库里写最后几条消息（半截回复、
   *    工具结果）。不等就会在截断之后又冒出来：库里就成了"问 B 答 A"，重放那一轮
   *    的前置条件（末尾必须是用户消息）也不成立；
   * 4. 截断 + 改写；
   * 5. 重放：把库里那条用户消息原样再答一遍。
   *
   * 第 3 步靠会话的串行链保证：改写挂在链条尾上，轮到它时前面的轮次都收工了。
   *
   * @returns 改写结果。`applied` 为 true 表示**历史已经改完**（库里已是改写后的
   *   样子，调用方可以安全地重拉历史）；为 false 表示没改（附原因）。
   */
  async rewriteHistory(
    conversation: TurnConversation,
    plan: { truncateFrom: number; editText?: { seq: number; text: string }; replayText: string },
  ): Promise<{ applied: boolean; error?: string }> {
    // 1、2 立刻做：别等在途那一轮跑完才停，那段时间烧的 token 全是白烧。
    this.supersedeTurn(conversation.id)
    this.discardQueuedTurns(conversation.id)

    const tail = this.turnChains.get(conversation.id)
    const turnIndex = this.reserveTurnIndex(conversation.id)
    let settle: (result: { applied: boolean; error?: string }) => void = () => {}
    const applied = new Promise<{ applied: boolean; error?: string }>((resolve) => {
      settle = resolve
    })

    const run = (tail ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // 走到这里说明在途那一轮已经彻底收工：库里不会再有它写的消息。
        if (plan.editText !== undefined) {
          /**
           * 先改写正文、再截断。顺序反了的话，一条**改不了**的消息（带附件、含工具
           * 块）会先把后面整段历史截掉才发现自己改不了——用户什么都没点错，历史却
           * 没了。改写失败就到此为止，一个字都不动。
           */
          const ok = this.options.store.updateUserMessageText(conversation.id, plan.editText.seq, plan.editText.text)
          if (!ok) {
            settle({ applied: false, error: 'message cannot be edited' })
            return
          }
        }
        this.options.store.truncateMessages(conversation.id, plan.truncateFrom)
        /**
         * 用户这一轮开始的信号：与 POST /messages 同一个事件，渲染层靠它把"生成中"
         * 的状态复位。号码用预占的那个——库里此刻还看不到这一轮。
         */
        this.publish({
          type: 'message-start',
          conversationId: conversation.id,
          senderId: 'user',
          senderName: '用户',
          turnIndex,
        })
        /**
         * 让出一次事件循环再开始重放：调用方（路由）等的是 applied，拿到兑现就会
         * 回 202，渲染层收到回执后重拉历史。若这里同步开跑，重放的 message-start
         * 会比那条 202 更早到达界面，渲染层随后的一次清屏就把刚开的气泡抹了。
         */
        await new Promise<void>((resolve) => {
          setImmediate(resolve)
        })
        settle({ applied: true })
        await this.options.telemetry.scopedTurn(conversation.id, () => {
          return this.runTurn(conversation, plan.replayText, { replay: true, turnIndex })
        })
      })
    const chain = run.then(
      () => {
        if (this.turnChains.get(conversation.id) === chain) this.turnChains.delete(conversation.id)
      },
      () => {
        if (this.turnChains.get(conversation.id) === chain) this.turnChains.delete(conversation.id)
      },
    )
    this.turnChains.set(conversation.id, chain)
    return applied
  }

  /** 执行一轮对话（异步）：消费协调器事件流并发布 WS 事件。 */
  private async runTurn(
    conversation: TurnConversation,
    text: string,
    options: { replay?: boolean; turnIndex?: number } = {},
  ): Promise<void> {
    const { coordinator, store } = this.options
    /**
     * 本轮的 turn 序号。
     *
     * 正常路径由调用方（轮次链）在**入队那一刻**预占并传进来：库里 max+1 只看得见
     * 已落库的那几轮，同会话排队时后面几轮在入队时都还没落库，按库里最大值推必然
     * 撞号。历史改写那条路径没有入队环节，它自己预占。
     *
     * start 与 done 必须发同一个值：渲染层按 (senderId, turnIndex) 找那条流式气泡，
     * 两端对不上就永远收不了口——光标不灭、停止按钮长亮（真实供应商下曾整轮停在
     * "生成中"）。曾经 message-start 发 nextTurnIndex-1、message-done 也在自己
     * 的时刻重算一遍：空会话时前者算出 -1、后者算出 0，永远对不上。
     */
    const turnIndex = options.turnIndex ?? store.nextTurnIndex(conversation.id)
    // 每轮一个 AbortController：取消端点通过它中止 LLM 流与工具执行。
    const controller = new AbortController()
    const active: ActiveTurn = { controller, superseded: false }
    this.activeTurns.set(conversation.id, active)
    /**
     * 翻译状态：本轮已开气泡、还没收口的发言者（渲染层按 senderId 认领那条流式
     * 气泡）、累计用量与结局。finally 里给剩下的每个发言者补一条 message-done，
     * 见那里的说明。归一/翻译层（turn-events.ts）逐事件读写同一份。
     */
    const translation: TurnTranslationState = {
      conversationId: conversation.id,
      turnIndex,
      kind: conversation.kind === 'group' ? 'group' : 'direct',
      openBubbles: new Set<string>(),
      usage: undefined,
      status: 'ok',
      failureReason: undefined,
    }
    // 本轮的耗时画像：第一个文本增量即"用户开始看到字"的时刻。
    const recorder = this.options.telemetry.beginTurn(
      conversation.id,
      conversation.kind === 'group' ? 'group' : 'direct',
      turnIndex,
    )
    const translate = createTurnTranslator(translation, {
      publish: (event) => {
        this.publish(event)
      },
      markFirstToken: () => {
        recorder.markFirstToken()
      },
    })
    /**
     * RyVibe 会话的状态是**存出来的**（见 vibe/store.ts）。
     *
     * 页面要能分清"小队正在做""做完了""没做出来"三件事，所以状态不能现算：现算的
     * 话，一轮失败（模型报错、用户点停止）会落到"没有待答题、也没有在跑的轮子"
     * = done，页面于是宣布「方案好了」而下面空空如也。
     */
    const vibeSession = this.options.vibeStore.byConversation(conversation.id)
    if (vibeSession !== undefined) {
      await this.options.vibeStore.setStatus(vibeSession.id, 'building')
    }
    // 协调器在每次模型调用出账后回调；记下本轮累计，done 事件带给渲染层。
    const runContext: RunContext = {
      workspaceRoot: this.options.workspaceRoot,
      signal: controller.signal,
      onUsage: (report) => {
        translation.usage = report.turnTotal
      },
    }
    try {
      if (conversation.kind === 'direct') {
        const agentId = conversation.memberAgentIds[0] as string
        // 单聊整轮只有一个发言者：气泡（message-start）在消费事件流之前就开，
        // done 收口同一个人——归一层保持这个先后（见 normalizeDirectEvents）。
        const senderName = store.getAgent(agentId)?.name ?? agentId
        const events = normalizeDirectEvents(
          coordinator.chatDirect(conversation.id, agentId, text, runContext, {
            replay: options.replay === true,
            turnIndex,
          }),
          agentId,
          senderName,
        )
        for await (const event of events) translate(event)
        return
      }

      // 群聊第一轮由调度员派工。老数据里可能有「调度员已被移出成员」的群（建群
      // 时前端只校验成员存在、不校验调度员是否在名单内）：与其让每条消息都以
      // UNKNOWN_AGENT 报错，不如在第一轮就说明白要怎么修。
      const dispatcherId = conversation.dispatcherAgentId
      if (dispatcherId !== undefined && !conversation.memberAgentIds.includes(dispatcherId)) {
        this.publish({
          type: 'error',
          conversationId: conversation.id,
          message: `这个群的调度员「${dispatcherId}」不在成员名单里，没法派工。请把它加回成员，或在通讯录里重建一个群。`,
          code: 'DISPATCHER_NOT_MEMBER',
        })
        return
      }

      // 成员显示名在开口那一刻现查（与拆分前 ensureStart 的 store.getAgent 时机一致）：
      // 改名下一轮生效，不需要重启。
      for await (const event of normalizeGroupEvents(
        coordinator.chatGroup(conversation.id, text, runContext, {
          replay: options.replay === true,
          turnIndex,
        }),
        (agentId) => {
          return store.getAgent(agentId)?.name ?? agentId
        },
      )) {
        translate(event)
      }
    } catch (error) {
      translation.status = controller.signal.aborted ? 'aborted' : 'error'
      translation.failureReason = controller.signal.aborted
        ? '这一轮被停掉了'
        : error instanceof Error
          ? error.message
          : String(error)
      // 取消不是故障：给一个明确的 code，渲染层据此显示"已停止"而不是红条报错。
      if (controller.signal.aborted) {
        /**
         * 但「被历史改写顶掉」不算取消，也不该报错：用户点了重新生成，那一轮的
         * 输出本来就要作废。为此再弹一条红色"已停止生成"，只会让人以为出了故障。
         * 气泡照常收口（下面的 finally 会补 message-done）。
         */
        if (!active.superseded) {
          this.publish({
            type: 'error',
            conversationId: conversation.id,
            message: '已停止生成',
            code: 'ABORTED',
          })
        }
      } else {
        this.publish({
          type: 'error',
          conversationId: conversation.id,
          message: error instanceof Error ? error.message : String(error),
          code: 'INTERNAL',
        })
      }
    } finally {
      /**
       * 兜底收口：一轮对话有三种结束方式，只有两种会自带 message-done——正常走完
       * （done），以及"取消但已经写出了半截回复"（循环先补一条 done 再抛
       * AbortedError，好让半截内容落库）。第三种是**裸 error**：上游模型调用失败时
       * 循环只 yield 一条 error 就 return，不再有 done；而循环直接抛错（工具炸了
       * 等非取消路径）时更是一次 done 都没有。这些路径上渲染层那条气泡没人收口——
       * 光标不灭、停止按钮长亮，整轮停在"生成中"，而服务端这边早已收工。
       *
       * 这里给每个还开着的发言者补一条 message-done：error 事件本身照发不误（失败
       * 原因要如实显示，不该被收口动作吞掉），补的只是那条缺失的终局事件。已经
       * 收口过的发言者不在集合里，正常路径不会多发。
       */
      for (const senderId of translation.openBubbles) {
        this.publish({
          type: 'message-done',
          conversationId: conversation.id,
          senderId,
          turnIndex,
          ...(translation.usage === undefined ? {} : { usage: translation.usage }),
        })
      }
      if (this.activeTurns.get(conversation.id) === active) {
        this.activeTurns.delete(conversation.id)
      }
      // RyVibe 的终态：这一轮要么把方案做出来了，要么失败——失败也是一个**看得见**
      // 的状态（页面据此显示原因和「重试」），不能悄悄变成"方案好了"。
      if (vibeSession !== undefined) {
        if (translation.status === 'ok') {
          const pending = this.options.questionStore.list(conversation.id, 'pending').length
          await this.options.vibeStore.setStatus(vibeSession.id, pending > 0 ? 'asking' : 'done')
        } else {
          await this.options.vibeStore.setStatus(
            vibeSession.id,
            'failed',
            translation.failureReason ?? '小队没能给出方案',
          )
        }
      }
      // 一轮一条计量：首 token 延迟、总耗时、记忆召回耗时与条数。
      this.options.telemetry.endTurn(recorder, translation.status)
    }
  }
}
