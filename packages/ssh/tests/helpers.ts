/**
 * 测试用的假 ssh 后端。
 *
 * 假的不是「假装有接口」，而是**真的起一个进程**（管道、退出码、超时、被杀都真的会发生），
 * 只是它不联网：它把 argv 与关键环境变量记下来，并按剧本输出。这样断言的是**外部可见
 * 的事实**（命令行长什么样、密码在不在 argv 里、退出码对不对），而不是内部实现。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SshSpawnFn } from '../src/index.ts'

/** 假 ssh 脚本的位置。 */
const FAKE_SSH = fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url))

/** 剧本：假 ssh 该演什么。 */
export interface FakeSshPlan {
  /** 打印到 stdout 的内容。 */
  stdout?: string
  /** 打印到 stderr 的内容。 */
  stderr?: string
  /** 退出码。 */
  exitCode?: number
  /** 退出前先睡多久（毫秒）。 */
  delayMs?: number
  /** 是不是把 stdin（按 base64 解码后）打到 stdout。 */
  echoStdin?: boolean
}

/** 假 ssh 记下来的东西。 */
export interface FakeSshRecord {
  /** 它收到的 argv。 */
  args: string[]
  /** 它收到的 stdin。 */
  stdin: string
  /** 几个关键环境变量。 */
  env: {
    SSH_ASKPASS: string | null
    SSH_ASKPASS_REQUIRE: string | null
    RY_SSH_PASSWORD: string | null
  }
}

/** 一个假 ssh 后端。 */
export interface FakeSsh {
  /** 塞给连接用的起进程方式。 */
  readonly spawn: SshSpawnFn
  /** 换剧本（下一次调用生效）。 */
  readonly setPlan: (plan: FakeSshPlan) => void
  /** 读记录（每次调用一条）。 */
  readonly records: () => FakeSshRecord[]
  /** 清掉临时目录。 */
  readonly dispose: () => void
}

/** 造一个假 ssh 后端。 */
export function createFakeSsh(): FakeSsh {
  const dir = mkdtempSync(join(tmpdir(), 'ry-ssh-fake-'))
  const recordPath = join(dir, 'record.jsonl')
  let plan: FakeSshPlan = {}
  const spawnFn: SshSpawnFn = (_command, args, options) =>
    spawn(process.execPath, [FAKE_SSH, ...args], {
      ...options,
      env: {
        ...options.env,
        RY_FAKE_SSH_PLAN: JSON.stringify(plan),
        RY_FAKE_SSH_RECORD: recordPath,
      },
    })
  return {
    spawn: spawnFn,
    setPlan: (next: FakeSshPlan) => {
      plan = next
    },
    records: (): FakeSshRecord[] => {
      let text = ''
      try {
        text = readFileSync(recordPath, 'utf8')
      } catch {
        return []
      }
      return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as FakeSshRecord)
    },
    dispose: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
