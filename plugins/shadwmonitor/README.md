# ShadwMonitor Plugin

屏幕活动感知插件 — 自动捕获屏幕，OCR + LLM 蒸馏为可读的"我在干啥"记忆，
并把每 5 分钟的 L1 时刻摘要镜像到 agent-mem 全局记忆库，让 IDE 搜索能命中桌面活动。

> 来源：原 `D:\UGIT\ShadwMonitor` 独立项目，已快照迁移到 agent-mem `plugins/shadwmonitor/` 作为内置插件。
> 设计与需求：[docs/memory-core/features/desktop-monitor-plugin/](../../docs/memory-core/features/desktop-monitor-plugin/)

## Scope

- 三层感知架构：截屏 + OCR + LLM 蒸馏（L1 时刻 / L2 时段 / L3 日摘要）
- 自有 SQLite 存储与 Web 端（8080），与 agent-mem Worker（3847）解耦
- 通过 `agent_mem_bridge/` 子模块把 L1 摘要镜像到 agent-mem，让全局搜索能命中
- 不修改 agent-mem 核心：observation schema / Worker API 零改动

## 运行模式

| 模式 | 命令 | 作用 |
|---|---|---|
| `capture` | `python src/main.py capture` | 启动屏幕采集 + OCR + 蒸馏 + 桥接（若启用） |
| `web` | `python src/main.py web` | 启动本插件自己的 Web 查看端（http://127.0.0.1:8080） |

两个模式独立进程，建议两个终端各跑一个；或用 `start.bat` 一键启动。

## 安装

```bash
# 1. 进入插件目录
cd plugins/shadwmonitor

# 2. 安装依赖
pip install -r requirements.txt

# 3. 复制环境变量模板
copy .env.example .env
# 编辑 .env 填入 AI_MONITOR_BASE_URL / AI_MONITOR_API_KEY

# 4. 修改 config/settings.yaml
#    把 agent_mem.enabled 改为 true 即可启用 agent-mem 桥接
```

## 配置文件 `config/settings.yaml`

完整字段说明见 ShadwMonitor 原始 design：[docs/design.md](docs/design.md)。
插件特有的桥接节：

```yaml
agent_mem:
  enabled: false                       # 默认关闭；启用后会镜像 L1 到 agent-mem
  endpoint: http://127.0.0.1:3847      # agent-mem Worker 地址
  scope: desktop-monitor               # observation.project 字段值
  poll_interval_seconds: 30            # 轮询新 moment 的间隔
  batch_size: 50
  retry_max_attempts: 10
  retry_initial_delay_seconds: 1
  retry_max_delay_seconds: 60
  mirror:
    moment: true                       # L1 镜像（推荐打开）
    session: false                     # L2 暂不支持
    daily: false                       # L3 暂不支持
```

## 桥接架构（agent_mem_bridge/）

子模块位置：`src/agent_mem_bridge/`

| 文件 | 职责 |
|---|---|
| `state.py` | SQLite 持久化：`bridge_state`（水位）+ `bridge_retry_queue`（离线队列） |
| `mapper.py` | `MomentSummary` → agent-mem `/api/observation` payload |
| `poster.py` | 零侵入轮询：定期查 `moment_summaries` 表里 `id > last_mirrored_id` 的新记录，POST 到 agent-mem |

桥接通过 `main.py` 在 `agent_mem.enabled=true` 时自动挂入 `asyncio.gather`，
不修改 ShadwMonitor 原有的 Distiller / Database 任何代码。

## 跟 agent-mem 的协作

- **写入路径**：bridge → POST `/api/session/start` → POST `/api/observation`（`type=screen_moment`）
- **memory_session_id**：按日期分桶 `desktop-monitor-YYYY-MM-DD`
- **检索**：agent-mem 全局搜索能命中 L1 摘要；Claude/Cursor 可同时配 ShadwMonitor 的 stdio MCP 主动查询（Phase 2 即将实现）

## 测试

```bash
# 语法检查
cd plugins/shadwmonitor
python -c "import ast; [ast.parse(open(f).read()) for f in ['src/agent_mem_bridge/poster.py','src/agent_mem_bridge/state.py','src/agent_mem_bridge/mapper.py']]"

# Mapper smoke test
python -c "
import sys; sys.path.insert(0, '.')
from src.storage.models import MomentSummary
from src.agent_mem_bridge.mapper import build_observation_payload
m = MomentSummary(id=1, time_start='2026-05-23T14:25:00', time_end='2026-05-23T14:30:00',
                  summary='test', capture_ids=[], app_names=['Code.exe'])
print(build_observation_payload(m, scope='desktop-monitor'))
"
```

## 故障排查

| 现象 | 检查项 |
|---|---|
| agent-mem 搜不到 screen_moment | 检查 `agent_mem.enabled` 是否为 true；agent-mem Worker 是否在线（curl `http://127.0.0.1:3847/health`） |
| bridge 报 httpx 未安装 | `pip install -r requirements.txt`（含 httpx） |
| 截屏一直没产生 L1 | 检查 `min_captures_for_moment` 是否过高；检查 `excluded_processes` 是否误伤前台应用 |
| 重试队列堆积 | 看 `data/ai_monitor.db` 的 `bridge_retry_queue` 表，`last_error` 字段给出原因 |

## 跟 ShadwMonitor 原仓库的关系

- 本目录是 `D:\UGIT\ShadwMonitor` 在 **2026-05-23** 的快照（不含 git 历史）
- 原仓库仍然存在但不再演进；后续修改都在本目录进行
- `.gitattributes`（LFS 配置）已删除，由 agent-mem 主仓库管理
