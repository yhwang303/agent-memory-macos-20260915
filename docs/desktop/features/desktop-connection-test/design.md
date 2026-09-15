# 桌面端连通性测试设计

## 总体方案

在桌面端主进程增加一个独立的 `ConnectionTester`，通过 IPC 暴露给设置页：

```text
settings.html
  -> preload-settings.ts
  -> SettingsWindow IPC: settings:test-connection
  -> ConnectionTester.test(configLike)
  -> 返回 success / message
```

## 设计原则

1. **使用当前表单值测试**，不依赖已保存配置
2. **尽量复用 Worker 实际调用语义**
3. **不要求先重启 Worker**
4. **错误信息可读**

## 文件改动

| 文件 | 改动 |
|------|------|
| `desktop/src/config/connectionTester.ts` | 新增，执行 provider 连通性测试 |
| `desktop/src/windows/SettingsWindow.ts` | 新增 IPC：`settings:test-connection` |
| `desktop/src/preload-settings.ts` | 暴露 `testConnection()` |
| `desktop/src/windows/settings.html` | 新增按钮、状态区、交互逻辑 |

## 测试接口设计

### IPC 入参

```ts
{
  apiProvider: 'timiai' | 'openai' | 'anthropic';
  apiKey?: string;
  apiModel?: string;
}
```

### IPC 返回

```ts
{
  success: boolean;
  message: string;
}
```

## ConnectionTester 设计

### API Provider

行为：

- 构造与 Worker 类似的最小请求
- endpoint 继续使用当前默认 OpenAI 兼容接口
- prompt 使用：`Reply with just "OK" to confirm connection.`
- 若响应成功且有内容，则视为通过

## UI 设计

### 新增按钮

- `测试连通性`

### 新增状态区域

展示三种状态：

- 测试中
- 成功
- 失败

### 交互细节

- 点击按钮时禁用按钮，防止重复提交
- 成功显示绿色提示
- 失败显示红色提示
- provider 切换时保留最近一次状态，直到下次测试覆盖

## 验证方案

1. API provider 输入正确值，点击测试，返回成功
2. API provider 输入错误 Key，点击测试，返回失败

> **注意**：原文档中的 Claude Code provider 连通性测试部分已移除。
> Claude Code 不作为 API Provider，而是作为 IDE 接入。
> IDE 的"连通性"通过 hooks 注册是否成功来验证，无需单独的连通性测试。
