/**
 * 斜杠命令这一层的公共类型。
 *
 * 斜杠命令是**人**在输入框里敲的东西：`/goal 继续`。它跟普通消息的区别在于
 * 「不花模型一轮」——命中的命令直接跑自己的逻辑，跑完把结果给界面看，全程不
 * 进模型的对话历史。
 *
 * 所以这里的结果形状是固定的：文本 + 是否出错 + 可选的产物。界面拿它渲染，
 * 测试拿它断言，都不用猜这条命令到底干了什么。
 * @module @ryharness/commands/types
 */

/**
 * 合法的命令名：斜杠后面那一段。
 *
 * 只允许小写字母数字与连字符、下划线，且必须以字母数字开头。命令名要出现在
 * 界面补全里、要能当路由片段用，大小写混着来只会让「`/Goal` 算不算 `/goal`」
 * 这种问题反复出现——所以干脆只认小写。
 */
export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u

/**
 * 命令拿到的参数。
 *
 * `input` 是去掉命令名之后、去掉首尾空白的参数文本；`raw` 保留分隔空白，
 * 想要「用户到底敲了什么」的那条命令自己看 `raw`。
 */
/**
 * 一次命令执行的上下文（宿主给的）。
 *
 * 命令本身不认识会话与助理，但有些命令**按会话归属**（目标、待办、提醒都是）。
 * 宿主把它从请求里解出来放在这里，命令就不用自己去猜。
 */
export interface CommandContext {
  /** 当前会话 id。 */
  readonly sessionId?: string
}

export interface CommandArgs {
  /** 参数文本（首尾空白已去掉）；没有参数时是空串。 */
  readonly input: string
  /** 参数原文（保留分隔空白）。 */
  readonly raw: string
  /** 整行原始输入。 */
  readonly line: string
  /** 这次执行的上下文（宿主给的）。 */
  readonly context?: CommandContext
}

/** 命令产出的附件（界面据此渲染产物卡片）。 */
export interface CommandArtifact {
  /** 产物名字。 */
  readonly name: string
  /** 产物路径（有文件才有）。 */
  readonly path?: string
  /** 产物种类（自由文本，比如 `file` / `link`）。 */
  readonly kind?: string
}

/**
 * 命令跑完的结果。
 *
 * 所有命令都返回这一种形状：界面不需要为每条命令写一套渲染逻辑，测试也能
 * 拿同一套断言去看每条命令。
 */
export interface CommandResult {
  /** 给界面看的文本。 */
  readonly text: string
  /** 是否出错。缺省即没出错。 */
  readonly isError?: boolean
  /** 产物（可选）。 */
  readonly artifacts?: readonly CommandArtifact[]
}

/**
 * 一条命令。
 *
 * `execute` 是唯一要做的事：拿到参数，跑自己的逻辑，返回结果。它不碰模型，
 * 也不管结果怎么进历史——那是宿主的事。
 */
export interface CommandDefinition {
  /** 命令名（不含斜杠）。 */
  readonly name: string
  /** 一句话说明：这条命令干什么。 */
  readonly description: string
  /** 别名（不含斜杠）。 */
  readonly aliases?: readonly string[]
  /**
   * 执行。
   *
   * 第二个参数是宿主给的**这次执行的上下文**（会话 id 等）。按会话归属的命令
   * 从这里取当前会话，不用宿主自己记一份全局「当前会话」。
   */
  execute(args: CommandArgs, context?: CommandContext): Promise<CommandResult>
}

/** 清单里的一条命令（给界面补全用）。 */
export interface CommandSummary {
  /** 命令名。 */
  readonly name: string
  /** 一句话说明。 */
  readonly description: string
  /** 别名。 */
  readonly aliases: readonly string[]
}

/**
 * 一次执行的结果。
 *
 * 比 {@link CommandResult} 多两样：`name` 是跑的是哪条命令，`ran` 说明它到底
 * 有没有跑。没跑起来的情况有两种——输入根本不是命令，或者命令不存在——这两种
 * 要给用户不同的提示，所以不能只靠 `isError` 区分。
 */
export interface CommandExecution extends CommandResult {
  /** 跑的命令名；输入不是命令时缺省。 */
  readonly name?: string
  /** 命令是不是真的跑了。 */
  readonly ran: boolean
}
