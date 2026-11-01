/**
 * 文件绑定：程序能用的四个文件动作。
 *
 * 这四个绑定是**运行时自带**的，不是宿主临时塞进来的——它们背后是文件策略：程序说
 * 「我要读 x」，宿主先判策略，判得过才真的去读。程序在子进程里碰不到 `fs`，所以
 * 「越界就拿不到文件」这件事是由宿主这边保证的，不是靠约定。
 *
 * 绑定名固定为四个：读文本、写文本、列目录、问存在。刻意只给这四个——模型写程序时
 * 需要的是「把文件内容拿进来」与「把结果落下去」，再多的花样留给别的包。
 * @module @ryharness/ptc/bindings
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { PtcBindingError } from './errors.ts'
import { checkPath, type ResolvedFilePolicy } from './policy.ts'
import type { PtcBinding } from './types.ts'
import { messageOf } from './wire.ts'

/** 文件绑定的名字（固定四个）。 */
export const FILE_BINDING_NAMES: readonly string[] = ['readTextFile', 'writeTextFile', 'listDirectory', 'fileExists']

/**
 * 造出这四个文件绑定。
 *
 * @param policy - 解析好的文件策略；每一次读写都按它判。
 * @returns 四个绑定。
 */
export function createFileBindings(policy: ResolvedFilePolicy): PtcBinding[] {
  return [
    {
      name: 'readTextFile',
      description: '读一个文本文件，返回它的内容（字符串）。路径超出允许范围会报错。',
      fn: (args) => {
        const target = resolveAllowed(policy, 'read', args, 0, 'readTextFile')
        try {
          return readFileSync(target, 'utf8')
        } catch (error) {
          throw new PtcBindingError(`读不了这个文件：${target}（${messageOf(error)}）`, 'runtime')
        }
      },
    },
    {
      name: 'writeTextFile',
      description: '写一个文本文件（内容是字符串）。路径超出允许范围会报错。',
      fn: (args) => {
        const target = resolveAllowed(policy, 'write', args, 0, 'writeTextFile')
        const content = args[1]
        if (typeof content !== 'string') {
          throw new PtcBindingError('writeTextFile 第二个参数得是字符串：要写进去的内容。', 'runtime')
        }
        try {
          writeFileSync(target, content, 'utf8')
        } catch (error) {
          throw new PtcBindingError(`写不了这个文件：${target}（${messageOf(error)}）`, 'runtime')
        }
        return `已写入 ${content.length} 个字符`
      },
    },
    {
      name: 'listDirectory',
      description: '列一个目录下的条目名（返回字符串数组）。路径超出允许范围会报错。',
      fn: (args) => {
        const target = resolveAllowed(policy, 'read', args, 0, 'listDirectory')
        try {
          return readdirSync(target)
        } catch (error) {
          throw new PtcBindingError(`列不了这个目录：${target}（${messageOf(error)}）`, 'runtime')
        }
      },
    },
    {
      name: 'fileExists',
      description: '问一个路径存不存在（返回 true / false）。路径超出允许范围会报错。',
      fn: (args) => {
        const target = resolveAllowed(policy, 'read', args, 0, 'fileExists')
        return existsSync(target)
      },
    },
  ]
}

/** 取参数里的路径并按策略判一次。 */
function resolveAllowed(
  policy: ResolvedFilePolicy,
  access: 'read' | 'write',
  args: readonly unknown[],
  index: number,
  bindingName: string,
): string {
  const requested = args[index]
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    throw new PtcBindingError(`${bindingName} 的第一个参数得是文件路径（字符串）。`, 'runtime')
  }
  const decision = checkPath(policy, access, requested)
  if (!decision.allowed || decision.path === undefined) {
    throw new PtcBindingError(decision.reason ?? '路径不在允许的范围里。', 'policy')
  }
  return decision.path
}
