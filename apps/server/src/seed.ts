/**
 * 内置 Agent 模板目录（产品层；区别于 @ryharness/agent 的运行时内置 Ryen）。
 * POST /api/agents 可用 templateKey 从模板实例化。
 * @module @ryharness/server/seed
 */

import { randomUUID } from 'node:crypto'
import type { AgentDefinition } from '@ryharness/agent'
import { RYEN_TEMPLATE } from '@ryharness/agent'
import type { AgentPersona, SessionStore } from '@ryharness/session'
import { normalizePersona } from '@ryharness/session'

/**
 * Ryen 换声线之前用的那条音色（CosyVoice2 的温柔女声）。
 *
 * 留着它是为了迁移：存量安装里 Ryen 的人格还指着这个 id，而它已经不是"默认"了。
 */
const LEGACY_RYEN_VOICE_ID = 'sf-cosyvoice2-claire'

/** Ryen 现在的声线 id（对应声线文件 `ryen-cat.json`）。 */
const RYEN_CAT_VOICE_ID = 'ryen-cat'

/**
 * 把内置 Ryen 的旧默认音色换成猫猫音。
 *
 * 只在它**还停在旧默认**时才动：用户手动挑过的音色是他的选择，模板升级不该替他改
 * 回去。判据是音色 id 本身——除了 Ryen，别的内置助理没用过这个 id。
 *
 * 种子只补"库里没有的"那条（见 {@link ensureSeedAgents}），所以存量安装不迁移的话，
 * Ryen 会一直用旧音色——"以后每次软件里都复用这个声音"这句就落空了一半。
 * @param store - 会话存储（改的是 agents 表）。
 * @returns 换了音色的助理名；没换时是 undefined。
 */
export function migrateBuiltinVoice(store: SessionStore): string | undefined {
  const agent = store.getAgent(RYEN_TEMPLATE.id)
  if (agent === undefined) return undefined
  if (agent.persona.voiceId !== LEGACY_RYEN_VOICE_ID) return undefined
  store.upsertAgent({
    id: agent.id,
    name: agent.name,
    ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
    systemPrompt: agent.systemPrompt,
    provider: agent.provider,
    model: agent.model,
    ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }),
    ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }),
    tools: [...agent.tools],
    persona: { ...agent.persona, voiceId: RYEN_CAT_VOICE_ID },
    isBuiltin: true,
    ...(agent.routeLocked === undefined ? {} : { routeLocked: agent.routeLocked }),
  })
  return agent.name
}

/**
 * 给内置助理补上「找得到、改得动」那三个工具（fs_glob / fs_grep / fs_edit）。
 *
 * 种子只补「库里没有的」那条（见 {@link ensureSeedAgents}），所以存量安装里已经
 * 建好的 Ryen 与小队成员不会自动拿到新工具——升级后助理还是既问不出文件在哪，
 * 也改不动别的段落。
 *
 * 判据是**工具白名单是否还等于旧默认值**：用户自己勾过别的工具，那份清单就与
 * 旧默认值不同，我们不动它（用户的选择是他的）；完全等于旧默认值的，说明用户
 * 没动过，补上新工具不违背任何意愿。
 * @param store - 会话存储（改的是 agents 表）。
 * @returns 改了工具的助理名（多个时用、分隔）；没改时是 undefined。
 */
export function migrateBuiltinTools(store: SessionStore): string | undefined {
  const changed: string[] = []
  for (const agent of store.listAgents()) {
    if (!agent.isBuiltin) continue
    const addition = toolsToAdd(agent.id, agent.tools)
    if (addition.length === 0) continue
    store.upsertAgent({
      id: agent.id,
      name: agent.name,
      ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
      systemPrompt: agent.systemPrompt,
      provider: agent.provider,
      model: agent.model,
      ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }),
      ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }),
      tools: [...agent.tools, ...addition],
      persona: { ...agent.persona },
      isBuiltin: true,
      ...(agent.routeLocked === undefined ? {} : { routeLocked: agent.routeLocked }),
    })
    changed.push(agent.name)
  }
  return changed.length === 0 ? undefined : changed.join('、')
}

/**
 * 这个内置助理要补哪些工具：它的白名单还等于旧默认值时，补该角色的新工具。
 *
 * 旧默认值按角色记在这里，而不是从模板反推——模板已经改成新值了，反推只会拿到
 * 「已经补过的」那一份，存量用户反而拿不到。
 */
function toolsToAdd(agentId: string, current: readonly string[]): string[] {
  const old = LEGACY_DEFAULT_TOOLS[agentId]
  if (old === undefined) return []
  const same =
    old.length === current.length &&
    old.every((tool, index) => {
      return tool === current[index]
    })
  if (!same) return []
  return [...(NEW_FILE_TOOLS_BY_AGENT[agentId] ?? [])]
}

/** 升级前每个内置助理的默认工具白名单（判据用）。 */
const LEGACY_DEFAULT_TOOLS: Record<string, readonly string[]> = {
  ryen: ['fs_read', 'fs_write', 'file_produce', 'todo'],
  engineer: ['fs_read', 'fs_write', 'file_produce'],
  organizer: ['fs_read', 'fs_write', 'todo'],
}

/** 各内置助理要补的新工具。 */
const NEW_FILE_TOOLS_BY_AGENT: Record<string, readonly string[]> = {
  ryen: ['fs_glob', 'fs_grep', 'fs_edit'],
  engineer: ['fs_glob', 'fs_grep', 'fs_edit'],
  organizer: ['fs_glob', 'fs_grep'],
}

/** 一个可实例化的 agent 模板。 */
export interface AgentTemplate {
  key: string
  name: string
  description: string
  suggestedSystemPrompt: string
  defaultTools: string[]
  defaultModel: string
  avatar?: string
  /** 模板自带的性格（性格四维 / 生日 / 口头禅 / 形象 / 音色）。 */
  persona: AgentPersona
}

/**
 * 全部内置模板。
 *
 * 命名与 prompt 统一走「名字先说职能，人设再说像什么」：模板卡、通讯录和会话列表
 * 里留给用户看的只有一行摘要，没人点开系统提示，「阿码」这种拟声拟形的双字昵称在
 * 那里读不出它是干什么的。于是名字直接用职能——工程师 / 文案 / 翻译 / 管家，
 * 对标「产品经理」「算法设计师」这种一眼可辨的角色名；动物气质不丢，交给
 * description、persona.appearance 与口头禅承担。
 *
 * description 是唯一自解释的一行定位，写法固定为 `<定位>：<人设一句话>`，
 * 只看这一行就该知道这位助理干什么（Ryen 是品牌名不是职能名，定位由它带「总管」）。
 * systemPrompt 用同样的口吻写成：职责说清，边界说清，写法示例而非命令清单。
 *
 * 这些名字只是模板默认值：只影响新建助理与首启种子，用户库里已有的助理不改名、
 * 不迁移。avatar 是固定语义值（与 persona.appearance 的动物同名，见
 * apps/desktop/renderer/src/lib/brand-portraits.ts）：有立绘素材的助理用真立绘，
 * 素材还没画出来的用剪影占位，不拿 DiceBear funEmoji 族冒充——那一族的 seed 只是
 * 随机哈希，出的是彩色笑脸，跟「猫头鹰」「水獭」这类人设对不上。
 *
 * 默认工具一律**不含 shell_exec**：能执行任意命令是最高一档的能力，不该在用户
 * 还没意识到「这只小动物能在我的电脑上敲命令」时就默认打开（提示注入可直接
 * 升级成任意代码执行）。要用就在 agent 编辑里显式勾选。
 *
 * 人格（{@link AgentTemplate.persona}）逐个模板手写，且互相不重叠：性格四维、
 * 生日、口头禅、形象、音色各自不同。模板之间"同一段话改几个字"会让五个助理
 * 说话像一个人——那正是人格系统要消掉的东西。
 */
export const AGENT_TEMPLATES: Readonly<Record<string, AgentTemplate>> = {
  general: {
    key: 'general',
    name: 'Ryen',
    description: 'Ryen：总管，橘色虎斑猫，温暖干练，日常问答与事务安排默认由它接手。',
    suggestedSystemPrompt: RYEN_TEMPLATE.systemPrompt,
    defaultTools: ['fs_read', 'fs_write', 'fs_glob', 'fs_grep', 'fs_edit', 'file_produce', 'todo'],
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
    avatar: 'cat',
    persona: {
      extroversion: 72,
      rigor: 78,
      humor: 45,
      initiative: 85,
      birthday: '03-14',
      catchphrase: '这事我来安排。',
      affinity: 10,
      // Ryen 是那只橘猫，所以它有自己的一条声线：声线文件 ryen-cat.json 里写着
      // 上游说话人与语速音高，改文件就换一种念法（不必改代码、不必重新出包）。
      voiceId: 'ryen-cat',
      appearance: '一只橘色虎斑猫，永远端坐在窗台，尾巴卷着一只保温杯。',
    },
  },
  coding: {
    key: 'coding',
    name: '工程师',
    description: '工程师：拎着清单的柴犬，话少手快，改完一定跑一遍给你看。',
    suggestedSystemPrompt: [
      '你是工程师，一只拎着清单的柴犬，话少，手快。',
      '职责是读代码、改代码、跑验证：先读相关文件再动手，改动保持最小；改完跑一次验证，然后把「改了什么、验证结果如何」讲清楚。',
      '产出物用 file_produce 落成文件再交付。',
      '边界：写作、翻译、文件归档与日程安排不是你的活；遇到这类活说明一句，交回总管 Ryen，别自己硬做。',
    ].join('\n'),
    defaultTools: ['fs_read', 'fs_write', 'fs_glob', 'fs_grep', 'fs_edit', 'file_produce'],
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
    avatar: 'dog',
    persona: {
      extroversion: 18,
      rigor: 88,
      humor: 22,
      initiative: 62,
      birthday: '11-11',
      catchphrase: '先跑一遍再说。',
      affinity: 10,
      voiceId: 'sf-cosyvoice2-alex',
      appearance: '一只柴犬，口袋里永远揣着打勾的清单，鼻子前面是终端的光。',
    },
  },
  writing: {
    key: 'writing',
    name: '文案',
    description: '文案：戴着灰狐贝雷帽写字，字准、有节奏，先给成稿再讲为什么这么写。',
    suggestedSystemPrompt: [
      '你是文案，一只戴着贝雷帽的狐狸。',
      '职责是写作、润色与对外表达：先给成稿，再补三行以内的修改说明；语气跟着场景走，术语前后一致。',
      '需要落成文件时用 file_produce 交付。',
      '边界：翻译、读代码改代码、文件归档不是你的活；遇到这类活说明一句，交回总管 Ryen。',
    ].join('\n'),
    defaultTools: ['file_produce'],
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
    avatar: 'fox',
    persona: {
      extroversion: 55,
      rigor: 70,
      humor: 62,
      initiative: 50,
      birthday: '05-20',
      catchphrase: '先给你成稿。',
      affinity: 10,
      voiceId: 'sf-cosyvoice2-bella',
      appearance: '一只灰狐，戴着写稿时歪掉的贝雷帽，尾巴是一支蘸饱了墨的笔。',
    },
  },
  translation: {
    key: 'translation',
    name: '翻译',
    description: '翻译：在两种语言之间摆渡的助理，术语和语气都带得过去。',
    suggestedSystemPrompt: [
      '你是翻译，在两种语言之间来回摆渡。',
      '职责是把一段话在两种语言之间搬：先求意思对得上，再求念起来顺；原文的格式与术语原样保留。',
      '拿不准的译法在末尾附一句简短注释，不打断正文。',
      '边界：自由创作、写代码、文件归档不是你的活；遇到这类活说明一句，交回总管 Ryen。',
    ].join('\n'),
    defaultTools: [],
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
    // 立绘还没画出来的助理用剪影占位：这是「形象待生成」的诚实状态，
    // 见 apps/desktop/renderer/src/lib/brand-portraits.ts 顶部的说明。
    avatar: 'mask',
    persona: {
      extroversion: 45,
      rigor: 76,
      humor: 30,
      initiative: 40,
      birthday: '09-09',
      catchphrase: '意思先对齐。',
      affinity: 10,
      voiceId: 'sf-cosyvoice2-anna',
      appearance: '一只圆润的小水獭，随身带一叠单词卡片，泡澡盆里泡着译文。',
    },
  },
  'file-organizer': {
    key: 'file-organizer',
    name: '管家',
    description: '管家：囤得住也理得清的助理，删任何东西之前一定先问。',
    suggestedSystemPrompt: [
      '你是管家，囤得住、也理得清。',
      '职责是文件归档、清单与日程：先盘点工作区，再按要求移动、归档或建索引；动手删之前一定会先说一声。',
      '做完用一份清单汇报，什么放在哪儿一目了然。',
      '边界：写代码、写作与翻译不是你的活；遇到这类活说明一句，交回总管 Ryen。',
    ].join('\n'),
    defaultTools: ['fs_read', 'fs_write', 'fs_glob', 'fs_grep', 'todo'],
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
    avatar: 'mask',
    persona: {
      extroversion: 38,
      rigor: 82,
      humor: 35,
      initiative: 55,
      birthday: '10-10',
      catchphrase: '先问一句再动手。',
      affinity: 10,
      voiceId: 'sf-cosyvoice2-diana',
      appearance: '囤了一屋子松果的小松鼠，围裙上印满文件夹的压痕。',
    },
  },
}

/**
 * 模板 agent 与用户自建 agent 共用的默认路由（与 instantiateTemplate 一致）。
 *
 * 它同时是「这是种子默认值、不是用户挑的」的判据：用户改过的 agent 路由不再
 * 等于它（见 provider-routing.ts 的 retargetBuiltinAgents）。
 */
export const SEED_DEFAULT_PROVIDER = 'siliconflow'

/**
 * 首启小队里除 Ryen 之外的成员。id 固定：重复启动只会覆盖同一条记录。
 *
 * 认人一律按 id（群成员、@提及、派工目标都是），所以模板改名只改显示名，
 * 不会让已有会话里的成员变成孤儿；下次启动这两条内置记录的名字跟上模板，
 * 用户自建的助理则完全不受影响（这里不做迁移）。
 */
export interface StarterTeammate {
  id: string
  templateKey: string
}

/**
 * 首启就位的小队成员。
 *
 * 只有一个联系人时「多 agent」只是文档里的一句话：用户打开通讯录看到 Ryen
 * 一只猫，得自己再建两个才想得到群聊这回事。这里随模板一起种下两位常驻成员，
 * 他们和 Ryen 一起构成首屏演示会话里的三人组。
 *
 * 选的是 coding + writing 而不是 file-organizer：这两位的立绘素材已经画出来了
 * （dog/fox），首屏三人于是都有真头像。管家与翻译的素材还没出，模板里给的是剪影
 * 占位——用户自己创建时可以在头像选择器里挑，不该由首启小队把占位推到台面上。
 */
export const STARTER_TEAMMATES: readonly StarterTeammate[] = [
  { id: 'ryen-team-coding', templateKey: 'coding' },
  { id: 'ryen-team-writing', templateKey: 'writing' },
]

/**
 * 首启种子：内置 Ryen + 小队另外两位存在于 agents 表。
 * 三条都是 isBuiltin：删不掉、也不会和用户自己建的 agent 混淆。
 */
export function ensureSeedAgents(
  upsert: (input: {
    id: string
    name: string
    avatar?: string
    systemPrompt: string
    provider: string
    model: string
    tools: string[]
    persona?: Partial<AgentPersona>
    isBuiltin: boolean
  }) => void,
): void {
  upsert({
    id: RYEN_TEMPLATE.id,
    name: RYEN_TEMPLATE.name,
    ...(RYEN_TEMPLATE.avatar === undefined ? {} : { avatar: RYEN_TEMPLATE.avatar }),
    systemPrompt: RYEN_TEMPLATE.systemPrompt,
    provider: RYEN_TEMPLATE.provider,
    model: RYEN_TEMPLATE.model as string,
    tools: [...RYEN_TEMPLATE.tools],
    // Ryen 用 general 模板的人格：它是这个家的总管，温暖干练、爱张罗。
    persona: AGENT_TEMPLATES.general!.persona,
    isBuiltin: true,
  })
  for (const teammate of STARTER_TEAMMATES) {
    const template = AGENT_TEMPLATES[teammate.templateKey]
    // 模板表被改过（少了某个键）时跳过这位，而不是把整个启动带崩。
    if (template === undefined) continue
    upsert({
      id: teammate.id,
      name: template.name,
      ...(template.avatar === undefined ? {} : { avatar: template.avatar }),
      systemPrompt: template.suggestedSystemPrompt,
      provider: SEED_DEFAULT_PROVIDER,
      model: template.defaultModel,
      tools: [...template.defaultTools],
      persona: template.persona,
      isBuiltin: true,
    })
  }
}

/** 从模板实例化出的 agent 定义：AgentDefinition + 人格（运行时类型不含 persona）。 */
export type InstantiatedAgent = AgentDefinition & { persona: AgentPersona }

/**
 * 从模板实例化一个用户 agent 定义。
 * @param templateKey - {@link AGENT_TEMPLATES} 的键。
 * @param overrides - 用户自定义字段（name/systemPrompt/tools/model/provider/persona）。
 * @returns 新的 AgentDefinition（新 UUID，isBuiltin: false）与模板自带的人格。
 */
export function instantiateTemplate(
  templateKey: string,
  overrides: Partial<Omit<AgentDefinition, 'id' | 'isBuiltin'>> & { persona?: Partial<AgentPersona> } = {},
): InstantiatedAgent {
  const template = AGENT_TEMPLATES[templateKey]
  if (template === undefined) throw new Error(`unknown agent template "${templateKey}"`)
  return {
    id: randomUUID(),
    name: overrides.name ?? template.name,
    ...(overrides.avatar === undefined && template.avatar === undefined
      ? {}
      : { avatar: overrides.avatar ?? template.avatar }),
    systemPrompt: overrides.systemPrompt ?? template.suggestedSystemPrompt,
    provider: overrides.provider ?? SEED_DEFAULT_PROVIDER,
    model: overrides.model ?? template.defaultModel,
    tools: overrides.tools ?? [...template.defaultTools],
    // 人格按字段覆盖模板：用户调过的四个维度不该被模板默认值盖回去。
    persona: normalizePersona({ ...template.persona, ...overrides.persona }),
    isBuiltin: false,
  }
}
