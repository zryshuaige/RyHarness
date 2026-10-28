# @ryharness/voice

语音合成内核：音色目录 + 云端合成 + 节流。唯一调用方是服务端（`apps/server` 的 `/api/voice/catalog` 与 `/api/voice/speak`）。

## 声线文件：音色写在文件里，不在代码里

目录（`catalog.ts`）里那 20 条是**代码里写死**的清单，改一条要改代码、重新打包。而 Ryen 的猫猫音
是要被反复调的（语速、音高、情绪、换哪个上游说话人），每调一次就重出一次包不现实。

所以一条音色还有第二种形态：**一份 JSON 文件**。

```
<dataDir>/voice/voices/ryen-cat.json
```

```json
{
  "id": "ryen-cat",
  "name": "Ryen 的猫猫音",
  "engine": "minimax",
  "model": "speech-2.6-hd",
  "voice": "Chinese (Mandarin)_Crisp_Girl",
  "speed": 1.05,
  "pitch": 2,
  "vol": 1,
  "emotion": "happy",
  "sampleText": "你好，我是 Ryen。这事我来安排，今天也一起把事情做完吧。",
  "description": "Ryen 专属的猫猫音：清亮少女声，语速轻快、尾音带一点笑意。"
}
```

文件落在数据目录（与 Piper 的 `<dataDir>/voice/piper/` 同一层）而不是代码目录：安装版里代码目录
是只读的 asar，而声线是要被用户改的东西。`apps/server/src/plugins/voice-minimax.ts` 首次启动
时把随装默认的那份写进去，**已存在的不覆盖**——用户改过的声线是他的，不该被升级冲掉。

改完存盘、重启应用就换一种念法。不用打开软件也能用：

```sh
pnpm voice:speak --text "你好，我是 Ryen" --out out.mp3   # 念一句，顺带报 CPU 与内存
pnpm voice:demo                                          # 网页版：输入文字 → 出声 + 看占用
```

解析规则（`src/voice-file.ts`）刻意保守：一个字段不合格就整条作废，而不是「尽力而为」地塞
默认值。一条声线悄悄用上了别人的语速，比根本没有这条声线更难查。越界的旋钮（语速 200、音高
30）算**写坏**，不是「夹到边界」——夹了之后听着还挺正常，而作废会在界面上直接看不见它。

## 三种引擎的分工

| 引擎 | 谁来念 | 目录里的 `voice` 是什么 | 服务端合成 |
| --- | --- | --- | --- |
| `system` | 渲染层的 Web Speech API（`speechSynthesis`） | Windows SAPI 音色名，如 `Microsoft Huihui Desktop` | 回 400 `VOICE_ENGINE_LOCAL`，前端据此降级到本机朗读 |
| `siliconflow` | 服务端转发的 OpenAI 兼容 TTS | `模型:说话人`，如 `FunAudioLLM/CosyVoice2-0.5B:anna` | 正常合成 |
| `minimax` | 服务端转发的 `POST /v1/t2a_v2` | 上游 `voice_id`，如 `Chinese (Mandarin)_Crisp_Girl` | 正常合成 |

本机音色不经服务端是有意的：它不需要凭据、不产生费用、断网也能用，而 `speechSynthesis` 只能在渲染层跑。服务端对它们**明确失败**而不是回一个空音频——前端拿到 `VOICE_ENGINE_LOCAL` 才知道该换条路走。

`minimax` 这条是插件（`voice-minimax`）注册进来的，凭据读的是**同一份** providers 配置
（应用内填的 MiniMax key 与 LLM 走同一条路由）：用户换 key 时对话与朗读一起换。

它有一条必须记住的坑：**HTTP 200 不等于成功**。MiniMax 的业务码在 `base_resp.status_code` 里，
鉴权失败（1004）、余额不足（1008）、参数不对（2013）全是 200 + 非零业务码。只看 HTTP 状态码，
这些会一路走到前端变成「合成成功」的空音频。`src/minimax.ts` 把它们归到各自的机器码（没配 key /
限流 / 上游坏了），前端按 `code` 分支。

## 音色目录是实测出来的

`src/catalog.ts` 里云端那 16 条（2 个模型 × 8 条预置说话人）在 2026-10-17 逐条打过 SiliconFlow 的 `POST /v1/audio/speech`：全部 HTTP 200 + `audio/mpeg`，且逐条音频 SHA-256 两两不同（不是同一音色的别名）。探测失败的写法没有进目录。

两条踩过的坑，写在这里免得再踩：

- **`voice` 必须带模型前缀**。端点只认 `FunAudioLLM/CosyVoice2-0.5B:anna`；直接写 `anna` 回 `{"code":20047,"message":"Invalid voice."}`。所以 `VoiceProfile.voice` 存的是完整的 `模型:说话人`，`model` 字段由 `speakerModel()` 从它推，不另写一份字面量。
- **说话人清单会变**。目录里只有实测通过的那几条；官方文档列了 8 条但没有 API 可枚举，真要加只能先跑一次真实合成验证，再改这个文件。

性别与风格取自 SiliconFlow 官方 TTS 文档（`alex` 沉稳男声 / `anna` 沉稳女声 …），**能否合成**以实测为准，两者不是一回事。

## 动态音色：id 的合法性与「此刻能不能合成」是两件事

插件注册进来的音色（猫猫音、离线 Piper）不在静态目录里，但它们是**合法音色 id**：用户挑过它，
人格里就该留住它。于是内核里分了两处：

- `registerVoiceProfile(profile)`：把条目放进运行时目录（插件卸载时撤掉）。
- `declareVoiceId(id)` / `isKnownVoiceId(id)`：声明 id 本身是合法的（永久的）。

`packages/session` 的 `normalizeVoiceId` 认的是 **id 合不合法**，不是「此刻能不能合成」——拿后者
当判据，会把用户挑过的声音在存盘时悄悄洗成「不朗读」。

## 节流

一次合成是按字符计费的云端往返，而朗读是"点一下就想立刻听到"的交互：连点五下会同时发五个几乎一样的请求，用户听到叠音、账单上五笔。`createVoiceRateLimiter()` 给两道闸——同一音色两次之间至少 `DEFAULT_MIN_INTERVAL_MS`，全局在途不超过 `DEFAULT_MAX_CONCURRENT`。时钟可注入，测试不必真等。

被挡下的那次**不占并发槽，也不推迟这条音色的下次可用时刻**（见 `rate-limit.ts` 里的说明）。

## 用法

```ts
const result = await synthesize(
  { text: '你好，我是 Ryen。', profileId: 'sf-cosyvoice2-anna' },
  { fetchImpl: fetch, apiKey, baseUrl },
)
result.audio // Uint8Array，喂给 <audio> 或存成文件
```

`synthesize` 失败一律抛 `VoiceError`（`code` 取 `VOICE_ERROR_CODES`），不返回"空音频 + 错误标志"——那种形状进了 `<audio>` 只会静默不响。
