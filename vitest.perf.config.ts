import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

/**
 * 性能清单（PR 通道硬门 + 夜间留档，2026-11-07 起挡合并）：
 *
 * 为什么单独一份配置：评审的结论是「'极高响应速度'在事件密度这一层成立，但它今天
 * 不可回归」——`docs/performance.md` 里每一行都是服务端数字，客户端一条都没有。
 * 性能用例对机器负载敏感，混在默认通道里会让「测试全绿」变成噪声，所以拆开：
 *
 *   pnpm perf     # 手动跑，看数字与比值
 *   pnpm test     # 常规通道，不含本清单
 *
 * 通道分工（.github/workflows/ci.yml）：build-test 里的 **Perf gate 硬跑本清单并挡
 * 合并**——断言盘点（第六波 #8）：除一条余量极大的绝对时间外全是同机互比的比值
 * 与机器无关的计数上界，对 runner 负载鲁棒。夜间 perf-nightly 继续 continue-on-error
 * 跑同一条清单，只为把数字按 run 留档。
 *
 * **写新的 *.perf.ts 时守同一纪律**：比值/计数断言进用例，纯趋势数字进
 * scripts/bench.ts——进了本清单的用例就是回归承诺，在 CI runner 上红了要能站得住。
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
