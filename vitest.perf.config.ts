import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

/**
 * 性能清单（不进 PR 通道，但有夜间通道）：
 *
 * 为什么单独一份配置：评审的结论是「‘极高响应速度’在事件密度这一层成立，但它今天
 * 不可回归」——`docs/performance.md` 里每一行都是服务端数字，客户端一条都没有。
 * 性能用例对机器负载敏感，混在默认通道里会让「测试全绿」变成噪声，所以拆开：
 *
 *   pnpm perf     # 手动跑，看数字与比值
 *   pnpm test     # 常规通道，不含本清单
 *
 * 「不进 PR 通道」不等于「不跑」：一份从不执行的脚本会腐烂到没人发现它已经坏了，
 * 所以 `.github/workflows/ci.yml` 里有 `schedule` 夜间跑一遍（continue-on-error，
 * 数字作为 artifact 上传），PR 与 push 上不出现它的红灯。
 *
 * 复用主配置的 esbuild/plugins/resolve（装饰器插件、JSX、@ryharness/* 源码解析），
 * 否则 import 服务端源码会直接崩；只把 include 换成 *.perf.ts。
 *
 * include 必须显式列出内核包的清单：主配置的 include 是 `*.test.ts`，两份清单
 * 互不相干，于是新写的 `packages/memory/tests/recall.perf.ts` 这类内核性能用例
 * 谁都跑不到——一份从不执行的脚本会腐烂到没人发现它已经坏了。包目录有两种深度
 * （`packages/memory` 与 `packages/llm/openai`），两条 glob 都要有。
 */
export default defineConfig({
  ...base,
  test: {
    include: [
      'apps/desktop/tests/perf/**/*.perf.ts',
      'packages/*/tests/**/*.perf.ts',
      'packages/*/*/tests/**/*.perf.ts',
    ],
    // 性能用例自己控制迭代次数，给足超时；不做覆盖率统计。
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
