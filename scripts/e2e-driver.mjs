// 真实 E2E 驱动：通过 CDP（Chrome DevTools Protocol）操作已启动的桌面应用页面。
//
// 前置条件：
//   1. 以远程调试端口启动应用，例如：
//        RYHARNESS_DEV_SERVER_URL=http://localhost:5173 electron . --remote-debugging-port=9333
//      （端口 9333 在本文件内硬编码，改动需同步）
//   2. 依赖根 devDependency `ws`（CDP WebSocket 客户端）。
//
// 用法：node scripts/e2e-driver.mjs <action> [arg]
//   setup                  建单聊 + 群，输出 { dm, group } 会话 id
//   send "DM|文本"          在 UI 中选中会话并发送消息（DM=单聊，否则选"真实验证群"）
//   wait-done <N>          等待 agent 气泡数达到 N 且无输入中指示（超时 90s）
//   text [N]               输出聊天区前 N 个字符（默认 800）
//   shot <path.png>        截屏保存
//   thumbs-down            点击最后一条消息的点踩按钮
import WebSocket from 'ws'

const action = process.argv[2]
const arg = process.argv[3]
const targets = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = targets.find((t) => t.type === 'page')
if (page === undefined) {
  console.error('未找到可驱动的 page target：请先带 --remote-debugging-port=9333 启动应用并加载页面')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
function cmd(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r?.result?.value
}
ws.on('message', (d) => {
  const m = JSON.parse(String(d))
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
})
ws.on('open', async () => {
  // 开发模式 API 地址在 ?api= 查询串；生产模式（loadFile）主进程把地址写进
  // window.__RYHARNESS_API_BASE__（见 electron/main.ts 的注入段）。两种都要能驱动。
  const apiRaw = await evaluate(
    'new URLSearchParams(location.search).get("api") ?? window.__RYHARNESS_API_BASE__ ?? null',
  )
  if (typeof apiRaw !== 'string' || apiRaw.length === 0) {
    console.error('拿不到 API 地址：既无 ?api= 查询串也无 window.__RYHARNESS_API_BASE__')
    process.exit(1)
  }
  const api = new URL(apiRaw)
  const base = api.origin

  if (action === 'setup') {
    // 成员 id 从 /api/agents 现取：内置助理的 id 是 seed 出来的（ryen / ryen-team-*），
    // 早先这里硬编码的 codebot / owl 在任何真实数据目录里都不存在，建群必然 400。
    const members = await evaluate(
      `fetch('${base}/api/agents', {headers:{'authorization':'Bearer '+window.__RYHARNESS_API_TOKEN__}}).then(r=>r.json()).then(j=>j.agents.map(a=>a.id))`,
    )
    const memberIds = Array.isArray(members) ? members.slice(0, 3) : []
    if (memberIds.length < 2) {
      console.error(`可用助理不足 2 个，建不了群：${JSON.stringify(members)}`)
      process.exit(1)
    }
    const auth = `'authorization':'Bearer '+window.__RYHARNESS_API_TOKEN__`
    const dm = await evaluate(
      `fetch('${base}/api/conversations', {method:'POST',headers:{'content-type':'application/json',${auth}},body:JSON.stringify({kind:'direct',agentId:'${memberIds[0]}'})}).then(r=>r.json())`,
    )
    const grp = await evaluate(
      `fetch('${base}/api/conversations', {method:'POST',headers:{'content-type':'application/json',${auth}},body:JSON.stringify({kind:'group',memberAgentIds:${JSON.stringify(memberIds)},dispatcherAgentId:'${memberIds[0]}',title:'真实验证群'})}).then(r=>r.json())`,
    )
    console.log(
      JSON.stringify({
        dm: dm.conversation?.id,
        group: grp.conversation?.id,
        members: memberIds,
        dmError: dm.error,
        grpError: grp.error,
      }),
    )
  }

  if (action === 'reload') {
    await cmd('Page.enable')
    await cmd('Page.reload', { ignoreCache: true })
    console.log('reloaded')
  }

  if (action === 'send') {
    // arg = "conversationId|文本"：UI 输入发送
    const [cid, text] = arg.split('|')
    // 点可点的那一层：外层 .conversation-item 只是容器，事件挂在 .conversation-item-main 上，
    // 点容器不会切换会话（消息会静默发进上一个会话——这坑真实踩过一次）。
    await evaluate(`(function(){
      const items = document.querySelectorAll('.conversation-item')
      items.forEach(function(i){
        if (!i.textContent.includes('${cid === 'DM' ? 'Ryen' : '真实验证群'}')) return
        const main = i.querySelector('.conversation-item-main') || i
        main.click()
      })
    })()`)
    await new Promise((r) => setTimeout(r, 900))
    // 必须核对当前会话真的切过去了：会话项列表是异步刷新的，刚建完群时那一项可能
    // 还没渲染，点了个寂寞——消息会静默落进上一个会话（曾因此把群聊测试跑成了单聊，
    // 白等两轮模型）。核对不过就报错退出，不要发出一条错位的消息。
    const header = await evaluate(
      `(document.querySelector('.chat-header') || document.querySelector('.chat-col') || document.body).textContent || ''`,
    )
    const expectTitle = cid === 'DM' ? 'Ryen' : '真实验证群'
    if (!String(header).includes(expectTitle)) {
      console.error(`没切到「${expectTitle}」会话（当前头部：${String(header).slice(0, 60)}），放弃发送`)
      process.exit(2)
    }
    await cmd('Runtime.evaluate', { expression: `document.querySelector('.chat-input-box textarea').focus()` })
    await cmd('Input.insertText', { text })
    await new Promise((r) => setTimeout(r, 300))
    await evaluate(`Array.from(document.querySelectorAll('.send-btn')).forEach(function(b){b.click()})`)
    console.log('sent')
  }

  if (action === 'eval') {
    // 通用读页面状态：导航点按、插件区/开关态这类一次性核对不必每次改驱动。
    console.log(JSON.stringify(await evaluate(arg)))
  }

  if (action === 'wait-done') {
    // 等待 message-done 计数达到 arg 或超时 90s
    const target = Number(arg)
    const t0 = Date.now()
    while (Date.now() - t0 < 90_000) {
      const done = await evaluate(
        `document.querySelectorAll('.bubble-row[data-sender]:not([data-sender="user"]):not([data-sender="system"])').length`,
      )
      const typing = await evaluate(`!!document.querySelector('.typing-indicator')`)
      if (Number(done) >= target && !typing) {
        console.log('settled, agent messages =', done)
        process.exit(0)
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    console.log(
      'timeout, agent messages =',
      await evaluate(`document.querySelectorAll('.bubble-row[data-sender]').length`),
    )
  }

  if (action === 'text') {
    console.log(
      JSON.stringify(
        await evaluate(
          `(document.querySelector('.chat-col')||document.body).innerText.slice(0, ${Number(arg) || 800})`,
        ),
      ),
    )
  }

  if (action === 'shot') {
    const { writeFileSync } = await import('node:fs')
    const shot = await cmd('Page.captureScreenshot', { format: 'png' })
    writeFileSync(arg, Buffer.from(shot.data, 'base64'))
    console.log('saved', arg)
  }

  if (action === 'thumbs-down') {
    await evaluate(
      `(function(){var b=document.querySelectorAll('.bubble-actions button');if(b.length)b[b.length-1].click();})()`,
    )
    console.log('clicked thumbs-down')
  }
  process.exit(0)
})
setTimeout(() => {
  console.log('driver timeout')
  process.exit(1)
}, 120_000)
