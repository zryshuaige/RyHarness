#!/usr/bin/env node
/**
 * SSH askpass 助手：ssh 要密码时调它，它把环境变量里的密码打到标准输出。
 *
 * **为什么需要它**：ssh 的密码认证默认从终端读密码。密码进 argv 是不行的——argv
 * 在 Linux 上是全局可读的（`ps aux` 就能看见）。所以做法是：
 * - 助手**路径**进 argv（`SSH_ASKPASS`，路径不是秘密）；
 * - 密码进子进程的**环境**（`RY_SSH_PASSWORD`；Linux 上 `/proc/<pid>/environ`
 *   只有属主能读）。
 *
 * 助手本身只做一件事：把环境变量里的密码原样输出。它**不知道**密码是什么，
 * 也不处理多轮提示——`NumberOfPasswordPrompts=1` 已经把提示次数限成一次。
 *
 * @module @ryharness/server/assets/askpass
 */

import { env } from 'node:process'

/** 密码放哪个环境变量。 */
const PASSWORD_ENV = env.RY_SSH_PASSWORD_ENV ?? 'RY_SSH_PASSWORD'

const password = env[PASSWORD_ENV]
if (password === undefined || password.length === 0) {
  // 没有密码就退非零：ssh 会把它当成认证失败，而不是拿着空密码去试一次。
  process.stderr.write(`askpass: 环境变量 ${PASSWORD_ENV} 是空的。\n`)
  process.exit(1)
}

// 密码**只写标准输出**（ssh 从这里读），不写日志、不写 stderr。
process.stdout.write(password)
