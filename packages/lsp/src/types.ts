/**
 * 代码导航这一层的公共类型。
 *
 * 核心主张只有一条：**provider 可以换，模型拿到的东西不能变**。所以位置一律是
 * `{ uri, line, character }`（行与列都从 0 起），hover 一律是文本，失败一律是
 * {@link LspError}。各家语言服务器协议里的原样形状（`LocationLink`、
 * `MarkupContent`、`MarkedString`…）只允许出现在 provider 内部，不许透出去。
 * @module @ryharness/lsp/types
 */

import type { LspError } from './errors.ts'

/**
 * 四个只读操作。
 *
 * 上游 dsh 的 lsp 家族也只做这四个：跳定义、找引用、找实现、读 hover 文档。
 * 跨文件重构、workspace symbol 之类不在射程内（见 README 的「没做的部分」）。
 */
export type LspOperation = 'definition' | 'references' | 'implementations' | 'hover'

/** 全部操作（顺序固定，界面下拉与文档都用这一份）。 */
export const LSP_OPERATIONS: readonly LspOperation[] = ['definition', 'references', 'implementations', 'hover']

/**
 * 一次操作的中位置（源文件里的位置）。
 *
 * 行与列都从 0 起，与 LSP 协议一致（协议自己也是 0 起）。列是 UTF-16 code unit，
 * 不是字节也不是「显示宽度」——中日韩字符在协议里算一格还是两格，取决于客户端与
 * 服务器对 `positionEncoding` 的协商，本包不参与协商，就按协议的默认口径走。
 */
export interface LspSourcePosition {
  /** 行号，从 0 起。 */
  readonly line: number
  /** 列号，从 0 起（UTF-16 code unit）。 */
  readonly character: number
}

/**
 * 一个归一化后的位置。
 *
 * `uri` 是 `file://` 形式的绝对路径 URI（`pathToUri` 生成）；行与列从 0 起。
 */
export interface LspLocation {
  /** 目标文件 URI。 */
  readonly uri: string
  /** 目标行号，从 0 起。 */
  readonly line: number
  /** 目标列号，从 0 起。 */
  readonly character: number
}

/** 一段范围（起点与终点都是 0 起的行/列）。 */
export interface LspRange {
  /** 起点。 */
  readonly start: LspSourcePosition
  /** 终点。 */
  readonly end: LspSourcePosition
}

/**
 * hover 的结果：一段可能带 Markdown 的文档文本。
 *
 * 协议里 hover 内容有四种形态（纯字符串、`MarkupContent`、`MarkedString`、
 * `MarkedString[]`），本包把它们**统一成一段文本**：带语言标记的代码块会被包成
 * Markdown 的围栏代码块，其余原样保留。
 */
export interface LspHover {
  /** 文档文本（可能是 Markdown）。 */
  readonly contents: string
  /** 这段文档对应的范围；服务器没给就没有。 */
  readonly range?: LspRange
}

/**
 * provider 自己声明的能力。
 *
 * 「声明」不是「声称」：{@link LspService} 在派发之前会拿它挡一道，不支持的操作
 * 直接回结构化错误，不会打到服务器那儿去。
 */
export interface LspProviderCapabilities {
  /** 这个 provider 支持哪些操作。 */
  readonly operations: readonly LspOperation[]
  /** 降级说明：做不到什么、为什么。有话要说就说，别藏着。 */
  readonly notes?: readonly string[]
}

/**
 * 一个代码导航 provider。
 *
 * 「provider」= 一个能回答这四个问题的后端。stdio 语言服务器是最常见的一种，
 * 但接口本身不要求它是个子进程——将来接远程 LSP 也只要再写一个实现。
 *
 * 实现方要遵守的两条：
 * 1. 返回**归一化**后的形状，不要把协议原样透出去；
 * 2. 失败时抛 {@link LspError}，别把服务器的英文异常原样往上抛。
 */
export interface LspProvider {
  /** provider 的标识（登记与排查用，唯一即可）。 */
  readonly id: string
  /** 这个 provider 处理哪些文件扩展名（带点，小写，例如 `.ts`）。 */
  readonly extensions: readonly string[]
  /** 自己支持哪些操作。 */
  readonly capabilities: LspProviderCapabilities
  /** 跳定义：目标位置列表（找不到就是空数组）。 */
  definition(filePath: string, position: LspSourcePosition): Promise<LspLocation[]>
  /** 找引用：引用位置列表（找不到就是空数组）。 */
  references(filePath: string, position: LspSourcePosition): Promise<LspLocation[]>
  /** 找实现：实现位置列表（找不到就是空数组）。 */
  implementations(filePath: string, position: LspSourcePosition): Promise<LspLocation[]>
  /** 读 hover 文档；没有就返回 undefined。 */
  hover(filePath: string, position: LspSourcePosition): Promise<LspHover | undefined>
  /** 收尾（关进程之类）。不实现也行。 */
  dispose?(): Promise<void>
}
