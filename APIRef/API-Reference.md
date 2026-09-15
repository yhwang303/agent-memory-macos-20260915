# AI API 参考文档

本文档整理了所有可用的 AI API 接口信息。

---

## 📁 原始文档来源

以下文档位于 `APIDoc/` 目录：

| 文档名称 | 说明 |
|---------|------|
| LLM+ChatAPI+模型接口.doc | LLM Chat API 模型接口文档 |
| LLM+ResponseAPI+模型接口.doc | LLM Response API 模型接口文档 |
| Nano+Banana+API+调用文档.doc | Nano Banana API 调用文档 |
| 混元api使用文档.doc | 混元 API 使用文档 |

---

## 🤖 可用模型列表

### 文本对话模型 (Chat/LLM)

| ID | 模型名称 | 供应商 | 说明 |
|----|---------|--------|------|
| 13 | gpt-5 | Azure | GPT-5 模型 |
| 14 | gpt-5-chat | Azure | GPT-5 对话模型 |
| 15 | gpt-5-codex | Azure | GPT-5 代码生成模型 |
| 16 | gpt-5-mini-test | Azure | GPT-5 Mini 测试版 |
| 17 | gpt-5-nano | Azure | GPT-5 Nano 轻量版 |
| 18 | gpt-4.1 | Azure | GPT-4.1 模型 |
| 19 | gpt-4o | Azure | GPT-4o 多模态模型 |
| 20 | gpt-4o-mini | Azure | GPT-4o Mini 轻量版 |
| 68 | gemini-3-pro-preview | Google | Gemini 3 Pro 预览版 |
| 70 | gemini-2.5-flash | Google | Gemini 2.5 Flash 快速版 |
| 71 | gemini-2.5-pro | Google | Gemini 2.5 Pro 专业版 |
| 74 | gpt-5.2 | Azure | GPT-5.2 模型 |
| 75 | gpt-5.2-chat | Azure | GPT-5.2 对话模型 |
| 77 | gpt-5.2-codex | Azure | GPT-5.2 代码生成模型 |

### 图像生成模型 (Image Generation)

| ID | 模型名称 | 供应商 | 说明 |
|----|---------|--------|------|
| 21 | gpt-image-1 | Azure | GPT 图像生成模型 |
| 23 | FLUX.1-Kontext-pro | Azure | FLUX.1 Kontext Pro 图像模型 |
| 58 | gemini-3-pro-image-preview | Google | Gemini 3 Pro 图像预览版 |
| 78 | hunyuan-image-v3.0 | 混元 | 混元最新文生图模型 |
| 80 | kling-image-o1 | 可灵 | 可灵图片O1，从基础图像生成到高阶细节编辑全链路无缝衔接 |
| 81 | hunyuan-image-all-in-one | 混元 | 混元参考生图大模型 |

### 视频生成模型 (Video Generation)

| ID | 模型名称 | 供应商 | 说明 |
|----|---------|--------|------|
| 22 | kling-v1 | 可灵 | 可灵视频 V1 |
| 24 | kling-v1-5 | 可灵 | 可灵视频 V1.5 |
| 25 | kling-v2-1 | 可灵 | 可灵视频 V2.1 |
| 69 | jimeng_t2v | 即梦 | 即梦各系列模型，用t2v省略代替 |
| 72 | kling-v2-6 | 可灵 | 可灵视频V2.6，音画同步生成，有声音更精彩 |
| 73 | vidu-q2 | Vidu | 长时长、高一致性、高动态性视频大模型 |
| 79 | hunyuan-video-v1.5 | 混元 | 混元最新文生视频和图生视频 |
| 82 | kling-video-o1 | 可灵 | 可灵视频O1，统一多模态视频模型，解锁无限创作可能 |

### 图像处理模型 (Midjourney 系列)

| ID | 模型名称 | 供应商 | 说明 |
|----|---------|--------|------|
| 26 | midjourney-v7 | 悠船 | Midjourney V7 |
| 66 | midjourney-v6 | 悠船 | Midjourney V6 |
| 67 | midjourney-niji6 | 悠船 | Midjourney Niji6 动漫风格 |

---

## 🔗 API 接口类型

### 1. Chat API (对话接口)

**文档**: `LLM+ChatAPI+模型接口.doc`

适用于：
- 多轮对话
- 流式输出
- 上下文管理

### 2. Response API (响应接口)

**文档**: `LLM+ResponseAPI+模型接口.doc`

适用于：
- 单次请求响应
- 批量处理
- 非流式输出

### 3. Nano Banana API

**文档**: `Nano+Banana+API+调用文档.doc`

适用于：
- 轻量级调用
- 快速响应场景

### 4. 混元 API

**文档**: `混元api使用文档.doc`

适用于：
- 混元系列模型调用
- 图像生成 (hunyuan-image-v3.0, hunyuan-image-all-in-one)
- 视频生成 (hunyuan-video-v1.5)

---

## 📊 模型供应商分类

### Azure (微软)
- GPT 系列 (gpt-4.1, gpt-4o, gpt-5, gpt-5.2 等)
- GPT 图像模型 (gpt-image-1)
- FLUX 模型 (FLUX.1-Kontext-pro)

### Google
- Gemini 系列 (gemini-2.5-flash, gemini-2.5-pro, gemini-3-pro-preview)
- Gemini 图像模型 (gemini-3-pro-image-preview)

### 可灵
- Kling 视频系列 (kling-v1, kling-v1-5, kling-v2-1, kling-v2-6)
- Kling 图像模型 (kling-image-o1)
- Kling 视频O1 (kling-video-o1)

### 混元
- 混元图像模型 (hunyuan-image-v3.0, hunyuan-image-all-in-one)
- 混元视频模型 (hunyuan-video-v1.5)

### 悠船
- Midjourney 系列 (midjourney-v6, midjourney-v7, midjourney-niji6)

### Vidu
- Vidu 视频模型 (vidu-q2)

### 即梦
- 即梦 T2V 模型 (jimeng_t2v)

---

## 📝 备注

- 详细的 API 调用参数和示例请参考 `APIDoc/` 目录下的原始文档
- 模型 ID 用于 API 调用时指定具体使用的模型
- 部分模型可能需要特定权限才能访问
