# spec-injector-plugin — PRD

## 背景

我们沉淀了一套研发 harness（文档范式 + 需求注册中心 + 门禁 + 任务认领 + 偏好问询 + 一批 skills/rules）。但这套东西目前**散落在 agent-memory 本仓**，要复用到别的项目只能手动拷文件、手动改路径，且不同 agent IDE（Cursor / Claude Code / CodeBuddy / Windsurf…）的 skills/rules/mcp 落点各不相同，纯手工极易出错。

同时，除了 harness，我们还有很多"好用的零件"——单个 skill、单条 rule、某个 MCP 配置、某份规范文件——也希望能一键分发到任意项目/任意 IDE。

需要一个**通用的注入器插件**，把这些可复用内容内置打包、随版本更新，并通过清晰的可视化界面让用户挑选「注入什么、注入到哪个 IDE/项目」。

## 目标

做成 agent-memory 的一个**独立插件 `Injector`（规范注入器）**，能力：

1. **一键注入整套**：把成套内容（如「Harness 全套」）一键注入到目标项目，自动按目标 IDE 适配落点。
2. **通用、可单独注入**：不仅 harness，还能**单独注入** skill / rule / MCP / 规范文件（spec/doc）等任意粒度的内容。
3. **内容内置、随版本更新**：所有可注入内容（含一批好用的内置 skills）打包进插件，随插件版本发布更新；用户可看到"已注入版本 vs 最新版本"并升级。
4. **多 IDE 适配**：识别不同 agent IDE，自动把同一份内容写到各自正确的落点（`.cursor/`、`.claude/`、`.codebuddy/`、`AGENTS.md` 等）。
5. **独立 viewer 页**：插件自带可视化页面，分类清晰（整套 / Skills / Rules / MCP / 规范文件），可勾选注入、预览、查看已注入清单。

## 用户故事 / 使用场景

1. 作为新项目发起者，我打开 Injector 页，选「Harness 全套」+ 目标 IDE「Cursor」，点注入，项目里就自动有了文档范式、注册中心、门禁规则和相关 skills。
2. 作为只想要某个能力的人，我只勾选某一个 skill 和一条 rule，注入到当前项目，不带其它东西。
3. 作为多 IDE 用户，我同一份内容同时注入 Cursor 和 Claude Code，插件自动把 skill 写到 `.cursor/skills/` 和 `.claude/skills/`、rule 写到各自的 rules 落点。
4. 作为升级者，插件更新后我在页面看到"某 skill 有新版本"，点更新即覆盖（受管块/文件级安全合并）。
5. 作为谨慎的人，我注入前先点"预览"，看到将要写哪些文件、哪些是新增/覆盖/合并，确认后再执行。
6. 作为复盘者，我能查看"已注入清单"（注入了什么、到哪个项目/IDE、版本几何），并能一键卸载某项。

## 范围

### 包含

- 新建内置插件 `src/plugins/injector/`，按现有 self-evolve 接入模式接入 WorkerService（短期手工接线，长期对齐 plugin.json 框架）。
- **内置内容库（library）**：随插件打包的可注入资源（skills / rules / mcp / specs / bundles），含库索引清单（catalog）。
- **注入引擎**：按"内容 × 目标 IDE"解析落点 → 预览 diff → 写入（幂等、受管块/文件级冲突策略）→ 记录注入账本（ledger）。
- **多 IDE 落点解析**：复用/扩展 IDE 检测与 PlatformWriter 的路径规则，支持主流 agent IDE。
- **独立 viewer 页**：分类目录 + 勾选 + 目标选择 + 预览 + 注入 + 已注入清单 + 更新/卸载。
- **MCP tools**（snake_case）与 HTTP endpoint 同步注册。
- 首个内置 bundle：「Harness 全套」（依赖 `dev-harness-and-agent-task-claiming` 落地）。

### 不包含

- 不做云端内容市场/远程拉取（首版内容全部内置随包；远程仓库源列为后续）。
- 不做注入内容的在线编辑器（内容随版本维护，不在 UI 里改库）。
- 不替换 self-evolve 的"从记忆反向生成 rules/skills"能力（Injector 是"分发内置模板"，与 self-evolve 的"生成"互补）。
- 不强依赖未落地的 PluginHost 框架；首版按现状接线，预留迁移。
- 首版不做跨机远程注入（只注入本地可达的工作区路径）。

## 验收标准

- [ ] Injector 作为可在设置页开关的独立插件存在，开启后 viewer 出现「Injector」Tab。
- [ ] viewer 页能按分类（整套 / Skills / Rules / MCP / 规范文件）展示内置内容，每项有名称/描述/版本/已注入状态。
- [ ] 能选择目标 IDE（自动检测已安装项并预选）与目标工作区路径。
- [ ] 「Harness 全套」可一键注入，落点按所选 IDE 正确分布；单项内容也可独立注入。
- [ ] 注入前可预览将写入/覆盖/合并的文件清单（dry-run）。
- [ ] 注入幂等：rules 用受管块、mcp 用 JSON 合并、skills/specs 文件级（冲突给 skip/overwrite 选项）；重复注入不产生脏数据。
- [ ] 注入账本可查；支持对已注入项执行更新与卸载。
- [ ] 内置内容随插件版本打包；版本更新后页面能提示"可更新"。
- [ ] 新增 HTTP endpoint 均有对应 snake_case MCP tool。

## 风险与未决事项（需对齐）

- **模块归属**：本需求暂放 `hooks-adapter`（多平台适配相邻）。该插件体量大、是新产品形态，是否**升格为独立模块 `injector`**？（README §二"新增模块条件"）
- **IDE 落点权威表**：CodeBuddy/Windsurf 等的 rules/skills 落点在现有代码里只是"设计、未实现"，需确认真实路径再落注入逻辑。
- **库内容格式**：内置 library 用"目录文件 + catalog.json"还是"打进 bundle 的 SQLite seed"？（design 决策）
- **与 harness 的依赖**：「Harness 全套」bundle 依赖 harness 需求先实现其文件产物。
- **卸载语义**：受管块可精确移除；文件级注入卸载需账本记录原始状态，避免误删用户改动。
