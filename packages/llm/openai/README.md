# @ryagent/llm-openai

OpenAI 兼容（chat/completions + SSE）适配器：配置驱动多供应商路由（baseURL + apiKeyEnv + models），支持流式 tool calling（增量 tool-call delta 组装）、usage 提取（含 reasoning/cache tokens）、统一错误码映射（RATE_LIMIT/QUOTA/CONTEXT_WINDOW_EXCEEDED/INVALID_CREDENTIAL/…）、dsh tool-addition/removal 原语对 OpenAI 协议的降级映射。默认导出 cordis apply 插件，直接挂载到 ctx.llm。
