// 真实 E2E 驱动：CDP eval 辅助。用法见各 bash 调用。
import WebSocket from 'ws'
const action = process.argv[2]
const arg = process.argv[3]
const targets = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = targets.find((t) => t.type === 'page')
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
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
})
ws.on('open', async () => {
  const api = new URL(await evaluate('new URLSearchParams(location.search).get("api")'))
  const base = api.origin

  if (action === 'setup') {
    // 建单聊 + 群（经页面内 fetch，带同源 api 地址）
    const dm = await evaluate(`fetch('${base}/api/conversations', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'direct',agentId:'ryen'})}).then(r=>r.json())`)
    const grp = await evaluate(`fetch('${base}/api/conversations', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'group',memberAgentIds:['ryen','codebot','owl'],dispatcherAgentId:'ryen',title:'真实验证群'})}).then(r=>r.json())`)
    console.log(JSON.stringify({ dm: dm.conversation.id, group: grp.conversation.id }))
  }

  if (action === 'send') {
    // arg = "conversationId|文本"：UI 输入发送
    const [cid, text] = arg.split('|')
    await evaluate(`(function(){
      const items = document.querySelectorAll('.conversation-item')
      items.forEach(function(i){ if(i.textContent.includes('${cid === 'DM' ? 'Ryen' : '真实验证群'}')) i.click() })
    })()`)
    await new Promise((r) => setTimeout(r, 900))
    await cmd('Runtime.evaluate', { expression: `document.querySelector('.chat-input-box textarea').focus()` })
    await cmd('Input.insertText', { text })
    await new Promise((r) => setTimeout(r, 300))
    await evaluate(`Array.from(document.querySelectorAll('.send-btn')).forEach(function(b){b.click()})`)
    console.log('sent')
  }

  if (action === 'wait-done') {
    // 等待 message-done 计数达到 arg 或超时 90s
    const target = Number(arg)
    const t0 = Date.now()
    while (Date.now() - t0 < 90_000) {
      const done = await evaluate(`document.querySelectorAll('.bubble-row[data-sender="ryen"], .bubble-row[data-sender="codebot"], .bubble-row[data-sender="owl"]').length`)
      const typing = await evaluate(`!!document.querySelector('.typing-indicator')`)
      if (Number(done) >= target && !typing) { console.log('settled, agent messages =', done); process.exit(0) }
      await new Promise((r) => setTimeout(r, 1500))
    }
    console.log('timeout, agent messages =', await evaluate(`document.querySelectorAll('.bubble-row[data-sender]`))
  }

  if (action === 'text') {
    console.log(JSON.stringify(await evaluate(`(document.querySelector('.chat-col')||document.body).innerText.slice(0, ${Number(arg) || 800})`)))
  }

  if (action === 'shot') {
    const { writeFileSync } = await import('node:fs')
    const shot = await cmd('Page.captureScreenshot', { format: 'png' })
    writeFileSync(arg, Buffer.from(shot.data, 'base64'))
    console.log('saved', arg)
  }

  if (action === 'thumbs-down') {
    await evaluate(`(function(){var b=document.querySelectorAll('.bubble-actions button');if(b.length)b[b.length-1].click();})()`)
    console.log('clicked thumbs-down')
  }
  process.exit(0)
})
setTimeout(() => { console.log('driver timeout'); process.exit(1) }, 120_000)
