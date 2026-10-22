# @ryharness/voice

语音合成内核：音色目录 + 云端合成 + 节流。唯一调用方是服务端（`apps/server` 的 `/api/voice/catalog` 与 `/api/voice/speak`）。

## 两种引擎的分工

| 引擎 | 谁来念 | 目录里的 `voice` 是什么 | 服务端合成 |
| --- | --- | --- | --- |
| `system` | 渲染层的 Web Speech API（`speechSynthesis`） | Windows SAPI 音色名，如 `Microsoft Huihui Desktop` | 回 400 `VOICE_ENGINE_LOCAL`，前端据此降级到本机朗读 |
| `siliconflow` | 服务端转发的 OpenAI 兼容 TTS | `模型:说话人`，如 `FunAudioLLM/CosyVoice2-0.5B:anna` | 正常合成 |

本机音色不经服务端是有意的：它不需要凭据、不产生费用、断网也能用，而 `speechSynthesis` 只能在渲染层跑。服务端对它们**明确失败**而不是回一个空音频——前端拿到 `VOICE_ENGINE_LOCAL` 才知道该换条路走。

## 音色目录是实测出来的

`src/catalog.ts` 里云端那 16 条（2 个模型 × 8 条预置说话人）在 2026-10-17 逐条打过 SiliconFlow 的 `POST /v1/audio/speech`：全部 HTTP 200 + `audio/mpeg`，且逐条音频 SHA-256 两两不同（不是同一音色的别名）。探测失败的写法没有进目录。

两条踩过的坑，写在这里免得再踩：

- **`voice` 必须带模型前缀**。端点只认 `FunAudioLLM/CosyVoice2-0.5B:anna`；直接写 `anna` 回 `{"code":20047,"message":"Invalid voice."}`。所以 `VoiceProfile.voice` 存的是完整的 `模型:说话人`，`model` 字段由 `speakerModel()` 从它推，不另写一份字面量。
- **说话人清单会变**。目录里只有实测通过的那几条；官方文档列了 8 条但没有 API 可枚举，真要加只能先跑一次真实合成验证，再改这个文件。

性别与风格取自 SiliconFlow 官方 TTS 文档（`alex` 沉稳男声 / `anna` 沉稳女声 …），**能否合成**以实测为准，两者不是一回事。

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
