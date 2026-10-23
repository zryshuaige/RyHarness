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
  /** 切到第 n 个 rail 页签。 */
  const tab = async (index: number): Promise<void> => {
    await run(`(() => {
      const tabs = document.querySelectorAll('.rail-tab')
      if (tabs[${index}]) tabs[${index}].click()
      return true
    })()`)
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

  await tab(0)
  await shoot('audit-chat.png')
  await tab(1)
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
  await run(`(() => {
    const node = document.querySelector('.modal-actions button')
    if (node) node.click()
    return true
  })()`)
  await tab(3)
  await shoot('audit-me.png')
  // 把指针停在「我的形象」的大预览上：应当抬起爪子打招呼。
  await hoverAt('.animal-studio-preview .avatar-3d', 0.5)
  await shoot('audit-me-wave.png')
  await tab(2)
  await shoot('audit-plugins.png')
  // 建群弹层
  await tab(1)
  await clickText('建群')
  await shoot('audit-create-group.png')
}
