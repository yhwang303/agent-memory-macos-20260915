#!/usr/bin/env bash
# ============================================================================
# agent-memory 端到端冒烟测试
#
# 覆盖：CLI · doctor · worker · session/observation/summary 写入读取 ·
#       search · sync 队列状态 · OpenClaw installer · MCP server stdio
#
# 用法：
#   chmod +x e2e-smoke-test.sh
#   ./e2e-smoke-test.sh                       # 仅本地，不测远端同步
#   REMOTE_URL=http://x:8848 REMOTE_TOKEN=xxx ./e2e-smoke-test.sh   # 含同步
# ============================================================================
set -e

WORKER_URL="http://127.0.0.1:3847"
PROJECT="e2e-smoke-test"
SESSION_ID="smoke-$(date +%s)"
PASS=0
FAIL=0

ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo ""; echo "=== $1 ==="; }

# ----------------------------------------------------------------------------
step "1. 检查 CLI 入口"
# ----------------------------------------------------------------------------
agent-memory --version | grep -q "^[0-9]" && ok "agent-memory --version" || fail "agent-memory --version"
which agent-memory-worker > /dev/null && ok "agent-memory-worker on PATH" || fail "agent-memory-worker missing"
which agent-memory-mcp    > /dev/null && ok "agent-memory-mcp on PATH"    || fail "agent-memory-mcp missing"
which agent-memory-hooks  > /dev/null && ok "agent-memory-hooks on PATH"  || fail "agent-memory-hooks missing"

# ----------------------------------------------------------------------------
step "2. doctor 自检"
# ----------------------------------------------------------------------------
agent-memory doctor > /tmp/doctor.txt 2>&1
grep -q "Node.js"      /tmp/doctor.txt && ok "doctor: Node.js"      || fail "doctor: Node.js"
grep -q "SQLite"       /tmp/doctor.txt && ok "doctor: SQLite"       || fail "doctor: SQLite"
grep -q "Device ID"    /tmp/doctor.txt && ok "doctor: Device ID"    || fail "doctor: Device ID"
grep -q "IDE detected" /tmp/doctor.txt && ok "doctor: IDE detected" || fail "doctor: IDE detected"

# ----------------------------------------------------------------------------
step "3. 启动 worker"
# ----------------------------------------------------------------------------
[ -n "$REMOTE_URL" ] && export CODEBUDDY_MEM_REMOTE_URL=$REMOTE_URL
[ -n "$REMOTE_TOKEN" ] && export CODEBUDDY_MEM_REMOTE_TOKEN=$REMOTE_TOKEN

agent-memory worker start || true
sleep 2
curl -sf $WORKER_URL/health > /dev/null && ok "worker /health 200" || fail "worker /health"

# ----------------------------------------------------------------------------
step "4. 写入 session + observation + summary"
# ----------------------------------------------------------------------------
curl -sf -X POST $WORKER_URL/api/session/start \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\",\"project\":\"$PROJECT\",\"user_prompt\":\"e2e test\"}" \
  > /dev/null && ok "session/start" || fail "session/start"

curl -sf -X POST $WORKER_URL/api/observation \
  -H 'Content-Type: application/json' \
  -d "{
    \"session_id\":\"$SESSION_ID\",
    \"project\":\"$PROJECT\",
    \"text\":\"e2e smoke test observation - searching for unique-token-$SESSION_ID\",
    \"type\":\"action\",
    \"title\":\"e2e smoke obs\",
    \"source_ide\":\"e2e\"
  }" > /dev/null && ok "observation 写入" || fail "observation 写入"

curl -sf -X POST $WORKER_URL/api/session/end \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\"}" \
  > /dev/null && ok "session/end (触发 summary 生成)" || fail "session/end"

# ----------------------------------------------------------------------------
step "5. 查询 / Viewer"
# ----------------------------------------------------------------------------
curl -sf "$WORKER_URL/api/search_like?q=unique-token-$SESSION_ID" | grep -q "$SESSION_ID" \
  && ok "search_like 命中刚写入的 observation" || fail "search_like"

curl -sf "$WORKER_URL/api/viewer/sessions?project=$PROJECT" | grep -q "$SESSION_ID" \
  && ok "viewer/sessions 列出 session" || fail "viewer/sessions"

curl -sf "$WORKER_URL/api/viewer/projects" | grep -q "$PROJECT" \
  && ok "viewer/projects 列出 project" || fail "viewer/projects"

curl -sf "$WORKER_URL/api/timeline?project=$PROJECT&limit=5" > /dev/null \
  && ok "timeline" || fail "timeline"

curl -sf "$WORKER_URL/api/context/inject?project=$PROJECT&limit=5" > /dev/null \
  && ok "context/inject (OpenClaw 用)" || fail "context/inject"

curl -sf "$WORKER_URL/api/export/markdown?project=$PROJECT" | grep -q "#" \
  && ok "export/markdown" || fail "export/markdown"

# ----------------------------------------------------------------------------
step "6. 远程同步状态"
# ----------------------------------------------------------------------------
SYNC_STATUS=$(curl -sf $WORKER_URL/api/sync/status)
echo "$SYNC_STATUS" | grep -q "queue"    && ok "sync/status 返回 queue 字段"   || fail "sync/status queue"
echo "$SYNC_STATUS" | grep -q "backfill" && ok "sync/status 返回 backfill 字段" || fail "sync/status backfill"
echo "$SYNC_STATUS" | grep -q "remote"   && ok "sync/status 返回 remote 字段"   || fail "sync/status remote"

if [ -n "$REMOTE_URL" ] && [ -n "$REMOTE_TOKEN" ]; then
  TEST_RESULT=$(curl -sf -X POST $WORKER_URL/api/sync/test)
  echo "$TEST_RESULT" | grep -q '"ok":true' \
    && ok "sync/test → 远端 /whoami 鉴权通过" \
    || fail "sync/test 鉴权失败：$TEST_RESULT"

  curl -sf -X POST $WORKER_URL/api/sync/rescan > /dev/null && ok "sync/rescan 触发补传" || fail "sync/rescan"
  sleep 5
  AFTER=$(curl -sf $WORKER_URL/api/sync/status)
  echo "  → 同步状态: $AFTER"
else
  echo "  [SKIP] 未配置 REMOTE_URL/REMOTE_TOKEN，跳过远端同步实测"
fi

# ----------------------------------------------------------------------------
step "7. OpenClaw 集成"
# ----------------------------------------------------------------------------
agent-memory install openclaw > /tmp/oc.txt 2>&1 \
  && ok "install openclaw" || fail "install openclaw: $(cat /tmp/oc.txt)"

[ -f "$HOME/.openclaw/plugins/agent-memory/config.json" ] \
  && ok "OpenClaw 配置文件已写入 ~/.openclaw/plugins/agent-memory/config.json" \
  || fail "OpenClaw 配置文件缺失"

agent-memory status | grep -q "openclaw" && ok "status 列出 openclaw" || fail "status openclaw"

# 模拟 OpenClaw before_agent_start hook 实际行为
OC_SESSION="oc-$(date +%s)"
curl -sf -X POST $WORKER_URL/api/session/start \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$OC_SESSION\",\"project\":\"openclaw-gateway\",\"metadata\":{\"source\":\"openclaw\"}}" \
  > /dev/null && ok "模拟 OpenClaw session/start" || fail "OpenClaw session/start"

# ----------------------------------------------------------------------------
step "8. MCP Server stdio (3 秒探活)"
# ----------------------------------------------------------------------------
timeout 3 agent-memory-mcp < /dev/null > /tmp/mcp.txt 2>&1 || true
grep -qi "search server started" /tmp/mcp.txt \
  && ok "MCP server 启动日志正常" \
  || fail "MCP server 启动失败：$(head -3 /tmp/mcp.txt)"

# ----------------------------------------------------------------------------
step "9. 优雅停止"
# ----------------------------------------------------------------------------
agent-memory worker stop > /dev/null 2>&1 && ok "worker stop 干净退出" || fail "worker stop"
sleep 1
curl -sf $WORKER_URL/health > /dev/null 2>&1 && fail "worker 仍在响应" || ok "worker 端口释放"

# ----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  通过 $PASS 项 / 失败 $FAIL 项"
echo "============================================================"
exit $FAIL
