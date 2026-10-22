# @ryharness/util-llm-json

OpenAI 兼容 chat/completions 的 JSON 结构化输出客户端。记忆管线与进化管线各自
的 prompt 与结果校验不同，但「发一次请求、解出 JSON、失败时给出可路由的稳定
错误码」这段是逐字重复的，所以只有这一份实现。

不含任何供应商默认值：baseURL / key / model 全部由调用方从 providers.json 传入。