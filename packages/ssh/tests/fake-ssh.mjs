/**
 * 假的 ssh 客户端：把 ssh 该做的事**录下来**，而不是真的连远端。
 *
 * 它是一个真实的进程（管道、退出码、超时都真的会发生），只是它不联网：
 * - 把收到的 argv 与几个关键环境变量写进记录文件（测试据此断言「密码没进 argv」）；
 * - 把 stdin 收到的内容也记下来（文件传输就是走 stdin）；
 * - 按环境变量里给的剧本打印 stdout / stderr，然后按剧本的退出码退出。
 *
 * 剧本（环境变量 `RY_FAKE_SSH_PLAN`，JSON）：
 * ```json
 * { "stdout": "hi", "stderr": "", "exitCode": 0, "delayMs": 0, "echoStdin": false }
 * ```
 * - `echoStdin: true` 时把 stdin 的内容（按 base64 解码）打到 stdout——用来验文件写入。
 * - `delayMs` 大于 0 时先睡一会儿再退出——用来验超时。
 */
import { appendFileSync } from 'node:fs'

/** 读剧本；读不到就按「什么都不做、正常退出」处理。 */
function readPlan() {
  const raw = process.env.RY_FAKE_SSH_PLAN
  if (raw === undefined || raw.length === 0)
    return { stdout: '', stderr: '', exitCode: 0, delayMs: 0, echoStdin: false }
  try {
    const parsed = JSON.parse(raw)
    return {
      stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
      stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : 0,
      delayMs: typeof parsed.delayMs === 'number' ? parsed.delayMs : 0,
      echoStdin: parsed.echoStdin === true,
    }
  } catch {
    return { stdout: '', stderr: '', exitCode: 0, delayMs: 0, echoStdin: false }
  }
}

/** 把 stdin 全部读完（父进程一定会关掉 stdin，所以这里能读完）。 */
async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const plan = readPlan()
const stdin = await readStdin()

const record = {
  args: process.argv.slice(2),
  stdin,
  env: {
    SSH_ASKPASS: process.env.SSH_ASKPASS ?? null,
    SSH_ASKPASS_REQUIRE: process.env.SSH_ASKPASS_REQUIRE ?? null,
    RY_SSH_PASSWORD: process.env.RY_SSH_PASSWORD ?? null,
  },
}

const recordPath = process.env.RY_FAKE_SSH_RECORD
if (recordPath !== undefined && recordPath.length > 0) {
  appendFileSync(recordPath, `${JSON.stringify(record)}\n`, 'utf8')
}

if (plan.echoStdin) {
  const decoded = Buffer.from(stdin.replace(/\s+/g, ''), 'base64')
  process.stdout.write(decoded)
}

if (plan.stdout.length > 0) process.stdout.write(plan.stdout)
if (plan.stderr.length > 0) process.stderr.write(plan.stderr)

if (plan.delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, plan.delayMs))
}

process.exit(plan.exitCode)
