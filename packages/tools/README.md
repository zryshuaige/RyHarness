# @ryagent/tools

基础工具集，实现 `@ryagent/agent` 的 `Tool` 抽象：

- **fs_read / fs_write**：工作区限定，自动建父目录，读截断 64k 字符。
- **shell_exec**：工作区根目录执行命令。Windows 优先 Git Bash（`GIT_BASH_PATH` / 常见安装路径探测），退回 cmd.exe；POSIX 用 /bin/sh。用 `execFile` 直 spawn 解释器（不经 cmd 字符串拼接，规避 Windows 路径空格引号问题）；默认超时 30s（SIGKILL），输出截断 32k 字符；取消信号交给 spawn，按进程树收尾（Windows 上 `taskkill /T`）；命令命中敏感路径直接拒绝；错误与超时返回 `isError` 结果而非抛异常。
- **file_produce**：内容落成工作区 `.ryagent-artifacts/` 产物文件，返回**产物卡片** `{ path, name, size, mime }`——"发文件"能力的内核，UI 据此渲染文件消息。MIME 按扩展名推断，可显式覆盖。

路径逃逸、缺参数、命令失败一律映射为 `{ isError: true }` 结果，由 AgentLoop 以 tool 消息形式回给模型。

## 工作区边界与符号链接语义

`fs_read` / `fs_write` 的边界是两层，缺一层就等于没边界：

1. **词法层** `resolveInWorkspace`：把入参 resolve 到工作区根之下，`..`、根外绝对路径、盘符切换一律拒绝（抛 `PathEscapeError`，被工具入口映射成 `isError` 结果）。
2. **真实路径层**：工作区里一个指向外部的符号链接 / Windows junction，词法层完全看不出来，却能让模型读到（或写穿）工作区外的一切。因此每次读写前还要解析一次真实路径，与**工作区根的真实路径**比较。

真实路径解析有两条必须遵守的约定：

- **写目标尚不存在**时，从最深的**已存在**祖先开始解析，剩下的段按原样接回——否则 `fs_write` 任何新文件都会被判成"逃逸"。
- **工作区根本身是链接**（macOS 的 `/tmp`、工作区指到别处）时，根也要走一遍真实路径再比较；拿词法根去比真实路径会把合法路径误判成逃逸。

由此得到的语义：

- 工作区内的链接（目标也在工作区内）照常读写——真身路径在根内即放行。
- 指向工作区之外的链接读不到、写不进，写入时连目标父目录都不会被创建。
- 逃逸信息里同时给出词法路径与解析出的真实路径，便于定位是哪个链接作怪。
- Windows / macOS 文件名大小写不敏感，路径比较按小写进行。

已知缺口：`file_produce` 只走词法层（固定子目录 + 只允许叶子名，不允许路径分隔符），若工作区里的 `.ryagent-artifacts` 本身是一个指向外部的链接，产物会落到链接指向处。

## shell_exec 敏感路径闸

`findSensitiveInCommand(command, extraPatterns?)` 是纯文本闸：把命令按空白与引号切段，剥掉重定向/子 shell 标点后逐段判定，命中即返回 `{ rule, fragment }`。`shell_exec` 在 `blockSensitivePaths` 开着时命中即报错，**命令不执行**（连输出重定向都不落地）。

默认规则：

- **路径段**：`.ssh/`、`.aws/`；`.git/` 下只有 `config`（其余是对象库，不拦）。
- **文件名**：`.env` 及其点后缀变体（`.env.local` 等；`.env.example` / `.env.sample` / `.env.template` 这类模板放行）、`api-keys.json`、`credentials`、`secrets.json`、`id_rsa` / `id_ed25519` 等私钥名、`.netrc`、`.npmrc`、`.pgpass`、`.htpasswd`、`.git-credentials`。
- **按点分段的词根**：`prod-secret.json`、`my.private_key`、`foo.token` 命中，`tokenizer.ts` 这类只是词根相近的正常文件名不命中；不带点的裸词一律放行（`grep secret src` 不误伤），`cat credentials` 走的是上面那份显式名单。
- **扩展名**：`.pem` / `.key` / `.p12` / `.pfx` / `.jks` / `.keystore` / `.ppk`（裸文件名也拦，私钥容器没有歧义）。
- **命令本身**：`git config ...` 直接读仓库本地配置（可能内嵌 token），不依赖路径写法就拦。
- **自定义片段**：宿主可追加环境相关的敏感串（小写包含匹配），命中时报"宿主自定义规则"。

策略是**进程级**的：`shellGuardPolicy()` 读当前快照，`setShellGuardPolicy(policy)` 整体替换（不是增量合并，缺省项回到默认值），只能由宿主在启动配置时调用。工具入参里刻意没有"跳过检查"的开关——模型能改的开关等于没有闸，一句"先放行再读"就绕过去了。

闸的射程要说清楚：它挡的是"模型顺手 `cat ~/.ssh/id_rsa`"这类直白动作，**不是沙箱**。变量间接（`P=~/.ssh/id_rsa; cat $P`）、base64、`find -name` 都在射程之外；`shell_exec` 的 `cwd` 只是工作区根，命令能访问当前用户有权访问的任何路径。真正的边界是 fs 工具的工作区限定、每会话工具配额（`@ryagent/agent` 的 `SessionQuota`，shell 次数 / 写入字节数）和操作系统账号权限。
