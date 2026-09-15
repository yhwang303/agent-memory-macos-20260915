# 02 · 未签名 DMG 打开提示"已损坏/无法打开"

## 现象
- 双击 `AgentMemory-2.0.2-mac-arm64.dmg` 安装后启动，提示"已损坏，无法打开"或"无法验证开发者"。
- 直接拖进 Applications 也一样。

## 根本原因
- DMG 没有 Apple Developer ID 签名，也没有公证（notarization）。
- macOS 的 **Gatekeeper + quarantine 属性**会对从浏览器/外部介质带过来的应用直接拦截，即使二进制本身正常。

## 临时解决
- 终端去掉 quarantine 属性即可启动：
  ```bash
  xattr -dr com.apple.quarantine /Applications/AgentMemory.app
  ```
- 或在「系统设置 → 隐私与安全性」里点"仍要打开"。

## 长期方案
- 申请 Apple Developer ID 证书 → `electron-builder` 配置 `mac.identity` → 公证（`notarize`）后，分发的 DMG 不再触发 Gatekeeper 警告。
- 在没签名前，发布说明里要写明"首次启动需要去 quarantine"的步骤，避免重复求助。

## 教训
- 内部测试包可以容忍未签名，但要把启动指引写进 README/发布说明。
- 一旦走向外部分发，签名 + 公证是硬要求，不能再靠用户手敲 `xattr`。
