/**
 * RyHarness PTC：让模型写一段程序，在宿主提供的异步函数上跑它。
 *
 * 三块：
 * - **契约**（{@link PtcRuntime}）：一次请求带程序、模式、绑定、文件策略与时限；一次
 *   结果带打印、返回值与失败信息。**失败是结果的一部分**，不抛异常——调用方要能把它
 *   原样呈现给模型。
 * - **Node 后端**（{@link NodePtcRuntime}）：在独立子进程里跑，子进程里跑的是本包自带的
 *   宿主脚本，程序在 `node:vm` 的独立上下文里执行——那里没有 `process`、没有 `require`、
 *   没有 `fs`。
 * - **文件策略**（{@link resolveFilePolicy} / {@link checkPath}）：程序能读哪些路径、能写
 *   哪些路径由宿主定；越界的读写会被拒。
 *
 * 没做的是上游那个**实验性的 Python 后端**：它要 CPython 进程与 fd-3 线协议，本轮不
 * 碰（理由写在 README 里）。
 * @module @ryharness/ptc
 */

export { createFileBindings, FILE_BINDING_NAMES } from './bindings.ts'
export { PtcBindingError } from './errors.ts'
export type { NodePtcRuntimeOptions } from './node.ts'
export { DEFAULT_PTC_TIMEOUT_MS, NodePtcRuntime } from './node.ts'
export type { FileAccess, PathDecision, ResolvedFilePolicy } from './policy.ts'
export { checkPath, resolveFilePolicy } from './policy.ts'
export type { ChildMessage } from './session.ts'
export type {
  PtcBinding,
  PtcFailure,
  PtcFailureKind,
  PtcFilePolicy,
  PtcMode,
  PtcPersistence,
  PtcRequest,
  PtcResult,
  PtcRuntime,
} from './types.ts'
export { isPtcMode, PTC_FAILURE_KINDS, PTC_MODES } from './types.ts'
