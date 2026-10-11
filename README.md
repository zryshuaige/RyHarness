# RyAgent

从 [deepseek-harness](../deepseek-harness)（DeepSeek Harness / dsh 上游原版）裁剪出的精简 agent 内核。M1 范围：pnpm monorepo 骨架 + cordis DI 地基 + LLM 服务缝（`@ryagent/llm`）+ 新写的 OpenAI 兼容多供应商适配器（`@ryagent/llm-openai`）。agent 运行时、会话持久化、UI 不在本期。

依赖盘点结论见 [M0-dependency-audit.md](./M0-dependency-audit.md)。

## 目录结构

```
vendor/                        vendored 上游地基（保持上游宽松编译策略）
  cordis/                      @ryagent/cordis        DI 核心（Context/Service）
  cosmokit/                    @ryagent/cosmokit      工具库
  schemastery/                 @ryagent/schemastery   schema 校验
packages/
  llm/
    llm/                       @ryagent/llm           LLM 服务缝（LlmAdapter/LlmRuntime/StreamChunk）
    openai/                    @ryagent/llm-openai    OpenAI 兼容适配器（新写）
  typert/protocol/             @ryagent/typert-protocol  Typert RPC 基类
  attachment/types/            @ryagent/attachment     附件类型 stub
  util/{brand,values,crypto,timeout}/   工具小包
  runtime-diagnostics/invariants/       @ryagent/invariants
scripts/
  smoke-siliconflow.ts         SiliconFlow 冒烟（需 SILICONFLOW_API_KEY）
.zcode/                        M0/M1 分析脚本（depscan/copy-packages 等）
```

## 常用命令

```sh
pnpm install
pnpm build          # 全量构建（vendor 用 tsc，packages 用 tsdown）
pnpm typecheck      # 严格类型检查（根程序；vendor 由其自身 tsc build 校验）
pnpm test           # vitest（mock SSE，不触网）
pnpm smoke:siliconflow   # 真实 API 冒烟；无 key 时打印提示并以退出码 0 跳过
```

## 解析策略（与上游的差异）

- 包名 `@deepseek-ai/{cordis,cosmokit,schemastery,dsh-*}` 全部重写为 `@ryagent/*`。
- 不带 cordis 插件生态（loader/include/yml 组合）：用代码组装 Context（见冒烟脚本）。
- 运行时/测试通过根 tsconfig paths 直接解析 TS 源码；`tsconfig.typecheck.json` 将 vendor
  映射到构建产物 d.ts 做严格检查。标准 TC39 装饰器（`@Remote`）由 vitest 的
  pre-transform 插件处理（上游同款做法）。
- `dsh-attachment` 类型依赖以最小 stub（`@ryagent/attachment`）替代，真需要图片/文件
  输入时再换真实现。
