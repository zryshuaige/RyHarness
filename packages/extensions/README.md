# @ryharness/extensions

运行时能力目录：让助理能**查**这个运行时到底有什么。

## 做什么

- `buildCatalog(input)`：把宿主运行时的事实（工具、HTTP 接口、后台服务）整理成一份
  可查的清单。工具按名字排、路由按方法与路径排——目录是要给人看的，顺序稳定才能让
  两次查询的差异有意义。
- `searchCatalog(catalog, query)`：按关键词查。关键词为空给全部；有关键词时按名字与
  说明子串匹配。没命中就是空，不是报错。
- `ExtensionRegistry`：登记扩展清单，校验依赖关系，解出装载顺序（有环就报错并指出
  环上的那几个 id）。
- `createRuntimeCatalogTool(catalog)`：模型看得见的那件工具 `runtime_catalog`。

## 边界

**这一族不提供「让模型自己挂插件」的口子。** 那等于把宿主的能力面交给模型，而模型的
判断力不足以承担这个风险——真要装插件，走人点的界面。上游 `extensions` 也是同样的
口径（只读的运行时 API 发现）。

「扩展清单」在这里是**数据**（id、提供什么、依赖什么），不碰真正的装载——装载是插件
宿主的事。

## 与上游 dsh 的差别

| 上游 | 我们 | 为什么 |
|---|---|---|
| `tool-cordis`：两个只读的运行时发现工具 | 一件 `runtime_catalog` | 形状一样：一个查全部、一个查命中 |
| `cordis-host-runner` / `cordis-client-runner`：浏览器那一半的动态插件 | **不做** | 浏览器半边插件需要浏览器端宿主；我们是桌面应用，没有那一半 |
| `ui-cordis`：浏览器面板与历史卡片 | **不做** | 同上 |
| Standard / Creator 模式：装持久插件 | **不做** | 装插件是人的动作，不交给模型 |

## 用法

```ts
import { buildCatalog, createRuntimeCatalogTool, ExtensionRegistry } from '@ryharness/extensions'

const catalog = buildCatalog({
  tools: [{ name: 'fs_read', description: '读文件' }],
  routes: [{ method: 'GET', pattern: '/api/agents' }],
  services: [{ name: 'llm', description: '模型路由' }],
})

const registry = new ExtensionRegistry()
registry.register({ id: 'base', name: '基础', description: '底座' })
registry.register({ id: 'web', name: '网页', description: '网页能力', requires: ['base'] })
registry.resolveOrder() // → base, web
```
