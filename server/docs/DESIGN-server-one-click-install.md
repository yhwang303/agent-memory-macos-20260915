# 设计文档：服务端一键安装部署

> 版本: 1.0.0
> 最后更新: 2026-04-19
> 对应 PRD: PRD-server-one-click-install.md

---

## 一、整体流程

```
开发者推 tag                  用户在自己服务器执行一行命令
────────────                  ──────────────────────────
    │                               │
    ▼                               ▼
GitHub Actions                 curl 下载 install.sh
    │                               │
    ├─ docker buildx              检测系统 / 架构
    │  (amd64 + arm64)              │
    │                             Docker 是否已装?
    ├─ push Docker Hub               │
    │  be1huamn/agentmem-backend   N: 自动安装 Docker
    │                               │
    └─ push GHCR                  docker pull 拉镜像
       ghcr.io/be1human/            │
       agentmem-backend           docker run 启动容器
                                    │
                                  写入 amem 命令
                                    │
                                  输出访问地址 + 密码
```

---

## 二、GitHub Actions 工作流

### 2.1 文件位置

`.github/workflows/docker-publish.yml`

### 2.2 触发条件

```yaml
on:
  push:
    tags:
      - 'v*'
```

### 2.3 核心步骤

```yaml
jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-qemu-action@v3

      - uses: docker/setup-buildx-action@v3

      # 登录 Docker Hub
      - uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      # 登录 GHCR
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # 提取版本号
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: |
            be1huamn/agentmem-backend
            ghcr.io/be1human/agentmem-backend
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest

      # 构建并推送
      - uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### 2.4 需要配置的 Secrets

在 GitHub 仓库 Settings → Secrets 中添加：

| Secret 名 | 来源 |
|:---|:---|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名：`be1huamn` |
| `DOCKERHUB_TOKEN` | Docker Hub → Account Settings → Security → New Access Token |

GHCR 使用 `GITHUB_TOKEN`，无需额外配置。

---

## 三、install.sh 脚本设计

### 3.1 变量定义

```bash
CONTAINER_NAME="agent-mem-server"
IMAGE="be1huamn/agentmem-backend:latest"
IMAGE_CN="registry.cn-hangzhou.aliyuncs.com/be1huamn/agentmem-backend:latest"  # 预留国内源
DATA_DIR="/opt/agent-mem/data"
BACKUP_DIR="/opt/agent-mem/backups"
DEFAULT_PORT=8848
AMEM_BIN="/usr/local/bin/amem"
```

### 3.2 执行流程

```
[1/6] 检测系统环境
  ├─ 检测 OS（Ubuntu/Debian/CentOS/Alpine）
  ├─ 检测架构（amd64/arm64）
  └─ 检测是否 root（非 root 提示使用 sudo）

[2/6] 检测已有安装
  ├─ docker ps 检查是否已有 agent-mem-server 容器
  └─ 如已存在 → 询问"升级/重装/退出"

[3/6] 安装 Docker（如需要）
  ├─ command -v docker 检测
  ├─ 未安装 → curl -fsSL https://get.docker.com | sh
  └─ 启动 Docker 服务：systemctl enable --now docker

[4/6] 拉取镜像
  ├─ 先尝试 docker pull $IMAGE
  ├─ 超时/失败 → 自动切换国内源 $IMAGE_CN
  └─ 显示进度

[5/6] 启动容器
  ├─ 生成随机 ADMIN_PASSWORD（16 位字母数字）
  ├─ 询问端口号（默认 8848，直接回车使用默认）
  ├─ mkdir -p $DATA_DIR $BACKUP_DIR
  └─ docker run -d \
       --name $CONTAINER_NAME \
       --restart unless-stopped \
       -p $PORT:8848 \
       -e ADMIN_PASSWORD=$ADMIN_PASSWORD \
       -v $DATA_DIR:/data \
       $IMAGE

[6/6] 安装 amem 命令
  ├─ 生成 amem 脚本到 /usr/local/bin/amem
  ├─ chmod +x
  └─ 将端口号、数据目录等信息写入 /opt/agent-mem/.env（供 amem 读取）
```

### 3.3 安装结束输出

```
═══════════════════════════════════════════════════
  agent-mem-server 安装成功！
═══════════════════════════════════════════════════
  访问地址:  http://<服务器IP>:8848/admin
  管理密码:  Xk7p9mQ2aB3cD4eF
  数据目录:  /opt/agent-mem/data
═══════════════════════════════════════════════════

  运维命令:
    amem status      查看状态
    amem logs        查看日志
    amem restart     重启服务
    amem update      升级到最新版
    amem backup      备份数据库
    amem uninstall   卸载

  请保存好管理密码！
═══════════════════════════════════════════════════
```

### 3.4 国内网络检测

```bash
is_china() {
  # 尝试访问 Google DNS，超时 2 秒即判定为国内网络
  if ! curl -s --connect-timeout 2 https://www.google.com > /dev/null 2>&1; then
    return 0  # 是国内
  fi
  return 1
}
```

### 3.5 自动获取服务器公网 IP

```bash
get_public_ip() {
  curl -s --connect-timeout 3 ifconfig.me 2>/dev/null \
    || curl -s --connect-timeout 3 icanhazip.com 2>/dev/null \
    || curl -s --connect-timeout 3 ip.sb 2>/dev/null \
    || echo "<服务器IP>"
}
```

### 3.6 幂等保护

- 检测 `/usr/local/bin/amem` 是否已存在
- 检测 Docker 容器 `agent-mem-server` 是否已存在
- 已存在时提示三个选项：
  - `[U] 升级` — 拉新镜像、停旧容器、启新容器（保留数据）
  - `[R] 重装` — 删掉旧容器、重新创建（保留数据）
  - `[Q] 退出`

---

## 四、amem 运维命令设计

### 4.1 实现方式

`amem` 是一个 Bash 脚本，安装时写入 `/usr/local/bin/amem`。它读取 `/opt/agent-mem/.env` 获取配置（容器名、端口、数据目录等），然后调用对应的 Docker 命令。

### 4.2 配置文件

```bash
# /opt/agent-mem/.env
CONTAINER_NAME=agent-mem-server
IMAGE=be1huamn/agentmem-backend:latest
PORT=8848
DATA_DIR=/opt/agent-mem/data
BACKUP_DIR=/opt/agent-mem/backups
ADMIN_PASSWORD=Xk7p9mQ2aB3cD4eF
```

### 4.3 各子命令实现

#### amem status

```bash
status() {
  if docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}' | grep -q "Up"; then
    echo "agent-mem-server"
    echo "状态: 运行中"
    echo "端口: $PORT"
    echo "数据目录: $DATA_DIR"
    # 数据库文件大小
    if [ -f "$DATA_DIR/agent-mem.db" ]; then
      echo "数据库大小: $(du -sh "$DATA_DIR/agent-mem.db" | cut -f1)"
    fi
    # 运行时长
    echo "运行时长: $(docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}')"
    # 镜像版本
    echo "镜像: $(docker inspect --format '{{.Config.Image}}' $CONTAINER_NAME)"
  else
    echo "agent-mem-server 未运行"
  fi
}
```

#### amem logs

```bash
logs() {
  if [ "$1" = "-f" ]; then
    docker logs -f --tail 100 $CONTAINER_NAME
  else
    docker logs --tail 100 $CONTAINER_NAME
  fi
}
```

#### amem restart

```bash
restart() {
  docker restart $CONTAINER_NAME
  echo "✓ 已重启"
}
```

#### amem update

```bash
update() {
  echo "拉取最新镜像..."
  docker pull $IMAGE
  echo "停止旧容器..."
  docker stop $CONTAINER_NAME
  docker rm $CONTAINER_NAME
  echo "启动新容器..."
  docker run -d \
    --name $CONTAINER_NAME \
    --restart unless-stopped \
    -p $PORT:8848 \
    -e ADMIN_PASSWORD=$ADMIN_PASSWORD \
    -v $DATA_DIR:/data \
    $IMAGE
  echo "✓ 已升级到最新版"
}
```

#### amem backup

```bash
backup() {
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_FILE="$BACKUP_DIR/backup-$TIMESTAMP.tar.gz"
  mkdir -p "$BACKUP_DIR"
  tar -czf "$BACKUP_FILE" -C "$DATA_DIR" .
  echo "✓ 已备份到 $BACKUP_FILE"
}
```

#### amem uninstall

```bash
uninstall() {
  read -p "是否保留数据? [Y/n] " keep_data
  docker stop $CONTAINER_NAME 2>/dev/null
  docker rm $CONTAINER_NAME 2>/dev/null
  if [ "$keep_data" = "n" ] || [ "$keep_data" = "N" ]; then
    rm -rf /opt/agent-mem
    echo "✓ 已卸载，数据已删除"
  else
    echo "✓ 已卸载，数据保留在 $DATA_DIR"
  fi
  rm -f /usr/local/bin/amem
  rm -f /opt/agent-mem/.env
}
```

---

## 五、README 结构

```markdown
# AgentMem Backend

跨设备 AI 编程记忆聚合服务，一行命令部署到你自己的服务器。

## 安装

bash <(curl -fsSL https://raw.githubusercontent.com/Be1Human/AgentMem_Backend/master/install.sh)

安装完成后访问 http://你的IP:8848/admin

## 运维命令

| 命令 | 功能 |
|:---|:---|
| amem status | 查看状态 |
| amem logs | 查看日志 |
| amem update | 升级 |
| amem backup | 备份 |
| amem uninstall | 卸载 |

## 客户端配置

在 agent-memory 客户端的 .env.local 中添加：

CODEBUDDY_MEM_REMOTE_URL=http://你的IP:8848
CODEBUDDY_MEM_REMOTE_TOKEN=你的Token

## Docker Compose（备选）

docker-compose up -d

## License

MIT
```

---

## 六、文件清单与职责

| 文件 | 行数估算 | 职责 |
|:---|:---|:---|
| `.github/workflows/docker-publish.yml` | ~60 行 | tag 触发 → 构建双架构镜像 → 推送 Docker Hub + GHCR |
| `install.sh` | ~200 行 | 一键安装：检测环境 → 装 Docker → 拉镜像 → 启容器 → 装 amem 命令 |
| `amem.sh` | ~150 行 | 运维命令脚本：status / logs / restart / update / backup / uninstall |
| `README.md` | ~80 行 | 用户文档：安装命令 + 运维 + 客户端配置 |

---

## 七、发布流程

开发者每次发版的操作：

```bash
# 1. 确保代码就绪
git add .
git commit -m "feat: xxx"

# 2. 打版本 tag
git tag v1.0.0
git push github master --tags

# 3. GitHub Actions 自动执行：
#    - 构建 linux/amd64 + linux/arm64 镜像
#    - 推送到 Docker Hub: be1huamn/agentmem-backend:1.0.0 + :latest
#    - 推送到 GHCR: ghcr.io/be1human/agentmem-backend:1.0.0 + :latest
#
# 4. 用户执行 amem update 即可拿到新版
```

---

## 八、后续扩展（不在本期）

| 项目 | 说明 |
|:---|:---|
| 阿里云 ACR 镜像同步 | 在 GitHub Actions 中增加阿里云 ACR 推送步骤，国内拉取更快 |
| install.ps1 | Windows Server 版安装脚本（PowerShell） |
| 宝塔 / 1Panel 应用模板 | 提交到面板应用商店，面板内一键安装 |
| 单文件二进制 | 用 `bun build --compile` 打包成单个可执行文件，无需 Docker |
| 自动 HTTPS | 安装时可选配置域名，内置 Caddy 自动签 Let's Encrypt 证书 |
