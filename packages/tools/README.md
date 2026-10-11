# @ryagent/tools

基础工具集，实现 `@ryagent/agent` 的 `Tool` 抽象：

- **fs_read / fs_write**：工作区限定（`resolveInWorkspace` 词法防逃逸），自动建父目录，读截断 64k 字符。
- **shell_exec**：工作区根目录执行命令。Windows 优先 Git Bash（`GIT_BASH_PATH` / 常见安装路径探测），退回 cmd.exe；POSIX 用 /bin/sh。用 `execFile` 直 spawn 解释器（不经 cmd 字符串拼接，规避 Windows 路径空格引号问题）；默认超时 30s（SIGKILL），输出截断 32k 字符；错误与超时返回 `isError` 结果而非抛异常。
- **file_produce**：内容落成工作区 `.ryagent-artifacts/` 产物文件，返回**产物卡片** `{ path, name, size, mime }`——"发文件"能力的内核，UI 据此渲染文件消息。MIME 按扩展名推断，可显式覆盖。

路径逃逸、缺参数、命令失败一律映射为 `{ isError: true }` 结果，由 AgentLoop 以 tool 消息形式回给模型。
