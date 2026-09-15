# 遇到的问题

本目录按时间顺序汇总本次桌面端 + OpenClaw 集成排查中遇到的问题，每个文件聚焦一个独立故障，便于以后回溯。

| 文件 | 问题概述 |
| --- | --- |
| [01-mac托盘图标消失.md](./01-mac托盘图标消失.md) | macOS 菜单栏图标不显示 |
| [02-未签名DMG打开失败.md](./02-未签名DMG打开失败.md) | DMG 提示"已损坏/无法打开"（Gatekeeper） |
| [03-一键连接点击无反应.md](./03-一键连接点击无反应.md) | 设置里"一键连接"按钮无反馈 |
| [04-IDE关联一直检测中.md](./04-IDE关联一直检测中.md) | IDE 关联卡在"检测中"无超时 |
| [05-OpenClaw只写config不能加载.md](./05-OpenClaw只写config不能加载.md) | OpenClaw 插件不被宿主识别 |
| [06-OpenClawApp版扫不到.md](./06-OpenClawApp版扫不到.md) | npm 版能扫到、App 版扫不到 |
| [07-Worker接口字段不匹配.md](./07-Worker接口字段不匹配.md) | `Session start missing required fields` |
| [08-发布脚本被测试和脏工作区拦住.md](./08-发布脚本被测试和脏工作区拦住.md) | 打包失败：viewer-api 测试与脏工作区 |
| [09-OpenClaw_agent挂起拿不到agent_end.md](./09-OpenClaw_agent挂起拿不到agent_end.md) | agent 命令挂起，observation 不落库 |
| [10-Gemini配额429导致助手内容为空.md](./10-Gemini配额429导致助手内容为空.md) | 429 错误事件入库但回复为空 |
| [11-OpenClaw插件调错summary端点永远400.md](./11-OpenClaw插件调错summary端点永远400.md) | plugin 调 `/api/summary` 而非 `/api/session/end`，永远 400 |
| [12-summary触发标准误读.md](./12-summary触发标准误读.md) | 误以为 summary 必须 session 结束才生成，实际每轮回复都触发 |
| [13-老用户升级App拿不到插件修复.md](./13-老用户升级App拿不到插件修复.md) | 升级路径不覆盖部署版 plugin，bug 修了用户拿不到 |
| [14-summary早于agent_response_observation导致错配.md](./14-summary早于agent_response_observation导致错配.md) | summary 先于当前轮 `agent_response` observation 入库，长 session 下展示错配 |
