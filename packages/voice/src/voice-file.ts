/**
 * 声线文件：磁盘上一行 JSON，决定一条音色到底怎么念。
 *
 * 为什么要有「文件」这一层：音色目录（`catalog.ts`）是代码里写死的清单，改一条音色
 * 要改代码、重新打包、重新出安装包。而 Ryen 的猫猫音是要被反复调的（语速、音高、
 * 情绪、换成哪个上游说话人），每调一次就重出一次包不现实。这里把一条音色拆成一份
 * 可编辑的 JSON：改完存盘，重启就生效。
 *
 * 文件落在 `<dataDir>/voice/voices/*.json`（与 Piper 的 `<dataDir>/voice/piper/`
 * 同一层）：数据目录是「这台机器上的用户数据」，装在哪、删了会怎样，用户心里有数；
 * 而代码目录在安装版里是只读的 asar。
 *
 * 解析刻意保守：一个字段不合格就整条作废（返回 undefined），而不是「尽力而为」地
 * 塞个默认值。一条声线悄悄用上了别人的语速，比根本没有这条声线更难查。
 * @module @ryharness/voice/voice-file
 */

import { declareVoiceId } from './catalog.ts'
import type { VoiceEngineId, VoiceProfile } from './types.ts'

/**
 * 一条声线文件的内容。
 *
 * 字段分三组：身份（`id`/`name`/`description`）、上游取值（`engine`/`model`/`voice`）、
 * 念法（`speed`/`pitch`/`vol`/`emotion`）。后两组都是「上游自己的旋钮」，换个引擎
 * 认识的旋钮可能就换了——所以这里存的是**意图**（语速快一点、音高抬一点），由各引擎
 * 自己去翻译成自己的参数。
 */
export interface VoiceFile {
  /** 目录里的唯一 id（小写字母、数字、连字符）。 */
  id: string
  /** 界面显示名。 */
  name: string
  /** 这条音色跑在哪个引擎上（`system` / `siliconflow` / `minimax` / 插件自带的）。 */
  engine: VoiceEngineId
  /** 上游的 voice 取值：minimax 是 `voice_id`，siliconflow 是 `模型:说话人`。 */
  voice: string
  /** 上游模型 id（minimax 的 `speech-2.6-hd` 之类）。 */
  model?: string
  /** 语速；不写就是上游默认。 */
  speed?: number
  /** 音高；不写就是上游默认。 */
  pitch?: number
  /** 音量；不写就是上游默认。 */
  vol?: number
  /** 情绪标签（上游支持的那几个：happy / calm / sad…）。 */
  emotion?: string
  /** 试听用的固定句子。 */
  sampleText: string
  /** 一句话说明这条音色跑在什么上、适合什么场景。 */
  description: string
}

/** id 允许的形状：目录里的 id 要能当文件名、当 URL 片段、当数据库里的键。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 语速范围（上游 `voice_setting.speed` 的区间，两边都收得住）。 */
const SPEED_RANGE = { min: 0.5, max: 2 } as const
/** 音高范围（上游 `voice_setting.pitch` 的区间，整数级）。 */
const PITCH_RANGE = { min: -12, max: 12 } as const
/** 音量范围（上游 `voice_setting.vol` 的区间）。 */
const VOL_RANGE = { min: 0.1, max: 10 } as const

/** 读一个非空字符串字段；不是字符串或只有空白都当没给。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读一个落在区间里的数字。
 *
 * 越界不是「夹到边界」而是**作废整条**：夹边会让一条写坏的文件看起来能用（比如
 * 语速写成 200，夹成 2 之后听着还挺正常），而作废会在界面上直接看不见它——用户
 * 知道自己该去改文件。
 */
function numberInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

/**
 * 解析一条声线文件。
 *
 * @param raw - 读出来的 JSON（`JSON.parse` 的结果）。
 * @returns 合格的文件；不合格时给 undefined（调用方跳过这一条，不要猜）。
 */
export function parseVoiceFile(raw: unknown): VoiceFile | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = text(record.id)
  if (!ID_PATTERN.test(id)) return undefined
  const name = text(record.name)
  if (name.length === 0) return undefined
  const engine = text(record.engine)
  if (engine.length === 0) return undefined
  const voice = text(record.voice)
  if (voice.length === 0) return undefined
  const sampleText = text(record.sampleText)
  if (sampleText.length === 0) return undefined
  const description = text(record.description)
  if (description.length === 0) return undefined

  const model = text(record.model)
  const emotion = text(record.emotion)
  const speed = record.speed === undefined ? undefined : numberInRange(record.speed, SPEED_RANGE.min, SPEED_RANGE.max)
  const pitch = record.pitch === undefined ? undefined : numberInRange(record.pitch, PITCH_RANGE.min, PITCH_RANGE.max)
  const vol = record.vol === undefined ? undefined : numberInRange(record.vol, VOL_RANGE.min, VOL_RANGE.max)
  // 写了但不合格 = 写坏了：整条作废，而不是当作没写。
  if (record.speed !== undefined && speed === undefined) return undefined
  if (record.pitch !== undefined && pitch === undefined) return undefined
  if (record.vol !== undefined && vol === undefined) return undefined

  return {
    id,
    name,
    engine,
    voice,
    ...(model.length === 0 ? {} : { model }),
    ...(speed === undefined ? {} : { speed }),
    ...(pitch === undefined ? {} : { pitch }),
    ...(vol === undefined ? {} : { vol }),
    ...(emotion.length === 0 ? {} : { emotion }),
    sampleText,
    description,
  }
}

/**
 * 声线文件 → 目录条目。
 *
 * 目录条目是内核里到处在用的形状（引擎、显示名、试听句、说明）；声线文件多出来的那几
 * 个旋钮由各自的引擎自己拿着，不塞进目录条目——目录条目会跟着 `/api/voice/catalog`
 * 发给前端，那些旋钮对界面没用。
 */
export function voiceFileToProfile(file: VoiceFile): VoiceProfile {
  return {
    id: file.id,
    name: file.name,
    engine: file.engine,
    voice: file.voice,
    sampleText: file.sampleText,
    description: file.description,
  }
}

/**
 * Ryen 的猫猫音：默认随装的那一条。
 *
 * 取的是 MiniMax 系统音色里最接近「清亮少女」的 `Chinese (Mandarin)_Crisp_Girl`
 * （官方描述「温暖清脆的少女声音」），再往上抬两度音高、语速快 5%、情绪给 happy，
 * 合成出一点俏皮的猫感。四个旋钮都写在文件里，用户改数字存盘就换一种念法。
 */
export const RYEN_CAT_VOICE: VoiceFile = {
  id: 'ryen-cat',
  name: 'Ryen 的猫猫音',
  engine: 'minimax',
  model: 'speech-2.6-hd',
  voice: 'Chinese (Mandarin)_Crisp_Girl',
  speed: 1.05,
  pitch: 2,
  vol: 1,
  emotion: 'happy',
  sampleText: '你好，我是 Ryen。这事我来安排，今天也一起把事情做完吧。',
  description: 'Ryen 专属的猫猫音：清亮少女声，语速轻快、尾音带一点笑意。',
}

/**
 * 随装默认的声线文件。
 *
 * 插件第一次启动时把它们写进数据目录（已存在的不覆盖——用户改过的声线是他的，不该
 * 被升级冲掉）。写进去之后，**数据目录里那份才是运行时的事实**。
 */
export const DEFAULT_VOICE_FILES: readonly VoiceFile[] = [RYEN_CAT_VOICE]

// 这些 id 在模块加载时就声明为合法音色 id：人格里存着 `ryen-cat` 这件事，不该取决于
// 插件装载的先后顺序（种子数据比插件早一步落库，那时目录里还没有这条音色——
// 不提前声明，它会在归一那一步被洗成「不朗读」）。
for (const file of DEFAULT_VOICE_FILES) declareVoiceId(file.id)
