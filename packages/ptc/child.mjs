/**
 * PTC 子进程：模型写的程序在这里跑。
 *
 * 为什么单独起一个进程：宿主进程里装着助理的会话、密钥、记忆与别的会话的状态，模型
 * 写的代码没有理由碰到它们。这里起一个干净的 Node 进程，只干一件事——按模式执行程序，
 * 把打印、返回值、失败原因发回宿主。宿主那边再决定这些结果怎么呈现给模型。
 *
 * 这里**也没有**宿主的东西：程序跑在 `node:vm` 造出来的独立上下文里，那个上下文只有
 * 宿主显式放进去的东西（绑定、console）。没有 `process`、没有 `require`、没有 `fs`。
 * 程序想读文件、想调宿主函数，都得通过绑定回宿主那边问一声——文件策略与配额都在
 * 宿主那边执行，程序绕不过去。
 *
 * 协议（宿主 ↔ 子进程）：
 * - 宿主 → 子进程：`{ type: 'run', id, mode, program, bindings }` 与
 *   `{ type: 'callResult', id, ok, value | kind + message }`。
 * - 子进程 → 宿主：`{ type: 'call', id, name, args }`（要调绑定）、
 *   `{ type: 'result', id, output, value }`、`{ type: 'failure', id, output, kind, message, detail }`。
 */
import vm from 'node:vm'

/** 本次执行收集到的打印。 */
let output = []

/** 绑定调用：id → { promise, done, … }。 */
const pendingCalls = new Map()

/** 这一轮里没人接住的绑定失败（程序忘了 await 的那种）。 */
let unhandled = []

/** 绑定调用的自增序号。 */
let callSeq = 0

/** script / repl 模式共用的上下文；保留状态时跨多次执行复用同一个。 */
let context = null

/** 当前上下文里已经放进去的绑定名（新一轮要清掉上一轮多出来的）。 */
let boundNames = []

/** 一个值怎么变成一行字（打印用）。 */
function format(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** 记一行打印。 */
function capture(...args) {
  output.push(args.map((arg) => format(arg)).join(' '))
}

/** 程序看到的 console：写进输出缓冲，不落到子进程自己的 stdout 上。 */
const sandboxConsole = {
  log: (...args) => capture(...args),
  info: (...args) => capture(...args),
  warn: (...args) => capture(...args),
  error: (...args) => capture(...args),
}

/** 回宿主要一个绑定的结果。 */
function callHost(name, args) {
  let wire
  try {
    const json = JSON.stringify(args)
    wire = json === undefined ? [] : JSON.parse(json)
  } catch {
    return Promise.reject(new Error(`传给 ${name} 的参数不能序列化成 JSON`))
  }
  callSeq += 1
  const id = `call-${callSeq}`
  let resolveCall
  let rejectCall
  let resolveDone
  // promise 给程序用（可能 reject）；done 永远 resolve，答复到了就 resolve。
  // 分成两个是为了不惊动 Node 的「没人接住的拒绝」检查——程序忘了 await 时，
  // 那次失败要能被认出来，不能被我们自己 wait 掉。
  const promise = new Promise((resolve, reject) => {
    resolveCall = resolve
    rejectCall = reject
  })
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  pendingCalls.set(id, { promise, done, resolveCall, rejectCall, resolveDone })
  process.send({ type: 'call', id, name, args: wire })
  return promise
}

/** 造一个绑定：程序调用它，就回宿主问一声。 */
function makeBinding(name) {
  return (...args) => callHost(name, args)
}

/** script / repl 模式的上下文：绑定按名放进全局，程序里直接按名用。 */
function ensureContext(names) {
  if (context === null) {
    context = vm.createContext({
      console: sandboxConsole,
      print: (...args) => capture(...args),
    })
  }
  for (const stale of boundNames) {
    if (!names.includes(stale)) delete context[stale]
  }
  for (const name of names) {
    context[name] = makeBinding(name)
  }
  boundNames = names
  return context
}

/** function-body 模式：绑定是函数的唯一参数（一个对象），不放进全局。 */
function runFunctionBody(spec, names) {
  const scope = vm.createContext({
    console: sandboxConsole,
    print: (...args) => capture(...args),
  })
  const fn = vm.runInContext(`(async (bindings) => {\n${spec.program}\n})`, scope, { filename: 'function-body.js' })
  const bindings = {}
  for (const name of names) {
    bindings[name] = makeBinding(name)
  }
  return fn(bindings)
}

/** script 模式：整段脚本跑一次，顶层 await 与 return 都认。 */
function runScript(spec, names) {
  const scope = ensureContext(names)
  const fn = vm.runInContext(`(async () => {\n${spec.program}\n})`, scope, { filename: 'script.js' })
  return fn()
}

/** repl 模式：一条语句，返回它的完成值。 */
function runRepl(spec, names) {
  const scope = ensureContext(names)
  try {
    return vm.runInContext(spec.program, scope, { filename: 'repl.js' })
  } catch (error) {
    // 顶层 await 在 vm 里不认（它不是模块）。这时改用 async 包装再跑一遍：
    // 语句照样执行，状态照样留下，只是完成值拿不到。
    if (errorName(error) === 'SyntaxError' && /await/.test(messageOf(error))) {
      const fn = vm.runInContext(`(async () => {\n${spec.program}\n})`, scope, { filename: 'repl.js' })
      return fn()
    }
    throw error
  }
}

/** 宿主回了一个绑定调用的结果。 */
function settleCall(message) {
  const entry = pendingCalls.get(message.id)
  if (entry === undefined) return
  pendingCalls.delete(message.id)
  entry.resolveDone()
  if (message.ok) {
    entry.resolveCall(message.value)
    return
  }
  const error = new Error(message.message)
  error.ptcKind = message.kind
  entry.rejectCall(error)
}

/**
 * 等所有还在路上的绑定调用有个结果。
 *
 * 程序忘了 await 也不能把事丢掉：写文件这种事，宿主这边已经动手了，这一轮就得等它
 * 落定再收摊。
 */
async function settlePending() {
  for (;;) {
    if (pendingCalls.size === 0) return
    const entries = [...pendingCalls.values()]
    await Promise.all(
      entries.map((entry) => {
        return entry.done
      }),
    )
    if (pendingCalls.size === 0) return
  }
}

/** 错误的类名（跨 realm 时 instanceof 不可靠，只能看 name）。 */
function errorName(error) {
  if (typeof error !== 'object' || error === null) return 'Error'
  return typeof error.name === 'string' ? error.name : 'Error'
}

/** 错误的一句话说明。 */
function messageOf(error) {
  if (typeof error === 'object' && error !== null && typeof error.message === 'string') return error.message
  return String(error)
}

/** 错误的堆栈。 */
function detailOf(error) {
  if (typeof error !== 'object' || error === null) return undefined
  return typeof error.stack === 'string' ? error.stack : undefined
}

/** 失败分类：绑定报上来的分类优先，其次是语法错，最后是运行时错误。 */
function kindOf(error) {
  if (typeof error === 'object' && error !== null && typeof error.ptcKind === 'string') return error.ptcKind
  if (errorName(error) === 'SyntaxError') return 'syntax'
  return 'runtime'
}

/** 返回值能不能过 IPC。 */
function toWire(value) {
  if (value === undefined) return undefined
  const json = JSON.stringify(value)
  if (json === undefined) return undefined
  try {
    return JSON.parse(json)
  } catch {
    throw new Error('程序的返回值不能序列化成 JSON')
  }
}

/** 发消息给宿主。 */
function send(message) {
  if (!process.connected) return
  try {
    process.send(message)
  } catch {
    // 宿主已经收摊了：这边的结果没人要，安静退出即可。
  }
}

/** 跑一次程序。 */
async function handleRun(spec) {
  output = []
  unhandled = []
  const names = Array.isArray(spec.bindings) ? spec.bindings.map((binding) => binding.name) : []
  try {
    let value
    if (spec.mode === 'function-body') {
      value = await runFunctionBody(spec, names)
    } else if (spec.mode === 'repl') {
      value = await runRepl(spec, names)
    } else {
      value = await runScript(spec, names)
    }
    // 程序没 await 的绑定调用也要等它落定：写文件不能因为少写一个 await 就丢掉。
    await settlePending()
    // 再让事件循环转一圈：Node 是在微任务队列清空之后才报「没人接住的拒绝」，
    // 这一拍不给它，程序忘了 await 的那次失败就漏了。
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
    if (unhandled.length > 0) throw unhandled[0]
    send({ type: 'result', id: spec.id, output, value: toWire(value) })
  } catch (error) {
    send({
      type: 'failure',
      id: spec.id,
      output,
      kind: kindOf(error),
      message: messageOf(error),
      detail: detailOf(error),
    })
  }
}

/**
 * 没人接住的拒绝：多半是程序调了绑定却忘了 await。
 *
 * 记下来，由这一轮结束时统一报成失败——不能让子进程自己崩掉，崩了宿主只看得见
 * 「子进程提前退出」，模型读不出是哪一步出的问题。
 */
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason)
})

process.on('message', (message) => {
  if (message === null || typeof message !== 'object') return
  if (message.type === 'run') {
    void handleRun(message)
    return
  }
  if (message.type === 'callResult') {
    settleCall(message)
  }
})
