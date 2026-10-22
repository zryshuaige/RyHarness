# @ryharness/llm

LLM 服务缝：LlmAdapter 抽象（适配器只需实现 stream()）、LlmRuntime（registerAdapter 路由注册、prepareCall、llm/stream 瀑布）、StreamChunk 流式协议、消息/内容块类型与 BlockAssembler 组装。从 @deepseek-ai/dsh-llm 裁剪改名。
