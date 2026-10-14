/** Content-block structure helpers. @module @ryagent/llm/content */

import type { FileAttachmentRef, ImageAttachmentRef } from '@ryagent/attachment'
import { assertNever } from '@ryagent/util-values'
import type { Message } from './message.ts'
import type { ContentBlock, RequestMessage, ToolHistory, ToolSchema, ToolUpdate } from './types.ts'

function quoted(value: string): string {
  return JSON.stringify(value)
}

/**
 * Stable text shown to a model that cannot accept one durable image reference.
 * @param ref - durable normalized attachment omitted from the request.
 * @returns deterministic text-only placeholder.
 */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

/**
 * True when typed model content contains an image block. This is the one image
 * walk shared by every image policy (capability gating, text-only
 * serialization, compaction survey), so a consumer cannot silently diverge.
 * @param content - typed model content blocks.
 * @returns whether any block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some((block) => block.type === 'image')
}

/**
 * True when typed model content contains a file block.
 * Reads current content on every call without retaining scan results.
 * @param content - typed model content blocks.
 * @returns whether any block is a file.
 */
export function contentHasFile(content: readonly ContentBlock[]): boolean {
  for (const block of content) {
    if (block.type === 'file') return true
  }
  return false
}

/**
 * Stable model-facing handle for one durable file reference: the address of
 * the verbatim stored copy and the instruction to read it on demand. This is
 * the only representation a provider ever receives for a file.
 * @param ref - durable verbatim file reference.
 * @param readonlyPath - execution-world path of the stored copy, when resolvable.
 * @returns deterministic handle text naming the file, its size, and its address.
 */
export function fileHandleText(ref: FileAttachmentRef, readonlyPath: string | undefined): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  if (readonlyPath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** Replace every file occurrence with handle text. */
function replaceFilesWithHandles(
  blocks: readonly ContentBlock[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'file') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: fileHandleText(block.attachment, resolvePath(block.attachment)) })
      continue
    }
    next?.push(block)
  }
  return next ?? (blocks as ContentBlock[])
}

/**
 * Project request file content into deterministic handle text for every model
 * route. Unlike images, no provider receives file blocks natively, so this
 * projection is unconditional in request assembly.
 * @param messages - complete request history.
 * @param resolvePath - resolve one reference's current execution-world read path.
 * @returns the original list without files, otherwise shallow message copies with handle text.
 */
export function projectFilesToText(
  messages: readonly Message[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly Message[]
/**
 * Project file content in mixed durable and request-only inputs.
 * @param messages - complete request inputs.
 * @param resolvePath - resolve a reference's execution-world read path.
 * @returns original inputs without files, otherwise copies with handle text.
 */
export function projectFilesToText(
  messages: readonly RequestMessage[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly RequestMessage[]
export function projectFilesToText(
  messages: readonly RequestMessage[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly RequestMessage[] {
  if (!messages.some((message) => contentHasFile(message.content))) return messages
  return messages.map((message) => {
    const content = replaceFilesWithHandles(message.content, resolvePath)
    return content === message.content ? message : { ...message, content }
  })
}

/** Replace every image occurrence for a text-only model. */
function replaceImagesForTextModel(blocks: readonly ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: textOnlyImageText(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next ?? (blocks as ContentBlock[])
}

/**
 * Project request image content into deterministic text for an exact text-only model.
 * @param messages - complete request history.
 * @returns the original list without images, otherwise shallow message copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[]
/**
 * Project image content in mixed durable and request-only inputs for a text-only model.
 * @param messages - complete request inputs.
 * @returns original inputs without images, otherwise copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly RequestMessage[]): readonly RequestMessage[]
export function projectImagesForTextModel(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  if (!messages.some((message) => contentHasImage(message.content))) return messages
  return messages.map((message) => {
    const content = replaceImagesForTextModel(message.content)
    return content === message.content ? message : { ...message, content }
  })
}

/** Request messages and tools after one route's tool update projection. */
export interface ProjectedToolUpdates {
  /** History with only the developer updates supported by this route and declaration series. */
  readonly messages: readonly RequestMessage[]
  /** Provider declarations, including deferred and retained definitions when supported. */
  readonly tools: readonly ToolSchema[] | undefined
}

function withoutDeveloperMessages(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  const retained = messages.filter((message) => message.role !== 'developer')
  return retained.length === messages.length ? messages : retained
}

function toolDeclarations(
  tools: readonly ToolSchema[] | undefined,
  mode: ToolUpdate,
  history: ToolHistory,
): Map<string, ToolSchema> {
  const declarations = new Map(history.tools.map((tool) => [tool.name, tool]))
  for (const update of history.updates) {
    for (const tool of update.additions) {
      if (!declarations.has(tool.name)) {
        // Later additions activate these definitions at their recorded position.
        declarations.set(tool.name, { ...tool, deferLoading: true })
      }
    }
  }

  switch (mode) {
    case 'in-history':
      // Removal blocks disable tools without discarding their historical definitions.
      return declarations
    case 'addition-only': {
      // Without removal support, the declaration list must omit inactive tools.
      const activeNames = new Set(tools?.map((tool) => tool.name))
      for (const name of declarations.keys()) {
        if (!activeNames.has(name)) declarations.delete(name)
      }
      return declarations
    }
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(mode)
  }
}

/**
 * Construct provider declarations from session-folded history without changing logged active tools.
 * Unsupported routes and incomplete history use current declarations without developer updates.
 * Explicitly deferred baseline tools become available only after their first retained addition.
 * @param messages - complete request inputs, or the prefix selected for an auxiliary call.
 * @param tools - currently active tool schemas.
 * @param toolUpdate - the resolved route's update mode.
 * @param history - immutable state folded from committed headers and developer messages.
 * @returns provider declarations and the corresponding filtered history.
 */
export function projectToolUpdates(
  messages: readonly RequestMessage[],
  tools: readonly ToolSchema[] | undefined,
  toolUpdate: ToolUpdate | undefined,
  history?: ToolHistory,
): ProjectedToolUpdates {
  if (toolUpdate === undefined) {
    // Unsupported routes need immediately available tools and no update messages.
    let immediateTools = tools
    if (tools?.some((tool) => tool.deferLoading === true)) {
      immediateTools = tools.map(({ deferLoading: _loading, ...tool }) => tool)
    }
    return { messages: withoutDeveloperMessages(messages), tools: immediateTools }
  }

  if (history === undefined) {
    // Current schemas alone cannot resolve definitions referenced by past updates.
    return { messages: withoutDeveloperMessages(messages), tools }
  }
  const messageIds = new Set(messages.flatMap((message) => (message.role === 'developer' ? [message.id] : [])))
  if (history.updates.some((update) => !messageIds.has(update.messageId))) {
    // An auxiliary prefix may omit updates needed to activate historical declarations.
    return { messages: withoutDeveloperMessages(messages), tools }
  }

  const declarations = toolDeclarations(tools, toolUpdate, history)
  const updateIds = new Set(history.updates.map((update) => update.messageId))
  // Deferred baseline tools still need their first addition to become available.
  const offered = new Set(history.tools.filter((tool) => !tool.deferLoading).map((tool) => tool.name))
  const projectedMessages: RequestMessage[] = []
  for (const message of messages) {
    if (message.role !== 'developer') {
      projectedMessages.push(message)
      continue
    }
    // Earlier declaration series do not govern the current tool set.
    if (!updateIds.has(message.id)) continue

    const content = message.content.filter((block) => {
      switch (block.type) {
        case 'tool-addition':
          // Only declared tools that are not already available need activation.
          if (!declarations.has(block.toolName) || offered.has(block.toolName)) return false
          offered.add(block.toolName)
          return true
        case 'tool-removal':
          // Addition-only routes cannot deactivate a tool through history.
          if (toolUpdate !== 'in-history') return false
          return offered.delete(block.toolName)
        default:
          // Other core and plugin-defined blocks retain their content and order.
          return true
      }
    })
    if (content.length === 0) continue
    if (content.length === message.content.length) {
      projectedMessages.push(message)
    } else {
      projectedMessages.push({ ...message, content })
    }
  }

  const unchanged =
    projectedMessages.length === messages.length &&
    projectedMessages.every((message, index) => message === messages[index])
  return {
    messages: unchanged ? messages : projectedMessages,
    tools: [...declarations.values()],
  }
}
