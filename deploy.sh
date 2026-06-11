#!/usr/bin/env bash
# =============================================================================
# OpenClaw Agent Mind — 一键部署脚本
# 用法:
#   1) 设置环境变量 → 运行脚本
#   2) 脚本会提示你输入缺失的配置
#
# 环境变量:
#   MIND_LLM_API_KEY      — LLM API Key (必填)
#   LLM_MODEL             — 模型名 (默认: doubao-seed-2.0-lite)
#   LLM_BASE_URL          — API 地址 (默认: https://ark.cn-beijing.volces.com/api/coding/v3)
#   GATEWAY_TOKEN          — 控制台密码 (默认: 自动生成)
#   QQ_APP_ID             — QQ 机器人 AppID (可选)
#   QQ_CLIENT_SECRET      — QQ 机器人密钥 (可选)
#   PERSONA_CHAT_FILE      — 聊天记录路径 (可选，跳过人格导入)
#   PERSONA_TARGET         — 分析目标人名 (需要 PERSONA_CHAT_FILE)
#   PERSONA_USER           — 用户自己的名字 (需要 PERSONA_CHAT_FILE)
#
# 示例:
#   export MIND_LLM_API_KEY="sk-xxx"
#   export QQ_APP_ID="123456"
#   export QQ_CLIENT_SECRET="abc123"
#   export PERSONA_CHAT_FILE="/root/her_chat.jsonl"
#   export PERSONA_TARGET="CHAR_NAME"
#   export PERSONA_USER="USER_NAME"
#   bash deploy.sh
# =============================================================================

set -euo pipefail

# ── 颜色 ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }
info() { echo -e "${BLUE}[i]${NC} $*"; }

# ── 检查 root ──
if [[ "$(id -u)" != "0" ]]; then
  err "请用 root 运行: sudo bash deploy.sh"
fi

# ── 默认值 ──
OPENCLAW_HOME="${OPENCLAW_HOME:-/home/openclaw}"
OPENCLAW_DIR="${OPENCLAW_HOME}/.openclaw"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
LLM_MODEL="${LLM_MODEL:-doubao-seed-2.0-lite}"
LLM_BASE_URL="${LLM_BASE_URL:-https://ark.cn-beijing.volces.com/api/coding/v3}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-agent-mind-$(openssl rand -hex 8 2>/dev/null || echo 'change-me-123456')}"
REPO_OWNER="${REPO_OWNER:-USER_NAMEtx}"
REPO_NAME="${REPO_NAME:-generative_openclaw}"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   OpenClaw Agent Mind 一键部署          ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ── 1. 收集配置 ──
info "=== 步骤 1/8: 检查环境 ==="

if [[ -z "${MIND_LLM_API_KEY:-}" ]]; then
  read -rp "  输入 LLM API Key: " MIND_LLM_API_KEY
fi

if [[ -z "${QQ_APP_ID:-}" ]]; then
  read -rp "  输入 QQ 机器人 AppID (回车跳过): " QQ_APP_ID
fi
if [[ -n "${QQ_APP_ID:-}" ]] && [[ -z "${QQ_CLIENT_SECRET:-}" ]]; then
  read -rp "  输入 QQ 机器人 ClientSecret: " QQ_CLIENT_SECRET
fi

PERSONA_CHAT_FILE="${PERSONA_CHAT_FILE:-}"
PERSONA_TARGET="${PERSONA_TARGET:-}"
PERSONA_USER="${PERSONA_USER:-}"

if [[ -n "${PERSONA_CHAT_FILE:-}" ]]; then
  if [[ -z "${PERSONA_TARGET:-}" ]]; then
    read -rp "  输入要分析的人名 (例如 CHAR_NAME): " PERSONA_TARGET
  fi
  if [[ -z "${PERSONA_USER:-}" ]]; then
    read -rp "  输入你的名字 (例如 USER_NAME): " PERSONA_USER
  fi
fi

# ── 2. 装 Node.js 22 ──
info "=== 步骤 2/8: 安装 Node.js 22 ==="
if command -v node &>/dev/null && node -v | grep -q "v22"; then
  log "Node.js 22 已安装"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  log "Node.js $(node -v) 安装完成"
fi

apt-get install -y sqlite3 unzip openssl 2>/dev/null || true

# ── 3. 创建 openclaw 用户 ──
info "=== 步骤 3/8: 创建 openclaw 用户 ==="
if id openclaw &>/dev/null; then
  log "用户 openclaw 已存在"
else
  useradd -m -s /bin/bash openclaw
  log "用户 openclaw 创建完成"
fi

# ── 4. 下载 Release ──
info "=== 步骤 4/8: 下载 Release 包 ==="
mkdir -p "${OPENCLAW_DIR}"

# 尝试从 GitHub 下载
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
RELEASE_FILE="/tmp/openclaw-release.tar.gz"

if [[ -f "${RELEASE_FILE}" ]]; then
  log "发现本地 release 包: ${RELEASE_FILE}"
else
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    info "从 GitHub Actions 下载 artifact..."
    ARTIFACT_URL=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/artifacts?per_page=1" \
      | python3 -c "import sys,json; print(json.load(sys.stdin)['artifacts'][0]['archive_download_url']")
    curl -L -H "Authorization: Bearer ${GITHUB_TOKEN}" "${ARTIFACT_URL}" -o /tmp/openclaw-release.zip
    unzip -o /tmp/openclaw-release.zip -d /tmp/
    log "下载完成"
  else
    warn "未设置 GITHUB_TOKEN，尝试从 GitHub Releases 下载..."
    LATEST_RELEASE=$(curl -s "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('assets',[])[0].get('browser_download_url','') if d.get('assets') else '')")
    if [[ -n "${LATEST_RELEASE}" ]]; then
      curl -L "${LATEST_RELEASE}" -o "${RELEASE_FILE}"
      log "从 Release 下载完成"
    else
      warn "无法自动下载。请手动上传 openclaw-release.tar.gz 到 ${RELEASE_FILE}"
      warn "然后重新运行: bash deploy.sh"
      warn "  手动下载: https://github.com/${REPO_OWNER}/${REPO_NAME}/actions"
      read -rp "  已上传？按回车继续..."
      if [[ ! -f "${RELEASE_FILE}" ]]; then
        err "未找到 ${RELEASE_FILE}。请上传后再试。"
      fi
    fi
  fi
fi

# ── 5. 解压 ──
info "=== 步骤 5/8: 解压部署 ==="
tar -xzf "${RELEASE_FILE}" -C "${OPENCLAW_DIR}/"
log "解压完成"

# ── 6. 配置文件 ──
info "=== 步骤 6/8: 写入配置 ==="

# mind-config.json (Agent Mind 专用)
cat > "${OPENCLAW_HOME}/.openclaw/mind-config.json" << JSONEOF
{
  "preset": "social",
  "llm": {
    "model": "${LLM_MODEL}",
    "apiKeyEnv": "MIND_LLM_API_KEY",
    "baseUrl": "${LLM_BASE_URL}",
    "maxTokensPerMinute": 10000,
    "fallbackToRules": true
  }
}
JSONEOF

# openclaw.json (OpenClaw 主配置)
OPENCLAW_JSON="${OPENCLAW_DIR}/openclaw.json"
cat > "${OPENCLAW_JSON}" << JSONEOF
{
  "gateway": {
    "mode": "local",
    "port": ${GATEWAY_PORT},
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "${GATEWAY_TOKEN}"
    }
  },
  "plugins": {
    "allow": ["qqbot"]
  }
}
JSONEOF

# QQ Bot 频道配置
if [[ -n "${QQ_APP_ID:-}" ]] && [[ -n "${QQ_CLIENT_SECRET:-}" ]]; then
  python3 -c "
import json
cfg = json.load(open('${OPENCLAW_JSON}'))
cfg['channels'] = {
    'qqbot': {
        'enabled': True,
        'allowFrom': ['*'],
        'appId': '${QQ_APP_ID}',
        'clientSecret': '${QQ_CLIENT_SECRET}'
    }
}
json.dump(cfg, open('${OPENCLAW_JSON}', 'w'), indent=2, ensure_ascii=False)
"
  log "QQ Bot 频道已配置"
fi

# ── 7. systemd 服务 ──
info "=== 步骤 7/8: 创建 systemd 服务 ==="
cat > /etc/systemd/system/openclaw-gateway.service << UNITEOF
[Unit]
Description=OpenClaw Gateway
After=network-online.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=${OPENCLAW_DIR}
Environment=NODE_ENV=production
Environment=OPENCLAW_HOME=${OPENCLAW_HOME}
Environment=MIND_LLM_API_KEY=${MIND_LLM_API_KEY}
ExecStart=/usr/bin/node ${OPENCLAW_DIR}/openclaw.mjs gateway run --port ${GATEWAY_PORT} --allow-unconfigured
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable openclaw-gateway
systemctl restart openclaw-gateway

sleep 5
if systemctl is-active --quiet openclaw-gateway; then
  log "OpenClaw Gateway 已启动 (端口 ${GATEWAY_PORT})"
else
  warn "服务启动可能失败，查看日志: journalctl -u openclaw-gateway -n 20"
fi

# ── 8. 权限 + QQ Bot 插件 ──
info "=== 步骤 8/8: 安装 QQ Bot 插件 ==="
chown -R openclaw:openclaw "${OPENCLAW_HOME}"

if [[ -n "${QQ_APP_ID:-}" ]]; then
  if [[ ! -d "${OPENCLAW_DIR}/npm/node_modules/@openclaw/qqbot" ]]; then
    info "安装 @openclaw/qqbot (匹配版本)..."
    mkdir -p "${OPENCLAW_DIR}/npm"
    cd "${OPENCLAW_DIR}/npm"
    npm init -y --silent 2>/dev/null

    # 找匹配的 qqbot 版本（跟主项目版本一致）
    QQ_VERSION=$(node -e "try{console.log(require('${OPENCLAW_DIR}/package.json').version)}catch(e){console.log('2026.5.12-beta.1')}")
    npm install "@openclaw/qqbot@${QQ_VERSION}" --save 2>&1 | tail -1
    chown -R openclaw:openclaw "${OPENCLAW_DIR}/npm"
    log "QQ Bot 插件安装完成"
  else
    log "QQ Bot 插件已安装"
  fi
fi

# ── 重启使插件生效 ──
systemctl restart openclaw-gateway
sleep 3

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  部署完成！                             ║"
if [[ -n "${QQ_APP_ID:-}" ]]; then
  echo "  ║  QQ Bot 已配置                          ║"
fi
echo "  ╚══════════════════════════════════════════╝"
echo ""
echo "  控制台:  http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '服务器IP'):${GATEWAY_PORT}"
echo "  Token:   ${GATEWAY_TOKEN}"
echo ""
echo "  状态:    systemctl status openclaw-gateway"
echo "  日志:    journalctl -u openclaw-gateway -f"
echo ""

# ── Persona Import ──
if [[ -n "${PERSONA_CHAT_FILE:-}" ]] && [[ -n "${PERSONA_TARGET:-}" ]] && [[ -n "${PERSONA_USER:-}" ]]; then
  if [[ -f "${PERSONA_CHAT_FILE}" ]]; then
    echo ""
    info "=== 人格导入 ==="
    sleep 5  # 等服务完全就绪
    sudo -u openclaw node "${OPENCLAW_DIR}/scripts/persona-import.mjs" \
      "${PERSONA_CHAT_FILE}" \
      --target "${PERSONA_TARGET}" \
      --user "${PERSONA_USER}" \
      --update-config \
      --api-key "${MIND_LLM_API_KEY}"

    systemctl restart openclaw-gateway
    echo ""
    log "人格导入完成！Agent 将以 ${PERSONA_TARGET} 的身份对话。"
  else
    warn "聊天记录文件不存在: ${PERSONA_CHAT_FILE}，跳过人格导入。"
    echo "  手动导入:"
    echo "    node ${OPENCLAW_DIR}/scripts/persona-import.mjs <聊天文件> --target <人名> --user <你> --update-config --api-key <key>"
  fi
else
  echo ""
  info "跳过人格导入。手动运行:"
  echo "  node ${OPENCLAW_DIR}/scripts/persona-import.mjs <聊天文件> --target <人名> --user <你> --update-config --api-key <key>"
fi

echo ""
log "全部完成！"
