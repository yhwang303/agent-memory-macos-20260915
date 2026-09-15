# AI Monitor 安装与使用指南

## 1. 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 / 11（64位） |
| Python | 3.10 或更高版本 |
| 网络 | 需要能访问 LLM API（OpenAI 兼容接口） |
| 内存 | 建议 4GB 以上 |

---

## 2. 安装 Python

如果尚未安装 Python，请前往官网下载：

> https://www.python.org/downloads/

安装时勾选 **"Add Python to PATH"**，安装完成后在命令行验证：

```
python --version
```

能看到版本号（如 `Python 3.12.x`）即为成功。

---

## 3. 解压项目

将 `ai_monitor_release.zip` 解压到任意目录，例如：

```
D:\ai_monitor\
```

解压后目录结构如下：

```
ai_monitor/
├── config/
│   └── settings.yaml       # 运行配置（可按需修改）
├── docs/
├── src/                    # 源码（无需修改）
├── requirements.txt        # Python 依赖清单
├── start.bat               # 一键启动脚本
└── .env.example            # 环境变量模板
```

---

## 4. 配置 API Key

进入解压目录，将 `.env.example` 复制一份并重命名为 `.env`：

```
copy .env.example .env
```

用记事本打开 `.env`，填入你的 LLM API 信息：

```
# LLM API 基础地址（支持 OpenAI 格式的接口均可）
AI_MONITOR_BASE_URL=https://api.openai.com/v1

# 你的 API Key
AI_MONITOR_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxx
```

> 如使用国内中转服务，将 `AI_MONITOR_BASE_URL` 改为对应中转地址即可。

---

## 5. 安装 Python 依赖

在解压目录下打开命令行（按住 Shift + 右键 → "在此处打开 PowerShell 窗口"），执行：

```
pip install -r requirements.txt
```

等待安装完成（首次安装时间较长，约 3~10 分钟，取决于网络速度）。

> 若下载速度慢，可使用国内镜像加速：
> ```
> pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
> ```

---

## 6. 启动程序

在解压目录下，**双击 `start.bat`** 即可启动。

启动后会弹出两个黑色命令行窗口：
- **AI Monitor - Capture**：屏幕采集服务（负责截图、OCR、AI分析）
- **AI Monitor - Web**：Web 查看界面服务

等待几秒后，用浏览器打开：

> http://127.0.0.1:8080

即可看到监控界面。

---

## 7. 配置说明（可选）

`config/settings.yaml` 包含运行参数，可按需调整：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `perception.check_interval` | 屏幕检测间隔（秒） | 5.0 |
| `perception.change_threshold` | 触发截图的变化阈值（0~1，越小越灵敏） | 0.02 |
| `perception.monitor_indices` | 监控的显示器编号（1=主屏，0=全屏拼接） | [1] |
| `perception.force_capture_interval` | 强制截图间隔（秒，无变化时也截图） | 60.0 |
| `agent.llm.model` | 使用的 LLM 模型名称 | gemini-3.1-pro-preview |
| `storage.max_retention_days` | 数据保留天数 | 30 |
| `privacy.excluded_processes` | 不监控的进程名（隐私保护） | KeePass.exe 等 |

---

## 8. 停止程序

关闭两个黑色命令行窗口即可停止所有服务。数据已自动保存在 `data/` 目录下，下次启动时会继续累积。

---

## 9. 常见问题

**Q：双击 start.bat 提示"未设置 AI_MONITOR_API_KEY"**

A：检查是否已正确创建 `.env` 文件，并填入了 `AI_MONITOR_API_KEY`。注意文件名是 `.env`，不是 `.env.example`。

---

**Q：pip install 安装失败，提示网络错误**

A：使用国内镜像重试：
```
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

---

**Q：浏览器打开 http://127.0.0.1:8080 显示"无法访问"**

A：等待 5~10 秒再刷新，Web 服务启动需要一点时间。若仍无法访问，检查 `AI Monitor - Web` 窗口中是否有报错信息。

---

**Q：想监控多个显示器怎么办**

A：编辑 `config/settings.yaml`，将 `monitor_indices` 改为 `[0]` 可拼接全部屏幕一起监控；若想单独监控每块屏幕，填多个索引如 `[1, 2]`。修改后重启程序生效。
