# 用户偏好自动记忆设计

## 设计目标

在不改变现有核心数据模型的前提下，实现以下能力：

1. `hooks-cli` 可稳定解析带 BOM 的 JSON 输入。
2. 在 `beforeSubmitPrompt` 阶段识别明显用户偏好。
3. 对识别出的偏好直接写入 `observations`，绕过 AI 提炼链路。

## 总体设计

### 一、BOM 兼容

问题根因：

- Cursor 传入的 hook stdin 可能以 UTF-8 BOM 开头。
- 当前代码在 `JSON.parse()` 前未去除 BOM，导致解析失败。

设计方案：

1. 新增统一字符串清洗函数。
2. 在所有 `JSON.parse()` 前先移除开头 BOM。
3. 保持现有多编码回退逻辑不变，仅在最终解析前做最小修复。

### 二、偏好识别入口

识别入口放在 `handleBeforeSubmitPrompt()`。

原因：

1. 用户原始 prompt 在这里最完整。
2. 这是最靠近用户输入的位置。
3. 即使后续没有文件编辑、命令执行，也能记录用户偏好。

执行时机：

1. 先完成 `initSession()`，确保存在可关联的 session。
2. 再根据 `input.prompt` 做偏好抽取。
3. 命中后直接调用 worker 新增“手工 observation”接口。

### 三、偏好识别规则

本次采用轻量规则，不做复杂 NLP。

首批支持模式：

1. `我喜欢...`
2. `我爱吃...`
3. `我不喜欢...`
4. `我不吃...`
5. `我偏好...`
6. `我更喜欢...`
7. `我习惯...`
8. `我更习惯...`

抽取结果包含：

- `preferenceType`: like / dislike / habit / preference
- `subject`: 用户偏好对象，如“清江鱼”
- `rawPrompt`: 原始用户句子

### 四、落库策略

不走现有 `/api/observation` + AI 提炼链路，新增一个直接落库接口。

新增接口建议：

- `POST /api/observation/direct`

请求体包含：

- `sessionId`
- `type`
- `title`
- `subtitle`
- `metaIntent`
- `facts`
- `narrative`
- `concepts`

Worker 根据 `sessionId` 查到对应 `memory_session_id` 和 `project` 后，直接调用 `insertObservation()` 写库。

### 五、Observation 结构约定

偏好类 observation 统一使用：

- `type = "learning"`

示例内容：

- `title`: `User preference detected`
- `subtitle`: `Food preference`
- `meta_intent`: `【用户偏好】记录用户明确表达的长期偏好，便于后续个性化响应`
- `facts`: `用户喜欢吃清江鱼`
- `narrative`: `User explicitly stated a food preference in the prompt: 我喜欢吃清江鱼`
- `concepts`: `user-preference, food, qingjiang-fish`

### 六、去重策略

首版采用最小去重：

1. 仅对当前 session 内相同 `facts` 文本做去重。
2. 若最近已存在完全相同的偏好记录，则跳过本次插入。

这样可以防止用户重复发送同一句偏好时短时间内刷出多条完全重复记录。

## 影响范围

需要修改的模块：

1. `src/hooks-cli.ts`
   - BOM 清洗
   - 用户偏好识别
   - 调用 direct observation 接口

2. `src/services/worker/client.ts`
   - 新增 direct observation 请求方法

3. `src/services/worker/WorkerService.ts`
   - 新增 direct observation 路由
   - 实现直接写库逻辑

4. `src/services/sqlite/observations.ts`
   - 如有需要，补充按 session + facts 查询的轻量去重能力

## 风险与取舍

### 风险 1：规则误判

取舍：

- 首版只覆盖非常明确的表达。
- 宁可漏记，不要误记太多。

### 风险 2：概念标签不统一

取舍：

- 首版先保证能记录和能读回。
- 更精细的偏好 taxonomy 后续再做。

### 风险 3：直接写库绕过 AI

取舍：

- 这是本次刻意设计。
- 因为偏好信息通常短小明确，规则抽取更稳定，也避免模型权限依赖。

## 验证方案

### 用例 1

输入：

- `我喜欢吃清江鱼`

期望：

- 新增一条 `learning` 类型 observation。

### 用例 2

输入：

- `我更习惯 Windows`

期望：

- 新增一条偏好 observation。

### 用例 3

输入：

- `帮我看看这个报错`

期望：

- 不新增偏好 observation。

### 用例 4

输入 JSON 带 BOM

期望：

- hook 正常解析，不再出现 `Unexpected token '﻿'`。
