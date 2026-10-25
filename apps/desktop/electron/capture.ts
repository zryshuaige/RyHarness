/**
 * 截图模式（RYHARNESS_CAPTURE=1 时由 main.ts 调用）：
 * 服务启动后造演示数据、可见窗口加载渲染层、capturePage 存图。
 * （必须用可见窗口：隐藏/offscreen 窗口的 capturePage 会挂起不返回。）
 *
 * 一次拍多张：浅色与暗色各来一遍，且每一遍都拍欢迎页与聊天页。
 *
 * 为什么要有暗色：暗色主题的改动此前**一张实拍都没有**——去棕、位图猫、立绘三件
 * 都是暗色相关，改完只有「代码里写着是暗色」，没有像素证据。评审因此反复点名
 * 「下一轮必须补暗色实拍」。截图是**证据**，不是门禁（截图对环境敏感，不进 CI），
 * 但每轮都必须拍一次并归档。
 *
 * 主题怎么切：渲染层的主题存在 localStorage（'ryharness-theme'），页面挂载前的内联
 * 脚本会读它（renderer/index.html）。所以在页面加载前写好这个键，页面一挂载就是
 * 对应主题——比在页面上模拟点击可靠，也不依赖「点到了那个按钮」。
 *
 * 页面怎么切：点 rail 上的页签（聊天 / 通讯录）。用 executeJavaScript 触发真实
 * 的点击，而不是直接改状态——改状态要碰到 React 内部，跨版本就碎。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import type { RyHarnessServer } from '@ryharness/server'
import type { BrowserWindow } from 'electron'

/**
 * 要拍的几套：主题 × 落盘文件名。
 *
 * 落盘位置在 `apps/desktop/docs/`：那里的 PNG 是入库的正式画面（design-system 的
 * 注释里点名 redesign4-*.png 被 README 引用）。而 `apps/desktop/capture.png` 在
 * .gitignore 里——它是每次跑都变的一次性产物，入库即腐烂。
 */
const SHOTS: { theme: 'light' | 'dark'; file: string }[] = [
  { theme: 'light', file: 'capture.png' },
  { theme: 'dark', file: 'dark-capture.png' },
]

/** 渲染层把主题偏好存在这个键上（见 App.tsx 的 loadTheme）。 */
const THEME_KEY = 'ryharness-theme'

/** 每一套拍完歇一会儿：切主题是一次 View Transition，等它落定再拍。 */
const SETTLE_MS = 1200

/**
 * 按**名字**切到某个 rail 页签。
 *
 * 为什么不写下标：页签会增减（RyVibe 插进聊天下面那一次），硬编码下标当场就错，
 * 而且错出来的图看着还挺正常——「我的」被拍成插件页时，图上没有任何异常可查，
 * 只有对着清单数才发现少了一屏。名字是稳定的，顺序不是。
 */
async function gotoTab(window: BrowserWindow, label: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `(() => {
      const tab = [...document.querySelectorAll('.rail-tab')].find((node) => {
        return (node.textContent ?? '').includes(${JSON.stringify(label)})
      })
      if (!tab) return false
      tab.click()
      return true
    })()`,
  )
  await new Promise((resolve) => {
    return setTimeout(resolve, SETTLE_MS)
  })
}

export async function runCapture(
  server: RyHarnessServer,
  here: string,
  createWindow: () => Promise<BrowserWindow>,
): Promise<void> {
  // 演示数据：Coding Agent + 群 + 两条消息，让三栏都有内容。
  // 消息直接写 store（不走 POST /messages——那会触发 agent turn，
  // 无 mock 适配器时产生 NO_ADAPTER 错误气泡，有 key 时甚至打真实 API）。
  // 走 HTTP 的两发要带 token：桌面端的后端默认是鉴权的。
  const post = async (path: string, payload: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(server.apiToken === undefined ? {} : { authorization: `Bearer ${server.apiToken}` }),
      },
      body: JSON.stringify(payload),
    })
    return (await response.json()) as Record<string, unknown>
  }
  const created = await post('/api/agents', { templateKey: 'coding', name: 'CodeBot', avatar: 'an3d:dog:30' })
  const coder = created.agent as { id: string }
  // 再来两只不同动物的：通讯录那张截图要能一次看到"立体动物"不止一种长相，
  // 评审才看得出这是**一整套**形象，而不是某一张图。
  await post('/api/agents', { templateKey: 'coding', name: '阿狐', avatar: 'an3d:fox:200' })
  await post('/api/agents', { templateKey: 'writing', name: '团子', avatar: 'an3d:panda:30' })
  const conv = await post('/api/conversations', {
    kind: 'group',
    memberAgentIds: ['ryen', coder.id],
    title: '产品三人组',
  })
  const conversation = conv.conversation as { id: string }
  // RYHARNESS_MENTION=1：把演示消息换成带 @提及 的一条，好让「@某人 是不是蓝色链接、
  // 悬停出不出名片」有实拍可查（见 runMentionCardShot）。
  const mentionDemo = process.env.RYHARNESS_MENTION === '1'
  server.store.appendMessage({
    conversationId: conversation.id,
    senderType: 'user',
    contentBlocks: [
      {
        type: 'text',
        text: mentionDemo
          ? '大家好，这是界面截图测试。@Ryen 顺便看下这段，@CodeBot 也来。'
          : '大家好，这是界面截图测试',
      },
    ],
  })
  server.store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '收到喵——我是 Ryen，这是截图模式的演示消息。' }],
    turnIndex: 1,
  })
  /**
   * RyVibe 页的实拍素材：造一次"问到一半"的会话——一道已答、一道待答。
   *
   * 页面挂载时会靠 GET /api/vibe 把上一次找回来，所以这张图拍的是**真实界面**
   * （问答记录 + 盘问卡 + 预选项），不是摆拍。
   *
   * 演示题也按**用户的说法**写：先问"最后要个什么东西"，再问"谁会用"。此前这里
   * 写的是"这东西跑在哪""第一版要几屏"——那是开发者的话，用户根本不会这样回答，
   * 拍出来等于给评审看了一份反例。
   */
  const vibeSession = await server.vibeStore.create({
    conversationId: conversation.id,
    requirement: '给独立开发者做一个记账工具，能分类、能看趋势',
    skillId: 'grill-me',
    memberAgentIds: ['ryen', coder.id],
  })
  const answered = await server.questionStore.ask({
    conversationId: conversation.id,
    agentId: 'ryen',
    question: '你最后想要个什么东西？',
    options: ['一个能打开的小程序', '一份文档', '一张表', '一个以后照着做的流程'],
  })
  await server.questionStore.answer(answered.id, { text: '一个能打开的小程序', selected: ['一个能打开的小程序'] })
  await server.questionStore.ask({
    conversationId: conversation.id,
    agentId: coder.id,
    question: '这东西谁会用？',
    options: ['就我自己', '我们几个人', '客户自己来'],
  })
  await server.vibeStore.setStatus(vibeSession.id, 'asking')
  /**
   * 再落一个项目骨架：让那张 RyVibe 实拍里能同时看到「问答卡 + 项目已落盘 +
   * 任务清单」——这三块正是这一页现在承诺的东西（说一句话 → 点几下 → 拿到一个
   * 能打开的项目）。
   *
   * 这里是截图模式的**演示数据**：真机上这一步由小队调用落盘工具完成，这里直接
   * 调同一个工具，走的是同一段代码路径与同一份存储。
   */
  const scaffold = server.tools.get('vibe_scaffold')
  if (scaffold !== undefined) {
    await scaffold.execute(
      {
        name: '记账工具',
        summary: '给独立开发者做一个记账工具，能分类、能看趋势',
        tasks: ['搭数据表与记账接口', '做收支流水页', '做分类与预算页', '做趋势图'],
      },
      {
        workspaceRoot: server.workspaceRoot,
        conversationId: conversation.id,
        agentId: 'ryen',
      },
    )
    console.log('[capture] project scaffolded')
  }
  console.log('[capture] seed done')

  // 演示数据里给用户一个**立体动物**形象：「我的」页那张定制面板要拍出它长什么样。
  const patch = async (path: string, payload: unknown): Promise<void> => {
    const response = await fetch(`${server.url}${path}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(server.apiToken === undefined ? {} : { authorization: `Bearer ${server.apiToken}` }),
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) console.log('[capture] profile patch failed', response.status)
  }
  await patch('/api/profile', { name: '你', avatar: 'an3d:rabbit:158' })

  /**
   * 「正在敲键盘」那张实拍要用的会话：接一个**永远不回答**的模型服务，
   * 这一轮就会一直挂在处理中，打字行一直亮着——那正是动物在敲键盘的那几秒。
   *
   * 这一段失败**不许**拖垮整个截图流程：它只是额外交付的一张排障图，
   * 而截图一断，docs/ 里的正式画面就停在上一轮。
   */
  const hanging = await startHangingModel()
  try {
    const hangingProvider = await post('/api/providers', {
      displayName: '截图用（不回答）',
      protocol: 'openai',
      baseUrl: hanging.baseUrl,
      models: ['hang'],
      apiKey: 'screenshot',
    })
    const providerId = (hangingProvider.provider as { id: string }).id
    // 把演示里那只柴犬的路由换成那个不回答的服务：不新建助理——新建的那位在
    // 客户端的清单里还没有头像，打字行里会渲染成一块首字母色块。
    await fetch(`${server.url}/api/agents/${coder.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(server.apiToken === undefined ? {} : { authorization: `Bearer ${server.apiToken}` }),
      },
      body: JSON.stringify({ provider: providerId, model: 'hang' }),
    })
    await post('/api/conversations', {
      // 单聊：接口要的是 agentId（不是 memberAgentIds）。
      kind: 'direct',
      agentId: coder.id,
      title: '打字实拍',
    })
  } catch (error) {
    console.warn('[capture] 那个不回答的服务没搭起来：', String(error).slice(0, 200))
  }

  // 落盘目录：docs/ 是入库的正式画面位置，根目录的 capture.png 是 gitignore 掉的
  // 一次性产物。两边都写：前者给评审看，后者给 README 的首屏图。
  const docsDir = join(here, 'docs')
  mkdirSync(docsDir, { recursive: true })

  // createWindow 内部已 await loadFile/loadURL（did-finish-load 已发生），
  // 这里不能再等该事件（监听注册晚于触发会永久挂起），只留渲染 settle 时间。
  const window = await createWindow()
  /**
   * 截图窗口必须**不被完全盖住**。
   *
   * 窗口被别的窗口整个压住时，Chromium 会认为它被遮挡，回收它的合成器表面；
   * 随后 capturePage 抛 UnknownVizError（这台机器上同时开着别的 Electron 窗口，
   * 必踩）。置顶是最省事也最稳的一招：截图期间它一直可见。
   */
  window.setAlwaysOnTop(true)
  window.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message)
  })
  window.webContents.on('did-fail-load', (_e, code, text) => {
    console.log('[capture] fail-load', code, text)
  })
  await new Promise((resolve) => {
    return setTimeout(resolve, 3500)
  })

  // @提及 名片实拍：放在**第一轮**拍。切主题要 reload 一次窗口，reload 之后
  // 合成器有可能被回收掉，capturePage 会抛 UnknownVizError（暗色那轮就撞上过）。
  // 第一次打开窗口时合成器还活着，所以这张要趁早拍。
  if (process.env.RYHARNESS_MENTION === '1') {
    await runMentionCardShot(window, here)
  }

  for (const shot of SHOTS) {
    // 主题存在 localStorage 里；渲染层挂载前的内联脚本会读它，页面一挂载就是对的
    // 主题。改完再重载一次，页面按新主题重画。
    await window.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(THEME_KEY)}, ${JSON.stringify(shot.theme)}); true`,
    )
    await window.webContents.reload()
    await new Promise((resolve) => {
      return setTimeout(resolve, 3500)
    })

    // 聊天页（默认页签）与通讯录页各拍一张：暗色下这两处的差别最大
    // （聊天页有大量气泡与工具行，通讯录页有卡片与头像）。
    const image = await window.webContents.capturePage()
    writeFileSync(join(here, shot.file), image.toPNG())
    writeFileSync(join(docsDir, shot.file), image.toPNG())
    console.log(`[capture] saved ${shot.file}（${shot.theme}）`)

    // 真正有对话的那一屏：气泡、工具行、输入区。
    // 此前 docs 里只有**首页**——这个产品最要紧的一屏（聊起来是什么样）反而没有
    // 像素证据，评审与文档都只能对着首页想象对话长什么样。
    const opened = await window.webContents.executeJavaScript(
      `(() => {
        const item = document.querySelector('.conversation-item-main')
        if (!item) return false
        item.click()
        return true
      })()`,
    )
    if (opened === true) {
      await new Promise((resolve) => {
        return setTimeout(resolve, SETTLE_MS)
      })
      const chatImage = await window.webContents.capturePage()
      const chatFile = shot.file.replace(/\.png$/, '-chat.png')
      writeFileSync(join(here, chatFile), chatImage.toPNG())
      writeFileSync(join(docsDir, chatFile), chatImage.toPNG())
      console.log(`[capture] saved ${chatFile}（${shot.theme}）`)
    }

    // 切到通讯录：按**名字**点页签，不按下标。
    // 下标会随页签增减而错位——RyVibe 插进聊天下面那一次，就把「我的」拍成了插件页，
    // 而图上看不出错（插件页也挺好看的），只有对着清单才发现少了一屏。
    await gotoTab(window, '通讯录')
    const contactsImage = await window.webContents.capturePage()
    const contactsFile = shot.file.replace(/\.png$/, '-contacts.png')
    writeFileSync(join(here, contactsFile), contactsImage.toPNG())
    writeFileSync(join(docsDir, contactsFile), contactsImage.toPNG())
    console.log(`[capture] saved ${contactsFile}（${shot.theme}）`)

    // 切到「我的」页：那张形象定制面板（立体动物 + 毛色 + 花纹）要拍出实图。
    await gotoTab(window, '我的')
    const meImage = await window.webContents.capturePage()
    const meFile = shot.file.replace(/\.png$/, '-me.png')
    writeFileSync(join(here, meFile), meImage.toPNG())
    writeFileSync(join(docsDir, meFile), meImage.toPNG())
    console.log(`[capture] saved ${meFile}（${shot.theme}）`)

    // 模型供应商的「先挑一家」网格：截图模式下没有配 key 的供应商，所以这张图
    // 拍到的就是用户第一次打开设置页看到的那一屏——厂商由他挑，不替他定。
    const hasPicker = await window.webContents.executeJavaScript(
      `(() => {
        const node = document.querySelector('.provider-picker'); if (!node) return false; node.scrollIntoView({block:'start'}); return true })()`,
    )
    if (hasPicker !== true) {
      const diag = await window.webContents.executeJavaScript(
        `(() => ({
          section: document.querySelectorAll('#provider-settings').length,
          picker: document.querySelectorAll('.provider-picker').length,
          tiles: document.querySelectorAll('.provider-pick-tile').length,
          head: (document.querySelector('#provider-settings')?.textContent ?? '').slice(0, 80)
        }))()`,
      )
      console.log('[capture] provider picker 未出现', JSON.stringify(diag))
    }
    if (hasPicker === true) {
      await new Promise((resolve) => {
        return setTimeout(resolve, SETTLE_MS)
      })
      const pickerImage = await window.webContents.capturePage()
      const pickerFile = shot.file.replace(/\.png$/, '-providers.png')
      writeFileSync(join(here, pickerFile), pickerImage.toPNG())
      writeFileSync(join(docsDir, pickerFile), pickerImage.toPNG())
      console.log(`[capture] saved ${pickerFile}（${shot.theme}）`)
    }

    // 插件页：它此前一直没有实拍——一个真实的页面却没有画面，评审与文档都缺一块。
    await gotoTab(window, '插件')
    await new Promise((resolve) => {
      return setTimeout(resolve, SETTLE_MS)
    })
    const pluginsImage = await window.webContents.capturePage()
    const pluginsFile = shot.file.replace(/\.png$/, '-plugins.png')
    writeFileSync(join(here, pluginsFile), pluginsImage.toPNG())
    writeFileSync(join(docsDir, pluginsFile), pluginsImage.toPNG())
    console.log(`[capture] saved ${pluginsFile}（${shot.theme}）`)

    // RyVibe：独立页面的样子（首屏就是一句话 + 一个开始）。
    await gotoTab(window, 'RyVibe')
    const vibeImage = await window.webContents.capturePage()
    const vibeFile = shot.file.replace(/\.png$/, '-vibe.png')
    writeFileSync(join(here, vibeFile), vibeImage.toPNG())
    writeFileSync(join(docsDir, vibeFile), vibeImage.toPNG())
    console.log(`[capture] saved ${vibeFile}（${shot.theme}）`)

    // 项目的落成结果在页面更下面（方案正文之后）：滚到它再拍一张，
    // 否则「项目已落盘 + 任务清单」这两块永远不在任何一张实拍里。
    const hasProject = await window.webContents.executeJavaScript(
      `(() => { const node = document.querySelector('.vibe-project'); if (!node) return false; node.scrollIntoView({block:'start'}); return true })()`,
    )
    if (hasProject === true) {
      await new Promise((resolve) => {
        return setTimeout(resolve, SETTLE_MS)
      })
      const projectImage = await window.webContents.capturePage()
      const projectFile = shot.file.replace(/\.png$/, '-project.png')
      writeFileSync(join(here, projectFile), projectImage.toPNG())
      writeFileSync(join(docsDir, projectFile), projectImage.toPNG())
      console.log(`[capture] saved ${projectFile}（${shot.theme}）`)
    }

    // 切回聊天页，下一轮从聊天页开始拍
    await gotoTab(window, '聊天')
  }

  // 交互巡检：把"鼠标移到头像不同位置""点了哪只动物""选了哪种毛色"这些
  // 中间状态**实拍**下来。截图是证据——上一轮"立体动物"就是靠实拍才发现
  // 兔子的耳朵戳出了圆盘（光看代码不会发现）。
  await runTypingAnimationShot(window, here)
  if (process.env.RYHARNESS_REVIEW === '1') {
    await runInteractionReview(window, here, docsDir)
  }
  if (process.env.RYHARNESS_AUDIT === '1') {
    await runUiAudit(window, here)
  }
  if (process.env.RYHARNESS_NARROW === '1') {
    await runNarrowWindowReview(window, here)
  }

  await window.close()
  // 那个不回答的服务要收掉：它还开着，Electron 就退不出去
  await hanging.close()
}

/**
 * @提及 名片实拍：把指针放到正文里的 @某人 上，拍下浮出来的那张名片。
 *
 * 为什么用 focus 而不是真的移鼠标：名片的开合挂在 onMouseEnter 与 onFocus 两处，
 * 键盘 Tab 到那个链接同样会弹出来（这是有意的——键盘用户也该看得到名片）。
 * 用 focus 触发，拍到的就是同一张卡，还不用去算它在窗口里的坐标。
 *
 * 只落一次性产物（不进 docs/）：这两张是排障用的证据，不是要入库的正式画面。
 */
async function runMentionCardShot(window: BrowserWindow, here: string): Promise<void> {
  // 先点开那个会话：@提及 在聊天页里，欢迎页上没有这条消息。
  await window.webContents.executeJavaScript(
    `(() => { const row = document.querySelector('.conversation-item-main'); if (!row) return false; row.click(); return true })()`,
  )
  await new Promise((resolve) => {
    return setTimeout(resolve, 1200)
  })
  await window.webContents.executeJavaScript(
    `(() => { const link = document.querySelector('.mention-link'); if (!link) return false; link.scrollIntoView({block:'center'}); link.focus(); return true })()`,
  )
  await new Promise((resolve) => {
    return setTimeout(resolve, 900)
  })
  const image = await window.webContents.capturePage()
  writeFileSync(join(here, 'mention-card.png'), image.toPNG())
  console.log('[mention] saved mention-card.png')
}

/**
 * 一个**永远不回答**的本地模型服务。
 *
 * 「正在敲键盘」那几秒是这一轮里最该被看见的——但它只有模型真的在跑的时候才存在。
 * 截图模式没有配 key 的供应商，一发消息就报错，那行字一闪就没了。
 *
 * 这里起一个只收不回的服务：请求发过去就一直挂着，这一轮就一直「在处理中」，
 * 打字行就一直亮着——拍得到真机上动物在敲键盘的样子。
 *
 * @returns baseUrl 与一个收尾函数
 */
function startHangingModel(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createServer((request) => {
    // 收下请求，但不回任何东西——请求就一直挂着
    request.on('data', () => {})
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: async () => {
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          await new Promise<void>((done) => {
            server.close(() => {
              return done()
            })
          })
        },
      })
    })
  })
}

/**
 * 「正在敲键盘」实拍：动物动作帧在真机上跑起来的样子。
 *
 * 静态截图拍不出"在动"——一张图上永远只有一帧。所以这里做两件事：
 *
 * 1. **真的发一条消息**（走输入框那条真实路径，不改状态），等聊天页下方那行
 *    「正在敲键盘」出现——那一位的头像这时正在播打字帧。
 * 2. **连拍两张**（隔一会儿），并把两张图里那行头像区域的像素差异算出来。
 *    差异为 0 就说明它没在动（帧没接上、被 `prefers-reduced-motion` 关了、
 *    或者根本没播帧），截图看着正常也说明不了问题——只有数字能说明。
 *
 * 没有这一行出现（模型没接上、这一轮直接失败）时**只记一条警告**，不硬凑一张图。
 *
 * @param window - 应用窗口
 * @param here - 一次性产物的落盘目录
 */
async function runTypingAnimationShot(window: BrowserWindow, here: string): Promise<void> {
  try {
    await typingAnimationShot(window, here)
  } catch (error) {
    // 这一步只是**额外交付**一张排障图：它失败不许拖垮整个截图流程
    // （截图一断，docs/ 里的正式画面就停在上一轮，verify-shots-fresh 会跟着红）。
    console.warn('[typing] 这张没拍成：', String(error).slice(0, 200))
  }
}

/** 「正在敲键盘」实拍：动物动作帧在真机上跑起来的样子。 */
async function typingAnimationShot(window: BrowserWindow, here: string): Promise<void> {
  // 先点开那个会话（打字行在聊天页里）
  const opened = await window.webContents.executeJavaScript(
    `(() => {
      const item = [...document.querySelectorAll('.conversation-item-main')].find((node) => {
        return (node.textContent ?? '').includes('打字实拍')
      })
      if (!item) return { ok: false, list: [...document.querySelectorAll('.conversation-item-main')].map((node) => (node.textContent ?? '').slice(0, 12)) }
      item.click()
      return { ok: true, list: [] }
    })()`,
  )
  const openedInfo = opened as { ok: boolean; list: string[] }
  if (openedInfo.ok !== true) {
    console.warn('[typing] 列表里没有那个会话：', JSON.stringify(openedInfo.list))
    return
  }
  await new Promise((resolve) => {
    return setTimeout(resolve, 900)
  })
  const sent = await window.webContents.executeJavaScript(
    `(() => {
      const box = document.querySelector('.chat-input-box textarea')
      if (!box) return false
      // React 接管了输入框的值：直接赋值它不会触发 onChange，得走原生 setter。
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(box, '来段测试：看看这位是不是在敲键盘')
      box.dispatchEvent(new Event('input', { bubbles: true }))
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`,
  )
  if (sent !== true) {
    console.warn('[typing] 没找到输入框，跳过')
    return
  }
  // 等那行「正在敲键盘」冒出来
  let shown = false
  for (let i = 0; i < 40 && !shown; i++) {
    await new Promise((resolve) => {
      return setTimeout(resolve, 60)
    })
    shown = await window.webContents.executeJavaScript(
      `(() => document.querySelectorAll('.typing-thinking-avatars .avatar-frames').length > 0)()`,
    )
  }
  if (shown !== true) {
    const diag = await window.webContents.executeJavaScript(
      `(() => ({
        打字行: document.querySelectorAll('.typing-thinking-avatars').length,
        帧: document.querySelectorAll('.typing-thinking-avatars .avatar-frames').length,
        动作: document.querySelectorAll('.typing-thinking-avatars [data-motion]').length,
        气泡: document.querySelectorAll('.bubble-row').length,
        输入框: (document.querySelector('.chat-input-box textarea')?.value ?? '').slice(0, 12),
        内容: (document.querySelector('.typing-thinking-avatars')?.innerHTML ?? '').slice(0, 260),
      }))()`,
    )
    console.warn('[typing] 这一轮没进入「正在敲键盘」状态：', JSON.stringify(diag))
    return
  }
  /**
   * 硬证据：读**浏览器算出来的** transform。
   *
   * 样式表里写了动画不等于浏览器在跑（`prefers-reduced-motion` 会把它关掉；
   * 帧没接上也一样）。同一个元素隔一会儿取两次 transform，取值不同才说明
   * 帧真的在推进——截图看着正常是说明不了问题的，只有数字能说明。
   */
  const readTransform = async (): Promise<{ transform: string; animationName: string } | null> => {
    return (await window.webContents.executeJavaScript(
      `(() => {
        const node = document.querySelector('.typing-thinking-avatars .avatar-frames-sheet')
        if (!node) return null
        const style = getComputedStyle(node)
        return { transform: style.transform, animationName: style.animationName }
      })()`,
    )) as { transform: string; animationName: string } | null
  }
  const before = await readTransform()
  await new Promise((resolve) => {
    return setTimeout(resolve, 220)
  })
  const second = await window.webContents.capturePage()
  const after = await readTransform()
  writeFileSync(join(here, 'typing-animation.png'), second.toPNG())
  if (before === null || after === null) {
    console.warn('[typing] 没找到在播的帧')
    return
  }
  const moved = before.transform !== after.transform
  console.log(
    `[typing] saved typing-animation.png · 动画名 ${after.animationName} · transform ${before.transform} → ${after.transform} · ${moved ? '帧在推进 ✓' : '帧没动 ✗'}`,
  )
}

/**
 * 窄窗实拍：把窗口真的变窄，拍右栏抽屉。
 *
 * 全宽截图看不出窄窗那一档的问题：1200px 以下右栏此前整块 `display:none`——
 * 记忆 / 手册 / 待办 / 调度轨迹一个入口都没有，而内容还在服务端。改成抽屉之后
 * 要拍两张：关着的（聊天区照常，右边那块让出来）与开着的（抽屉盖在上面、
 * 遮罩压暗、聊天区还在底下）。
 *
 * 只落一次性产物（不进 docs/）：这两张是排障用的证据，不是要入库的正式画面。
 */
async function runNarrowWindowReview(window: BrowserWindow, here: string): Promise<void> {
  const shoot = async (name: string): Promise<void> => {
    const image = await window.webContents.capturePage()
    writeFileSync(join(here, name), image.toPNG())
    console.log(`[narrow] saved ${name}`)
  }
  const wait = (ms: number): Promise<void> => {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }
  const bounds = window.getBounds()
  // 1100：低于 1200 那道断点，高于最小窗口宽度（1024）。
  window.setBounds({ ...bounds, width: 1100 })
  await wait(900)
  // 先点开一个会话：抽屉按钮在聊天头部，欢迎页上根本没有这一栏。
  await window.webContents.executeJavaScript(
    `(() => { const row = document.querySelector('.conversation-item-main'); if (!row) return false; row.click(); return true })()`,
  )
  await wait(900)
  const width = await window.webContents.executeJavaScript('window.innerWidth')
  console.log(`[narrow] viewport width = ${String(width)}`)
  await shoot('narrow-window.png')

  await window.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('.panel-drawer-btn'); if (!b) return false; b.click(); return true })()`,
  )
  await wait(600)
  await shoot('narrow-window-panel.png')

  window.setBounds(bounds)
  await wait(400)
}

/**
 * 交互巡检：逐个状态拍下来。
 *
 * 只用 dispatchEvent 模拟指针，不用真鼠标——应用里头像的转头是**脚本驱动**的
 * （写 CSS 变量 + data 属性，不是靠 :hover 伪类），所以事件一到，状态就到位。
 */
async function runInteractionReview(window: BrowserWindow, here: string, docsDir: string): Promise<void> {
  /** 拍一张，落到根目录（一次性产物）与 docs/（入库的正式画面）。 */
  const shoot = async (name: string): Promise<void> => {
    const image = await window.webContents.capturePage()
    writeFileSync(join(here, name), image.toPNG())
    writeFileSync(join(docsDir, name), image.toPNG())
    console.log(`[review] saved ${name}`)
  }

  /** 在页面里执行一段脚本（截图前要等它落定）。 */
  const run = async (code: string): Promise<void> => {
    await window.webContents.executeJavaScript(code)
    await new Promise((resolve) => {
      return setTimeout(resolve, 420)
    })
  }

  /** 移到通讯录页。 */
  const gotoContacts = async (): Promise<void> => {
    await gotoTab(window, '通讯录')
  }

  /**
   * 把指针放到某个头像的横向某个位置（0=最左 0.5=中间 1=最右）。
   *
   * 头像是 3D 壳，指针在它上面移动就会换脸——这里要拍的是换脸后的样子。
   */
  const hoverAt = async (selector: string, ratio: number): Promise<void> => {
    await run(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const x = rect.left + rect.width * ${ratio}
      const y = rect.top + rect.height * 0.5
      node.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
      node.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
      return true
    })()`)
  }

  // 通讯录：同一张卡，指针在左 / 中 / 右各拍一张
  // 选择器要精确到"立体动物"那一种（.avatar-3d[data-view] 只有三视图通道才带
  // 这个属性）：第一张卡可能是品牌橘猫，它没有三张脸，拍了也看不出变化。
  await gotoContacts()
  await hoverAt('.contact-card .avatar-3d[data-view]', 0.06)
  await shoot('review-turn-left.png')
  await hoverAt('.contact-card .avatar-3d[data-view]', 0.94)
  await shoot('review-turn-right.png')
  await hoverAt('.contact-card .avatar-3d[data-view]', 0.5)
  await shoot('review-turn-front.png')
  // 指针移开：应该复位成正面
  await run(`(() => {
    const node = document.querySelector('.contact-card .avatar-3d[data-view]')
    if (!node) return false
    node.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }))
    return true
  })()`)
  await shoot('review-turn-reset.png')

  // 「我的」页：形象定制面板（滚到底，露出动物行与毛色行）
  await gotoTab(window, '我的')
  await run(`(() => {
    const studio = document.querySelector('.animal-studio')
    if (studio) studio.scrollIntoView({ block: 'end' })
    return true
  })()`)
  await shoot('review-studio.png')

  // 换一只动物：点第 3 只（熊）
  await run(`(() => {
    const picks = document.querySelectorAll('.animal-studio-pick')
    if (picks[2]) picks[2].click()
    return true
  })()`)
  await shoot('review-studio-bear.png')

  // 换一种毛色：点第 6 种（天青）
  await run(`(() => {
    const hues = document.querySelectorAll('.animal-studio-hue')
    if (hues[5]) hues[5].click()
    return true
  })()`)
  await shoot('review-studio-hue.png')
}

/**
 * 全页面巡检：把每个界面与每个弹层都拍一遍。
 *
 * 为什么要单独一套：交互问题大多**不在主流程上**——藏在弹层里、折叠区里、空态里、
 * 错误态里。静态截图只能看到主流程，所以这套巡检专门去点开那些"平时看不见"的面。
 *
 * 产物是一次性过程证据（不入库）：apps/desktop/audit-*.png。
 */
async function runUiAudit(window: BrowserWindow, here: string): Promise<void> {
  const shoot = async (name: string): Promise<void> => {
    const image = await window.webContents.capturePage()
    writeFileSync(join(here, name), image.toPNG())
    console.log(`[audit] saved ${name}`)
  }
  const run = async (code: string): Promise<void> => {
    await window.webContents.executeJavaScript(code)
    await new Promise((resolve) => {
      return setTimeout(resolve, 500)
    })
  }
  /** 点一个按钮（按可见文字）。 */
  const clickText = async (text: string): Promise<void> => {
    await run(`(() => {
      const node = [...document.querySelectorAll('button')].find((b) => {
        return (b.textContent ?? '').includes(${JSON.stringify(text)})
      })
      if (!node) return false
      node.click()
      return true
    })()`)
  }
  /**
   * 关掉当前弹层。
   *
   * 弹层是挂在壳上的，不随页签切换消失——此前「建群弹层」拍完没关，后面几张图全被
   * 它盖着，证据看着还挺正常，只是拍的根本不是那一屏。
   */
  const closeModal = async (): Promise<void> => {
    await run(`(() => {
      const close = document.querySelector('.modal-header button')
      if (!close) return false
      close.click()
      return true
    })()`)
  }
  /**
   * 切到某个 rail 页签。
   *
   * 按**名字**切，不按下标：RyVibe 插进聊天下面那一次，页签的顺序就变了，按下标
   * 切出来的图会**看着还挺正常**——「新建助理」那张拍成了 RyVibe 页，「插件」那张
   * 拍成了通讯录页，图上看不出错，只有对着文件名才发现全错位。巡检的全部价值就是
   * 「这些面我点开看过」，图错位了这份证据就不作数。
   */
  const tab = async (label: string): Promise<void> => {
    await gotoTab(window, label)
  }
  /** 把指针放到某个元素的横向某个位置（0=最左 0.5=中间 1=最右）。 */
  const hoverAt = async (selector: string, ratio: number): Promise<void> => {
    await run(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const x = rect.left + rect.width * ${ratio}
      const y = rect.top + rect.height * 0.5
      node.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
      node.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
      return true
    })()`)
  }

  await tab('聊天')
  await shoot('audit-chat.png')
  await tab('通讯录')
  await shoot('audit-contacts.png')
  // 新建 Agent 弹层
  await clickText('新建 Agent')
  await shoot('audit-create-agent.png')
  // 展开高级设置
  await clickText('高级设置')
  await shoot('audit-create-agent-advanced.png')
  // 滚到性格区
  await run(`(() => {
    const node = document.querySelector('.persona-fields')
    if (node) node.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await shoot('audit-create-agent-persona.png')
  // 关掉
  await closeModal()
  await tab('我的')
  await shoot('audit-me.png')
  /**
   * 动效到底有没有**真的跑起来**：类名在不算数——样式表里那条规则挂错了地方，
   * 类名照样在、动画照样不动（"正在说"那张脸就一直是这么哑的）。得看浏览器
   * 算出来的 animation-name 是不是真的那条。
   */
  const running = await window.webContents.executeJavaScript(
    `(() => [...document.querySelectorAll('[data-motion]')].map((node) => {
      const style = getComputedStyle(node)
      return { cls: node.className, action: node.getAttribute('data-motion'), name: style.animationName, dur: style.animationDuration }
    }).filter((row) => row.name && row.name !== 'none'))()`,
  )
  console.log(`[audit] 头像动效 = ${JSON.stringify(running)}`)
  // 把指针停在「我的形象」的大预览上：应当抬起爪子打招呼。
  await hoverAt('.animal-studio-preview .avatar-3d', 0.5)
  await shoot('audit-me-wave.png')
  await tab('插件')
  await shoot('audit-plugins.png')
  // 建群弹层
  await tab('通讯录')
  await clickText('建群')
  await shoot('audit-create-group.png')
  await closeModal()
  // RyVibe 页：盘问卡与小队面板
  await tab('RyVibe')
  await shoot('audit-vibe.png')

  /**
   * 下面这些是**平时看不见的面**：浮层、菜单、抽屉。
   *
   * 主流程的截图只能看到主流程——而交互问题大多藏在这里：会话项的「⋯」菜单、
   * 输入框里的「/」命令面板、右栏收成窄边再展开的样子。这一组专门去点开它们。
   */
  await tab('聊天')
  // 会话项的「⋯」菜单：置顶/静音/删除/分支都在这一层。
  await run(`(() => {
    const more = document.querySelector('.conversation-more')
    if (!more) return false
    more.click()
    return true
  })()`)
  await shoot('audit-conversation-menu.png')
  // 关掉菜单（Esc 归它自己：外面点一下关不掉，得用键盘路径）
  await run(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  // 输入框里的「/」命令面板
  await run(`(() => {
    const box = document.querySelector('.chat-input-box textarea')
    if (!box) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(box, '/')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await shoot('audit-command-palette.png')
  // 清掉输入，免得这一轮的图带着半截命令
  await run(`(() => {
    const box = document.querySelector('.chat-input-box textarea')
    if (!box) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(box, '')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  // 右栏：收成窄边（44px）再展开——窄栏是抽屉形态，得单独看一眼
  await run(`(() => {
    const toggle = document.querySelector('.right-panel-toggle')
    if (!toggle) return false
    toggle.click()
    return true
  })()`)
  await shoot('audit-right-panel.png')
  // 点开一条会话，进到真正的聊天页（欢迎页里看不到气泡与输入区）
  await run(`(() => {
    const item = document.querySelector('.conversation-item-main')
    if (!item) return false
    item.click()
    return true
  })()`)
  await shoot('audit-chat-conversation.png')
  /**
   * 壳的几栏各占多宽。
   *
   * 截图上右边空着一条（宽屏下尤其显眼），得先量出来：那一片到底是"右栏收起了"
   * 还是"壳没铺满窗口"——两者的修法完全不同。
   */
  const columns = await window.webContents.executeJavaScript(
    `(() => {
      const shell = document.querySelector('.app-shell')
      if (!shell) return null
      const panel = document.querySelector('.right-panel')
      const panelStyle = panel ? getComputedStyle(panel) : null
      return {
        inner: window.innerWidth,
        outer: window.outerWidth,
        dpr: window.devicePixelRatio,
        matches1199: window.matchMedia('(max-width: 1199px)').matches,
        panel: panelStyle ? { position: panelStyle.position, width: panelStyle.width } : null,
        columns: [...shell.children].map((child) => {
          const rect = child.getBoundingClientRect()
          return { cls: child.className, w: Math.round(rect.width), position: getComputedStyle(child).position }
        }),
      }
    })()`,
  )
  console.log(`[audit] 壳的各栏 = ${JSON.stringify(columns)}`)
}
