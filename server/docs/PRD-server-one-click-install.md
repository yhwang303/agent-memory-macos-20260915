# PRD：服务端一键安装部署

> 版本: 1.0.0
> 最后更新: 2026-04-19
> 状态: 草案
> 关联 PRD: PRD-cross-device-memory-sync.md, PRD-server-admin-multiuser.md

---

## 一、背景与动机

### 1.1 现状

`agent-mem-server` 已具备完整的后端功能（同步接收、聚合查询、Markdown 导出、管理后台），并提供了 `Dockerfile` 和 `docker-compose.yml`。但目前的部署流程是：

1. 用户需要 `git clone` 源码仓库
2. 手动 `docker build` 或 `docker-compose up`
3. 手动设置环境变量（`SHARED_TOKEN`、`ADMIN_PASSWORD` 等）
4. 自行处理开机自启、端口放行等运维细节

### 1.2 痛点

1. **前置知识高**：用户需要会 `git clone`、理解 Dockerfile、知道 `docker build` 和 `docker run` 的区别
2. **没有预构建镜像**：镜像没有发布到任何公开仓库，用户必须自己编译
3. **配置分散**：Token、端口、数据目录等需要手动传环境变量，一个漏了服务就起不来
4. **运维无工具**：重启、更新、备份、卸载全靠用户自己记 Docker 命令
5. **README 空白**：用户拿到仓库不知道怎么用

### 1.3 目标体验

对标 1Panel / x-ui 的安装体验 —— 用户在服务器上执行一行命令，全程自动完成，结束后看到访问地址和密码，打开浏览器就能用。

---

## 二、目标用户

| 角色 | 描述 | 技术水平 |
|:---|:---|:---|
| **自部署用户** | 有一台 Linux 服务器（阿里云/腾讯云/VPS/NAS），想把 agent-mem-server 跑在自己机器上 | 会 SSH 登录、会复制粘贴命令，但**不会**写 Dockerfile、不懂 docker build |

---

## 三、用户场景

### 场景 1：首次安装

> 小明买了一台阿里云 ECS（Ubuntu 22.04），SSH 登录后执行：
>
> ```bash
> bash <(curl -fsSL https://raw.githubusercontent.com/Be1Human/AgentMem_Backend/master/install.sh)
> ```
>
> 屏幕输出安装进度，1～2 分钟后看到：
>
> ```
> ✓ 安装完成！
>   访问地址: http://47.96.xx.xx:8848/admin
>   管理密码: Xk7p9mQ2
> ```
>
> 小明打开浏览器，用这个密码登录后台，创建用户、生成 Token，复制到客户端。

### 场景 2：日常运维

> 过了几天，小明想看下服务状态：
>
> ```bash
> amem status
> ```
>
> 输出：
>
> ```
> agent-mem-server v1.0.0
> 状态: 运行中
> 端口: 8848
> 数据目录: /opt/agent-mem/data
> 数据库大小: 12.3 MB
> 运行时长: 3天12小时
> ```

### 场景 3：升级到新版

> 我们发布了新版本，小明执行：
>
> ```bash
> amem update
> ```
>
> 自动拉取最新镜像、停旧容器、启新容器，数据不丢失。

### 场景 4：备份数据

> 小明要迁移服务器，先备份：
>
> ```bash
> amem backup
> ```
>
> 输出：
>
> ```
> ✓ 已备份到 /opt/agent-mem/backups/backup-20260419-143000.tar.gz
> ```

### 场景 5：卸载

> 小明不想用了：
>
> ```bash
> amem uninstall
> ```
>
> 询问"是否保留数据？"，确认后清理容器和命令。

---

## 四、功能性需求

### FR-1：预构建 Docker 镜像自动发布

- FR-1.1：GitHub Actions 在 push tag（`v*`）时自动构建 Docker 镜像
- FR-1.2：构建 `linux/amd64` 和 `linux/arm64` 双架构镜像
- FR-1.3：推送到 Docker Hub（`be1huamn/agentmem-backend`）
- FR-1.4：同时推送到 GitHub Container Registry（`ghcr.io/be1human/agentmem-backend`）作为备用源
- FR-1.5：latest 标签跟随最新 release 自动更新

### FR-2：一键安装脚本 install.sh

- FR-2.1：通过 `bash <(curl -fsSL URL)` 执行，不需要用户先 clone 仓库
- FR-2.2：自动检测操作系统和架构（Ubuntu/Debian/CentOS/Alpine，amd64/arm64）
- FR-2.3：检测 Docker 是否已安装，未安装则自动安装（使用官方安装脚本）
- FR-2.4：国内网络自动识别并切换到国内镜像源（Docker Hub 镜像加速 + 阿里云 ACR）
- FR-2.5：交互式询问端口号（默认 8848）
- FR-2.6：自动生成随机 ADMIN_PASSWORD 并展示给用户
- FR-2.7：创建数据目录 `/opt/agent-mem/data`
- FR-2.8：`docker run` 启动容器，设置 `--restart unless-stopped` 开机自启
- FR-2.9：安装 `amem` 命令到 `/usr/local/bin/`
- FR-2.10：安装结束输出访问地址、管理密码、数据目录等关键信息
- FR-2.11：全程有清晰的步骤提示（`[1/5] 检测系统...`）

### FR-3：amem 运维命令

- FR-3.1：`amem status` — 显示容器运行状态、端口、版本、数据库大小、运行时长
- FR-3.2：`amem logs` — 查看容器日志（默认最近 100 行，支持 `-f` 实时跟踪）
- FR-3.3：`amem restart` — 重启容器
- FR-3.4：`amem update` — 拉取最新镜像、停旧容器、以相同参数启新容器
- FR-3.5：`amem backup` — 将数据目录打包为 `.tar.gz`，存放到 `/opt/agent-mem/backups/`
- FR-3.6：`amem uninstall` — 停止并删除容器、可选保留/删除数据、删除 amem 命令自身

### FR-4：README 改造

- FR-4.1：README 第一屏只放一行安装命令 + 一句话介绍
- FR-4.2：下方简要说明安装后的运维命令
- FR-4.3：提供 docker-compose.yml 方式作为备选
- FR-4.4：包含客户端配置说明（如何把 Token 配到 agent-memory）

---

## 五、非功能性需求

### NFR-1：安装耗时

- 首次安装（含安装 Docker）：< 3 分钟（国内网络）
- 已有 Docker 环境：< 1 分钟

### NFR-2：兼容性

- 支持 Ubuntu 20.04+、Debian 10+、CentOS 7+
- 支持 amd64 和 arm64 架构
- 需要 root 或 sudo 权限

### NFR-3：幂等性

- 重复执行 install.sh 不会破坏已有安装和数据
- 检测到已安装时提示并询问是否重装/升级

### NFR-4：安全

- 初始密码随机生成，不使用固定默认密码
- 安装脚本不收集任何用户信息
- 所有下载地址均为 HTTPS

---

## 六、交付清单

| 序号 | 产物 | 存放位置 |
|:---|:---|:---|
| 1 | GitHub Actions 工作流 | `agent-mem-server/.github/workflows/docker-publish.yml` |
| 2 | 一键安装脚本 | `agent-mem-server/install.sh` |
| 3 | amem 运维命令脚本 | `agent-mem-server/amem.sh`（安装时复制到 `/usr/local/bin/amem`） |
| 4 | 更新后的 README | `agent-mem-server/README.md` |

---

## 七、成功指标

| 指标 | 目标 |
|:---|:---|
| 安装步骤 | 用户只需执行 1 行命令 |
| 安装耗时 | 全新 Ubuntu 服务器 < 3 分钟 |
| 安装成功率 | Ubuntu 22.04 / Debian 12 首次成功率 > 95% |
| 后续运维 | 升级/备份/卸载各 1 行命令 |
| 用户需要的前置知识 | 会 SSH 登录、会复制粘贴 |
