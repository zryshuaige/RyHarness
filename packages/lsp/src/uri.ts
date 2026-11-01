/**
 * 文件路径与 `file://` URI 的互转，外加扩展名归一。
 *
 * 为什么自己写而不是直接用 `pathToFileURL`：语言服务器协议里传的是 URI，不是路径。
 * 这一层的坑全在「谁负责转」上——转错了，服务器看到的就是一个它不认识的文档，
 * 于是回一个空结果，而空结果看起来跟「真的没有定义」一模一样。宁可在这里翻车，
 * 也不要到服务器那边变成一句「没找到」。
 *
 * 顺带一提扩展名的大小写：Windows 上 `.TS` 与 `.ts` 是同一个后缀，但配置里写的
 * 扩展名未必统一大小写，所以这里一律转小写再比。
 * @module @ryharness/lsp/uri
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 取文件扩展名（小写，带点；没有扩展名就是空串）。
 *
 * 「`.gitignore` 这种以点开头的文件」按 Node 的口径没有扩展名，返回空串——
 * 它本来也不是语言文件。
 * @param filePath - 文件路径。
 * @returns 扩展名，例如 `.ts`。
 */
export function fileExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase()
}

/**
 * 把文件路径转成 `file://` URI。
 *
 * 相对路径按当前工作目录解析成绝对路径——语言服务器要的是绝对路径，协议里
 * 传相对路径的服务器行为不统一。
 * @param filePath - 文件路径（相对或绝对）。
 * @returns `file://` URI。
 */
export function pathToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href
}

/**
 * 把 URI 转回文件路径。
 *
 * 转不了就返回 undefined，而不是抛异常：URI 可能是 `untitled:` 这种没有文件
 * 的东西，也可能干脆是乱码。调用方（比如把结果换算成本地路径）自己决定怎么办。
 * @param uri - URI。
 * @returns 文件路径；不是文件 URI 时是 undefined。
 */
export function uriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}
