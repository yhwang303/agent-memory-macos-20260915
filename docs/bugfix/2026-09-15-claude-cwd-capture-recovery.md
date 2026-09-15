# 2026-09-15 Claude Code 工作目录异常导致漏记

本机源码和 `/Applications/AgentMemory.app` 已修复。漏记的一轮已恢复为 2 条 observation 和 1 条 AI summary，数据库、Viewer 接口、原生窗口及向量索引均已验证。

## 原因与时间证据

- 受影响会话：`e7bd6c16-ea51-49bd-a5f7-936e69c34402`，项目为 `糖尿病医疗Agent_强约束Harness方案`。
- 9 月 14 日同一会话正常写入，最后一条 observation 为 43155（北京时间 17:55:19），summary 为 2722（17:55:41）。
- 9 月 15 日 09:56:02 的 UserPromptSubmit 和 09:57:08 的 Stop 均执行了正确的 Hook wrapper，且成功连接 Worker，随后都在项目路径解析阶段报 `EPERM: operation not permitted, uv_cwd`。对应证据在 `~/.agent-memory/logs/hooks-cli.log` 的 31128–31146 行。
- `resolveHookProjectPath` 将 `process.cwd()` 写在默认参数中。JavaScript 会在进入函数体前求值，因此即使 Claude 已提供有效的绝对 `cwd`，仍会提前触发失败的系统工作目录读取，整个采集处理随之退出。
- Hook 外层捕获异常后返回放行，因而 Claude 对话正常、Stop 的 hookErrors 也为空，但 observation 和 summary 都没有发往 Worker。
- 当前七个 Hook 配置和入口文件正常，Worker 持续健康。这次故障与 9 月 9 日的旧 Hook 路径故障不同。昨天和今天原始记录的 Claude 版本同为 2.1.270。
- 已确认系统当时拒绝工作目录读取；现有日志无法进一步确定是哪一次 macOS 权限或进程环境变化触发了 EPERM。排查时目录仍存在，Claude 的进程 cwd 也仍指向该目录，不能归因于目录删除或版本升级。

## 修复

仅调整 `src/utils/projectPath.ts` 的运行目录兜底：先检查事件字段和环境中的绝对路径；都不可用时才读取进程 cwd，并捕获读取异常，以已有的空字符串表示未知项目。原有字段优先级不变。

新增 `tests/project-path.test.ts` 回归用例，覆盖有效事件路径、环境路径、EPERM、ENOENT 和懒读取兜底。修复前两个用例失败，修复后全部通过。

已构建并只替换安装版的 `worker/utils/projectPath.js` 和 source map，随后重新签名及验证。Hook 每次启动新进程加载该文件，无需重启用户当前 Claude 会话。Claude 配置未修改。

## 恢复与验证

- 原始 JSONL：`/Users/george/.claude/projects/-Users-george-Desktop------Agent----Harness--/e7bd6c16-ea51-49bd-a5f7-936e69c34402.jsonl`。
- 仅回放 09:56 的真实提问和该轮 Stop；这轮没有工具调用。没有重放昨天的数据或执行会话中的代码。
- observation 43190：关于添加饮食和运动特征后数据稀疏性的提问。
- observation 43192：关于稀疏特征和 mask 机制的回答。
- summary 2727：包含该轮稀疏性讨论的会话摘要。模型请求返回 200，非降级摘要。
- 恢复记录显示恢复时刻 10:07–10:08；原始时间保留在 JSONL 和备份中。
- 安装版真实 wrapper 故障注入测试：强制 `process.cwd()` 抛 EPERM，修复前只收到健康检查且没有任何写入请求；修复后收到 session/start、两次 observation、session/end。测试使用隔离的本地模拟 Worker，未污染真实数据库。
- 38 项相关测试通过，`npm run build` 通过，安装文件与编译产物一致，应用签名校验通过。
- Viewer API 返回上述三条记录；原生 Viewer 已显示两张 observation 卡片，Summary 列表顶部显示本项目第 92 条摘要（数据库 ID 2727）。
- 三条记录全部自动进入向量索引，无需重建索引。
- 与修复前 SQLite 一致性备份逐条比对：43,182 条旧 observation 和 2,725 条旧 summary 的缺失、改动均为 0；数据库 quick_check 为 ok，后台健康。

## 备份

`/Users/george/.agent-memory/backups/claude-cwd-fix-20260915-100507/`

包含修复前 SQLite 一致性备份、原源码及安装文件、Claude 设置、原始会话快照、回放脚本和状态、安装版故障注入脚本、回归结果、最终 verification.json。回放脚本会拒绝重复执行；不要直接覆盖运行中的 SQLite 数据库。
