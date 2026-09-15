# 06 · npm 版能装、App 版扫不到 OpenClaw

## 现象
- 用 `agent-memory install openclaw` 命令（npm 全局包）一切正常。
- 但用打包后的桌面 App，「OpenClaw 关联」一直显示"未检测到"，点击安装也没动作。

## 根本原因
- 桌面 App 启动时的 `PATH` 环境变量与终端不一样：
  - 终端会加载 `~/.zshrc`，自动包含 `/opt/homebrew/bin`、`~/.npm-global/bin` 等。
  - 但 macOS 直接双击启动的 App 拿到的是系统初始 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），找不到 `openclaw` CLI。
- `OpenClawInstaller.runOpenClaw` 只调用 `openclaw`，没指定绝对路径，于是 `execFileSync` 直接抛 ENOENT；安装失败但被吞进 warnings，UI 误以为"啥都没发生"。

## 解决
1. `OpenClawInstaller.getOpenClawBinary()` 维护候选路径列表，按优先级查找：
   - PATH 里直接 which。
   - `/opt/homebrew/bin/openclaw`、`/usr/local/bin/openclaw`。
   - `~/.npm-global/bin/openclaw`、`~/.local/bin/openclaw`。
2. 找到才调用，找不到直接抛 `OpenClaw CLI not found` 让 UI 看到。

## 待办
- 进一步把"CLI 未找到"和"CLI 调用失败"区分开，UI 上指引用户安装/配置 PATH，而不是只显示一个 warning。

## 教训
- macOS 桌面 App 启动环境与终端差异巨大，不能假设任何用户级 CLI 在 PATH 里。
- 调用外部 CLI 一定要先做"探测+绝对路径解析"，并在失败时给出明确指引。
