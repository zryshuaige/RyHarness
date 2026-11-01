# `@ryharness/computer-use`

让助理能**看着桌面动手**（截图、点击、打字、按键、滚动）。

这个包给的是「怎么驱动一个桌面」的**接口与流程**：驱动接口、会话管理、安全边界、危险动作清单。

## 它不自带桌面自动化

**这个包里没有原生模块、没有任何操作系统绑定。** 原因：

- 桌面自动化要么靠原生代码，要么靠操作系统自带的自动化接口——两者都不适合塞进包依赖里；
- 真正用得上的场景（远程桌面、无头环境、多屏、虚拟机）又各不相同；
- 上游 dsh 的 `computer-use` 也是同样的选择——它自己只有 2 个源文件、2KB，内容是**接口声明**，真正的后端由用户自己接（上游把它叫 provider）。

所以分工是：**驱动归宿主，契约归包**。宿主接上自己的驱动实现 `ComputerDriver`，这个包负责归属、边界、生命周期、以及**要不要人点头**。

## 装上

```bash
pnpm add @ryharness/computer-use
```

零 workspace 依赖，可以单独装、单独测。

## 用起来

### 1. 接一个驱动

```ts
import type { ComputerDriver } from '@ryharness/computer-use'

const driver: ComputerDriver = {
  name: 'auto',
  async screenshot() { return { bytes, mimeType: 'image/png', width: 1920, height: 1080 } },
  async click(x, y) { /* 点一下 */ },
  async type(text) { /* 打字 */ },
  async key(name) { /* 按键 */ },
  async move(x, y) { /* 移动鼠标 */ },
  async scroll(dx, dy) { /* 滚动 */ },
  async close() { /* 收尾 */ },
}
```

全部按**屏幕坐标**表达——桌面上没有 CSS 选择器，位置就是地址。

### 2. 起一个会话服务，接上确认回调

```ts
import { ComputerSessionService } from '@ryharness/computer-use'

const service = new ComputerSessionService({
  driverFactory: () => createDriver(),
  approver: async (request) => {
    // 把 request.description 原样给用户看：人看到「要在屏幕 (800, 600) 点一下」
    // 才知道自己批的是什么。只给一个「click」是没法判断的。
    return askUser(request.description)
  },
})

const session = await service.open('agent-1')
await service.act('agent-1', session.id, { kind: 'click', x: 800, y: 600 })
```

### 3. 收尾

```ts
await service.disposeAll()
```

## 安全边界

### 桌面上没有天然的安全边界

浏览器里还能靠「只允许 http/https、不去内网」拦一道。桌面上模型说「点 (800, 600)」，**那就是真的在那个位置点一下**——点错地方就点错地方。

所以这个包的重心从「判定能不能做」挪到了「**要不要人点头**」。

### 哪些动作危险

判定标准只有一条：**这个动作会不会改变屏幕上的东西**。

| 动作 | 危险？ | 为什么 |
|---|---|---|
| `click` | 危险 | 按错地方就按错地方——按到「发送」上就发出去了 |
| `type` | 危险 | 打进对话框里就是内容，按下回车就发出去了 |
| `key` | 危险 | `Ctrl+W` 关窗口、`Ctrl+A` 接 `Delete` 清空——破坏力一点不比点击小 |
| `move` | 不危险 | 鼠标移到哪儿都不算「做了什么」 |
| `scroll` | 不危险 | 滚一下不改内容 |

这份清单是导出的常量 `DANGEROUS_COMPUTER_ACTIONS`：宿主要拿它决定「问不问人」，界面要拿它显示「这一步需要你确认」，测试要拿它断言「这些动作被拦住了」。三处各写一份 inevitable 会走偏，所以只留这一份。

### 确认的口径

**宁可什么都不做，也不要自己替用户决定。**

| 情况 | 结果 |
|---|---|
| 动作不危险（`move` / `scroll`） | 直接放行，不打扰人 |
| 高危 + 宿主接了确认回调 + 人点头 | 执行 |
| 高危 + 宿主接了确认回调 + 人拒绝 | 不执行，报 `APPROVAL_REQUIRED` |
| 高危 + 宿主**没接**确认回调 | **不执行**，报 `APPROVAL_REQUIRED` |

最后一行是最要紧的：**没接确认回调 = 全拒绝**，不是默认放行。桌面上点错地方的后果比点错网页严重得多。

### 截图可能含个人信息

屏幕上有什么就截到什么——邮件、聊天记录、密码提示都在里面。截图会进模型上下文，也可能落进日志。

策略里能单独关掉截图：

```ts
new ComputerSessionService({ policy: { allowScreenshot: false } })
```

关掉之后调用方拿到的是**结构化错误** `SCREENSHOT_NOT_ALLOWED`，而不是一张空图。「以为拿到了截图其实是空的」比「明确报错」难查得多。

## 会话

- **owner 隔离**：逐字比对，`"a"`、`"a "`、`"A"` 是三个不同的 owner。不存在的会话与别人的会话对外是同一句「没有这个会话」——不泄露 id 是否存在。
- **有界**：一个 owner 最多 4 个会话。
- **每步超时**：默认 15 秒。超时按结构化错误报回去。
- **用完能收干净**：`close()` 关掉驱动；`disposeAll()` 把所有会话收掉，一个失败不影响别的。

## 没装驱动时的行为

调用会得到结构化错误 `NO_DRIVER`，**不会假装操作成功**。

```ts
import { createUnavailableComputerDriver } from '@ryharness/computer-use'

const driver = createUnavailableComputerDriver()
// driver.click(1, 2) → ComputerUseError { code: 'NO_DRIVER' }
```

理由比浏览器那一族更硬：模型拿到一张「空截图」会以为屏幕是空的，然后开始编造界面上的东西；拿到一个「点击成功」会以为按钮按下去了。

## 公开 API

| 导出 | 一句话 |
|---|---|
| `ComputerSessionService` | 会话服务：owner 隔离、有界、超时、确认闸、结构化失败、收尾 |
| `DANGEROUS_COMPUTER_ACTIONS` | 默认要人点头的动作种类（`click` / `type` / `key`） |
| `isDangerousComputerAction` | 这个动作是不是高危 |
| `describeComputerAction` | 把一次动作说成一句人能看懂的中文 |
| `createUnavailableComputerDriver` | 降级驱动：每个方法都报 `NO_DRIVER` |
| `emptyComputerScreenshot` | 空截图（空字节 + 明确 mime） |
| `ComputerUseError` / `isComputerUseError` | 错误类型与码判定 |

类型：`ComputerDriver`、`ComputerDriverFactory`、`ComputerOwner`、`ComputerAction`、`ComputerActionKind`、`ComputerApprovalRequest`、`ComputerApprover`、`ComputerPolicy`、`ComputerPolicyInput`、`ComputerScreenshot`、`ComputerSessionView`、`ComputerSessionServiceOptions`、`ComputerUseErrorCode`。

## 错误码

`NO_DRIVER`、`NO_SESSION`、`SESSION_CLOSED`、`SESSION_LIMIT`、`TIMEOUT`、`DRIVER_FAILED`、`APPROVAL_REQUIRED`、`INVALID_ARGUMENT`、`SCREENSHOT_NOT_ALLOWED`、`CLEANUP_FAILED`。

码是稳定的，宿主按码分流，不去匹配文案（文案会改，码不会）。

## 测试

```bash
npx vitest run packages/computer-use
```

35 条用例，覆盖：owner 隔离与围栏逐字比对、会话上限、坐标点击/打字/按键默认被拦、人点头才执行、人拒绝不执行、确认请求里带着坐标与一句人话、移动与滚动不打扰人、坐标非法时报 `INVALID_ARGUMENT`、截图被策略关掉时报 `SCREENSHOT_NOT_ALLOWED`、超时、驱动失败、没装驱动如实报错、收尾与关不掉时的 `CLEANUP_FAILED`、降级驱动的每个方法都失败。
