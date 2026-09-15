# 2026-09-09 Claude Code 采集故障修复

已修复本机采集入口及模型失败时 observation 丢失问题，并将今天原始会话的可采集事件补回。百炼密钥解密仍需用户在应用设置中重新保存；当前保存的是原始 observation 和明确标记的降级 summary，未验证 AI 精炼恢复。

## 已确认的故障原因

1. Claude 的 `~/.claude/settings.json` 中七个事件指向不存在的 `~/.codebuddy-mem/hooks/cbmem-claude-hook.sh`。当前真实 wrapper 位于 `~/.agent-memory/hooks/agentmemory-claude-hook.sh`。
2. 注册检测把旧名称也视为“已注册”，没有检查入口文件能否执行，导致每分钟的 HooksGuard 跳过修复。
3. 补录时发现当前百炼密钥保存为 `safe:v1` 加密值，但 Worker 收到的主、轻量 API Key 都为空。原 SDK 又错误地回退到另一个服务商的内置凭据，百炼返回 401。此前 observation 在 AI 异常时直接抛错，原始数据不入库。

故障时间证据（北京时间）：

- 2026-09-09 10:37 的 Claude 设置备份仍指向正确的新路径。
- 16:47:51，今天的会话 `35fc2f70-d457-4cd7-bf13-09023061b08b` 的 SessionStart 成功创建数据库 session。
- 排查前 settings.json 最后修改时间为 17:12:28，里面已经是旧路径。
- 原始 JSONL 在 17:15:52、17:24:15、17:45:15 的 Stop 事件明确记录旧脚本 `No such file or directory`。
- 这些证据证明入口配置发生了回退；不能仅凭文件内容确定是哪一个进程写回了旧配置。

## 修改

- `desktop/src/shared/hooks-config.ts`：将“属于自己的 Hook”与“可用注册”分开；旧名称、缺失文件、不可执行入口不再视为健康，交给现有 HooksGuard 修复。
- `src/services/worker/SDKAgent.ts`：AI 提取异常复用确定性保存逻辑，保留提问/回答原文并标记失败；没有外部服务商密钥时，不再发送 TimiAI 默认凭据；显式为空的轻量模型密钥不会跨服务商回退。
- 当前安装应用对应的两个编译文件已更新，校验与构建输出一致，应用已重新签名并启动。
- 当前 Claude 七个 Hook 已重新注册；其他设置和第三方 Hook 在注册操作前后逐项比较一致。
- 为已经运行、可能缓存旧设置的 Claude 会话补建旧路径转发脚本。

## 补录及验证

源文件：`/Users/george/.claude/projects/-Users-george/35fc2f70-d457-4cd7-bf13-09023061b08b.jsonl`。

- 补录 15 条 observation：4 条真实提问（含一次中断后重提）、8 条 Bash 记录、3 条完成回答。
- 补录 3 条降级 summary，ID 为 2617、2618、2619。
- Read 等被现有产品规则归入 Tier 0 的工具事件仍按原规则处理；原始 JSONL 完整保留。
- 回放调用记录采集接口，不会重新执行原会话中的 Bash 命令。
- 补录时间显示为恢复时刻，原始会话时间仍保存在 JSONL 中。
- 清除了首次试回放产生的一条不完整临时摘要（2616），删除前已单独备份；没有删除任何修复前存在的摘要。
- 补录的 15 条 observation 和 3 条 summary 已全部进入向量索引；仅对 `/users/george` 项目重建索引。
- 原生 Viewer 已实测显示 george 项目下的 Claude 提问、回答和三轮摘要。
- 数据库 `PRAGMA quick_check` 为 `ok`。
- 与修复前一致性备份比较：原有 42065 条 observation、2615 条 summary 缺失或改变数量均为 0。
- `/health` 返回 healthy，pendingMessages 为 0。
- 31 项相关回归测试通过，主项目和桌面项目 TypeScript 检查均通过。
- 实际运行的 HooksGuard 已验证：恢复旧注册配置后，自动改回七个新入口；验证期间旧入口有兼容转发，不会阻断采集。

## 剩余事项

用户需在 AgentMemory 设置中重新输入并保存百炼 API Key，不要将密钥发到聊天。密钥恢复后还需实测 AI 精炼；现阶段确认采集、原文保存、降级摘要、原生显示、向量索引可用，不能宣称百炼调用成功。

## 备份及证据

目录：`/Users/george/.agent-memory/backups/claude-capture-fix-20260909-204933/`。

包含修复前数据库一致性备份、Claude 设置备份、原编译文件、回放脚本与检查点、最终 `verification.json` 和 `regression-tests.log`。不要直接覆盖运行中的 SQLite 主文件来回滚；需要同时考虑 WAL 和修复后新增数据。
