/**
 * 代码导航服务：按文件类型挑 provider，把四个只读操作派下去。
 *
 * 这一层是模型与语言服务器之间**唯一**的中间人。它管两件事：
 *
 * 1. **挑谁来做**：按文件扩展名挑一个能处理它的 provider。没有合适的就回一句
 *    「这个文件类型没有配语言服务器」——**不用 grep 之类的手段顶替**。顶替的后果
 *    是模型以为拿到了定义位置，其实拿到的是一段文本；后面每一步都建立在错的前提上。
 * 2. **结果长一个样**：provider 各自返回什么不重要，出这一层之后一律是
 *    `{ uri, line, character }` 或一段文本。换语言服务器不改变模型拿到的东西。
 *
 * 失败一律抛 {@link LspError}：`code` 机器可读，`message` 一句中文原因。
 * @module @ryharness/lsp/service
 */

import { LspError } from './errors.ts'
import type { LspHover, LspLocation, LspOperation, LspProvider, LspSourcePosition } from './types.ts'
import { fileExtension } from './uri.ts'

/**
 * 挑一个能处理这个文件的 provider。
 *
 * 挑的规则只有一条：**扩展名对得上**。多个 provider 都对得上时，先登记的赢——
 * 登记顺序是宿主定的，所以结果是可预期的，不会随运行时刻变化。
 * @param providers - 候选 provider。
 * @param filePath - 要导航的文件。
 * @returns 挑中的 provider；一个都没有就是 undefined。
 */
export function selectProvider(providers: readonly LspProvider[], filePath: string): LspProvider | undefined {
  const extension = fileExtension(filePath)
  if (extension.length === 0) return undefined
  return providers.find((provider) => provider.extensions.includes(extension))
}

/**
 * 代码导航服务。
 *
 * 典型用法：先把配好的语言服务器注册进来，再让 agent 调那四个方法。
 *
 * ```ts
 * const lsp = new LspService()
 * lsp.register(new StdioLspProvider({
 *   command: 'typescript-language-server',
 *   args: ['--stdio'],
 *   extensions: ['.ts', '.tsx'],
 *   rootPath: workspace,
 * }))
 * const targets = await lsp.definition('src/app.ts', { line: 10, character: 4 })
 * ```
 */
export class LspService {
  private readonly providers: LspProvider[] = []

  /**
   * 登记一个 provider。
   *
   * 同一个 id 登记两次算替换：后登的那个接管，先登的那个被挤掉。
   * @param provider - 要登记的 provider。
   */
  register(provider: LspProvider): void {
    const existing = this.providers.findIndex((item) => item.id === provider.id)
    if (existing >= 0) {
      this.providers[existing] = provider
      return
    }
    this.providers.push(provider)
  }

  /**
   * 撤掉一个 provider。
   * @param providerId - provider 的 id。
   * @returns 撤掉了就是 true，本来就没有就是 false。
   */
  unregister(providerId: string): boolean {
    const index = this.providers.findIndex((item) => item.id === providerId)
    if (index < 0) return false
    this.providers.splice(index, 1)
    return true
  }

  /**
   * 挑一个能处理这个文件的 provider。
   * @param filePath - 要导航的文件。
   * @returns 挑中的 provider；没有合适的（或者文件没有扩展名）就是 undefined。
   */
  providerFor(filePath: string): LspProvider | undefined {
    return selectProvider(this.providers, filePath)
  }

  /**
   * 现在登记了哪些 provider。
   * @returns provider 列表（按登记顺序）。
   */
  listProviders(): readonly LspProvider[] {
    return [...this.providers]
  }

  /**
   * 跳定义。
   * @param filePath - 源文件。
   * @param position - 源文件里的位置（行、列从 0 起）。
   * @returns 目标位置列表（找不到就是空数组）。
   */
  async definition(filePath: string, position: LspSourcePosition): Promise<LspLocation[]> {
    return await this.requireProvider(filePath, 'definition').definition(filePath, position)
  }

  /**
   * 找引用。
   * @param filePath - 源文件。
   * @param position - 源文件里的位置（行、列从 0 起）。
   * @returns 引用位置列表（找不到就是空数组）。
   */
  async references(filePath: string, position: LspSourcePosition): Promise<LspLocation[]> {
    return await this.requireProvider(filePath, 'references').references(filePath, position)
  }

  /**
   * 找实现。
   * @param filePath - 源文件。
   * @param position - 源文件里的位置（行、列从 0 起）。
   * @returns 实现位置列表（找不到就是空数组）。
   */
  async implementations(filePath: string, position: LspSourcePosition): Promise<LspLocation[]> {
    return await this.requireProvider(filePath, 'implementations').implementations(filePath, position)
  }

  /**
   * 读 hover 文档。
   * @param filePath - 源文件。
   * @param position - 源文件里的位置（行、列从 0 起）。
   * @returns 文档文本；没有就是 undefined。
   */
  async hover(filePath: string, position: LspSourcePosition): Promise<LspHover | undefined> {
    return await this.requireProvider(filePath, 'hover').hover(filePath, position)
  }

  /**
   * 把所有 provider 收掉（关进程之类）。
   *
   * 一个 provider 收不干净不该挡住其他的——所以逐个 try，一个失败继续往下走。
   */
  async dispose(): Promise<void> {
    const providers = [...this.providers]
    this.providers.length = 0
    for (const provider of providers) {
      try {
        await provider.dispose?.()
      } catch {
        // 收尾失败不影响其他 provider；调用方只关心「尽力收过了」。
      }
    }
  }

  /**
   * 挑 provider 并检查它支不支持这个操作。
   *
   * 两道关都在这里过：挑不到 provider、或者 provider 不支持这个操作，都变成一句
   * 说得清的失败，而不是把请求原样丢给一台不该问的服务器。
   */
  private requireProvider(filePath: string, operation: LspOperation): LspProvider {
    const provider = this.providerFor(filePath)
    if (provider === undefined) {
      const extension = fileExtension(filePath)
      const subject =
        extension.length === 0 ? '这个文件没有扩展名，没法配语言服务器' : `这个文件类型（${extension}）没有配语言服务器`
      throw new LspError('no-provider', `${subject}，请先给它配一个`)
    }
    if (!provider.capabilities.operations.includes(operation)) {
      throw new LspError('unsupported-operation', `这个语言服务器（${provider.id}）不支持 ${operation} 操作`)
    }
    return provider
  }
}
