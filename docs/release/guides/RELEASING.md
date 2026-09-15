# AgentMemory 发版流程

每次发布新版本时，按照以下清单依次完成。

---

## 1. 代码变更完成

确保所有功能开发和 Bug 修复已完成，代码在本地测试通过。

## 2. 更新版本号

两个 `package.json` 中的 `version` 字段需要同步更新：

```bash
# 根目录（核心库）
package.json          → "version": "x.x.x"

# 桌面端（Electron 应用）
desktop/package.json  → "version": "x.x.x"
```

> 两个版本号必须保持一致。

## 3. 编写更新日志

编辑 `CHANGELOG.md`，在文件顶部（`---` 分隔线后）添加新版本条目。

格式参考：

```markdown
## [x.x.x] - YYYY-MM-DD

### 新增
- **功能名称**：具体描述

### 修复
- **问题描述**：原因分析和修复方案

### 改进
- **改进点**：具体变更

### 重构
- **重构内容**：变更说明
```

分类说明：

| 分类 | 用途 |
|------|------|
| 新增 | 全新功能或模块 |
| 修复 | Bug 修复 |
| 改进 | 对已有功能的增强、默认值调整等 |
| 重构 | 代码结构调整，不影响功能 |

书写要点：
- 标题加粗，用一句话概括问题
- 冒号后写清楚原因和解决方案
- 涉及路径、配置名、命令的用反引号包裹
- 如果修复了用户可感知的问题，写清楚用户视角的表现（如"Worker 启动后立即崩溃"）

## 4. 提交代码

```bash
git add -A
git commit -m "release: v1.1.5 - 简要描述主要变更"
git push
```

## 5. 构建安装包

```bash
# 先构建核心库
npm run build

# 再构建桌面端安装包
cd desktop
npm run build
```

构建产物位于 `desktop/release/`，文件名格式：`AgentMemory-Setup-x.x.x.exe`

## 6. 测试安装包

在干净环境或覆盖安装场景下测试：

- [ ] 双击安装，首次启动向导正常弹出
- [ ] 关联至少一个 IDE（Cursor / CodeBuddy），确认 hooks 注册成功
- [ ] 进行一次 Agent 对话，确认记忆浏览器有数据
- [ ] 检查 `~/.agent-memory/logs/worker.log` 无报错
- [ ] 覆盖安装旧版本后，重新关联 + 重启 IDE，hooks 正常工作

## 7. 更新 Wiki 文档

iWiki 空间地址：https://iwiki.woa.com/p/4018506542

需要检查并更新的页面：

| 页面 | 文档 ID | 何时需要更新 |
|------|---------|-------------|
| [AgentMemory 安装与使用指南](https://iwiki.woa.com/p/4018982259) | 4018982259 | 每次发版都需要更新版本号、新增功能说明、FAQ |
| [Agent Memory 使用指南](https://iwiki.woa.com/p/4018541832) | 4018541832 | 涉及源码构建流程、Hook 列表、MCP 工具变更时 |
| [技术架构与原理](https://iwiki.woa.com/p/4018544490) | 4018544490 | 涉及架构、数据模型、技术栈变更时 |

每个页面需检查的内容：

**安装与使用指南**（每次必更新）：
- [ ] 页面顶部的版本号 `v1.x.x`
- [ ] 安装步骤中的 exe 文件名 `AgentMemory-Setup-x.x.x.exe`
- [ ] 新增功能的使用说明
- [ ] 新的常见问题（FAQ）
- [ ] Agent 技术参考表（如有新路径、新事件等）

**使用指南 / 技术架构**（按需更新）：
- [ ] 技术栈表格（新增依赖、模型变更等）
- [ ] Hook 事件列表（新增/移除事件）
- [ ] MCP 工具列表（新增/变更工具）
- [ ] 数据库 Schema（新增列或表）
- [ ] 目录结构（新增模块）

## 8. 分发安装包

将 `AgentMemory-Setup-x.x.x.exe` 分发给用户，并提醒：

- 升级后需在设置中**重新关联 IDE**，然后**重启 IDE**
- 强烈建议配置自己的 TIMIAI API Key（内置 Key 未来会作废）

---

## 快速检查清单

发版前逐项确认：

```
[ ] package.json 版本号已更新
[ ] desktop/package.json 版本号已更新（与上方一致）
[ ] CHANGELOG.md 已添加新版本条目
[ ] 代码已 commit 并 push
[ ] npm run build 成功
[ ] desktop npm run build 成功，产出 exe
[ ] 安装包基本功能测试通过
[ ] iWiki 安装指南版本号和内容已更新
```
