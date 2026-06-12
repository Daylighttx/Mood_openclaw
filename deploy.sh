#!/usr/bin/env bash
# =============================================================================
# Mood_OpenClaw — 一键部署脚本
# =============================================================================
# 用法:
#   # 全新部署
#   export MIND_LLM_API_KEY="sk-xxx"
#   export CHANNEL="telegram"
#   export CHANNEL_TOKEN="123456:ABCDEF"
#   bash deploy.sh
#
#   # 仅检查配置
#   bash deploy.sh --check
#
#   # 仅更新代码（不动配置）
#   bash deploy.sh --update
#
# 必填环境变量:
#   MIND_LLM_API_KEY       — LLM API Key
# 可选环境变量:
#   LLM_MODEL              — 模型名 (默认: doubao-seed-2.0-lite)
#   LLM_BASE_URL           — API 地址 (默认: https://api.openai.com/v1)
#   LLM_PROVIDER           — provider 类型 (默认: openai-compatible)
#   GATEWAY_TOKEN          — 控制台密码 (默认: 自动生成)
#   CHANNEL                — 通道类型: telegram | discord | qqbot | whatsapp
#   CHANNEL_TOKEN           — 通道 Token (Telegram Bot Token / QQ ClientSecret 等)
#   CHANNEL_APP_ID          — QQ AppID (仅 QQ Bot)
#   PERSONA_NAME           — Agent 名字 (默认: Clawdbot)
#   PERSONA_IDENTITY        — Agent 身份描述
#   PERSONA_LANGUAGE        — Agent 语言 (默认: English)
#   OPENCLAW_HOME           — 数据目录 (默认: /home/openclaw)
#   GITHUB_REPO             — GitHub 仓库 (默认: Daylighttx/Mood_openclaw)
#   TZ                      — 时区 (默认: Asia/Shanghai)
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[!!]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*"; exit 1; }
info() { echo -e "${BLUE}[..]${NC} $*"; }

# ── 默认值 ──
GITHUB_REPO="${GITHUB_REPO:-Daylighttx/Mood_openclaw}"
OPENCLAW_HOME="${OPENCLAW_HOME:-/home/openclaw}"
LLM_MODEL="${LLM_MODEL:-doubao-seed-2.0-lite}"
LLM_BASE_URL="${LLM_BASE_URL:-https://api.openai.com/v1}"
LLM_PROVIDER="${LLM_PROVIDER:-openai-compatible}"
TZ="${TZ:-Asia/Shanghai}"
PERSONA_NAME="${PERSONA_NAME:-Clawdbot}"
PERSONA_IDENTITY="${PERSONA_IDENTITY:-You are a thoughtful AI companion with your own moods and memories.}"
PERSONA_LANGUAGE="${PERSONA_LANGUAGE:-English}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-$(openssl rand -hex 32 2>/dev/null || python3 -c 'import secrets;print(secrets.token_hex(32))')}"
DEPLOY_USER="${DEPLOY_USER:-openclaw}"
OPENCLAW_DIR="${OPENCLAW_HOME}/.openclaw"
MIND_DIR="${OPENCLAW_HOME}/.openclaw/mind"
WORKSPACE_DIR="${OPENCLAW_HOME}/.openclaw/workspace"

# ── 模式检测 ──
MODE="install"
case "${1:-}" in
  --check)  MODE="check";;
  --update) MODE="update";;
  --help|-h) sed -n '2,20p' "$0"; exit 0;;
esac

# ============================================================
# 子命令: --check — 验证配置是否就绪
# ============================================================
do_check() {
  info "检查部署状态..."
  local ok=true

  check_file() { if [[ -f "$1" ]]; then log "$1 存在"; else warn "$1 缺失"; ok=false; fi; }
  check_dir()  { if [[ -d "$1" ]]; then log "$1 存在"; else warn "$1 缺失"; ok=false; fi; }
  check_var()  { if [[ -n "${!1:-}" ]]; then log "$1=${!1}"; else warn "$1 未设置"; ok=false; fi; }

  check_var MIND_LLM_API_KEY
  check_file "${OPENCLAW_DIR}/openclaw.json"
  check_file "${OPENCLAW_DIR}/mind-config.json"
  check_file "${WORKSPACE_DIR}/SOUL.md"
  check_dir  "${OPENCLAW_DIR}/dist"
  check_dir  "${OPENCLAW_DIR}/node_modules"

  if systemctl is-active --quiet openclaw-gateway 2>/dev/null; then
    log "openclaw-gateway 服务运行中"
  else
    warn "openclaw-gateway 服务未运行"
    ok=false
  fi

  if $ok; then info "所有检查通过"; else err "部分检查未通过，请修复后重试"; fi
}

# ============================================================
# 子命令: --update — 只更新代码
# ============================================================
do_update() {
  info "更新代码..."
  download_release
  extract_release
  fix_permissions
  systemctl restart openclaw-gateway
  log "更新完成，服务已重启"
}

# ============================================================
# 下载 release
# ============================================================
download_release() {
  local tmpdir="/tmp/openclaw-deploy-$$"
  mkdir -p "$tmpdir"

  info "从 GitHub 下载最新 release..."
  # Try GitHub Releases API first
  local release_url
  release_url=$(curl -fsS "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
    | grep -o '"browser_download_url":\s*"[^"]*"' \
    | head -1 | grep -o 'https://[^"]*') || true

  if [[ -n "${release_url:-}" ]]; then
    curl -fsSL "$release_url" -o "$tmpdir/release.tar.gz"
    log "下载完成: $release_url"
  else
    # Fallback: try artifacts from latest workflow run
    local artifact_url
    artifact_url="https://nightly.link/${GITHUB_REPO}/workflows/release/main/openclaw-release.zip"
    warn "未找到 Release，尝试从 CI artifact 下载..."
    curl -fsSL "$artifact_url" -o "$tmpdir/release.zip"
    cd "$tmpdir" && unzip -q release.zip
    # nightly.link gives us the tar.gz inside a zip
    if [[ -f openclaw-release.tar.gz ]]; then
      mv openclaw-release.tar.gz release.tar.gz
    fi
  fi

  if [[ ! -f "$tmpdir/release.tar.gz" ]]; then
    err "下载失败。请确认仓库 ${GITHUB_REPO} 有 Release 或 CI artifact"
  fi

  RELEASE_TARBALL="$tmpdir/release.tar.gz"
  TMPDIR="$tmpdir"
}

extract_release() {
  mkdir -p "$OPENCLAW_DIR"
  info "解压到 $OPENCLAW_DIR ..."
  tar -xzf "$RELEASE_TARBALL" -C "$OPENCLAW_DIR/"
  log "解压完成"
}

# ============================================================
# 生成配置
# ============================================================
generate_configs() {
  mkdir -p "$MIND_DIR" "$WORKSPACE_DIR"

  # openclaw.json
  if [[ ! -f "${OPENCLAW_DIR}/openclaw.json" ]]; then
    info "生成 openclaw.json ..."
    local channel_block=""
    case "${CHANNEL:-}" in
      telegram)
        channel_block="\"telegram\": { \"enabled\": true, \"botToken\": \"${CHANNEL_TOKEN:-}\", \"dmPolicy\": \"open\", \"allowFrom\": [\"*\"] }"
        ;;
      discord)
        channel_block="\"discord\": { \"enabled\": true, \"botToken\": \"${CHANNEL_TOKEN:-}\", \"dmPolicy\": \"open\", \"allowFrom\": [\"*\"] }"
        ;;
      qqbot)
        channel_block="\"qqbot\": { \"enabled\": true, \"appId\": \"${CHANNEL_APP_ID:-}\", \"clientSecret\": \"${CHANNEL_TOKEN:-}\", \"dmPolicy\": \"open\", \"allowFrom\": [\"*\"] }"
        ;;
      whatsapp)
        channel_block="\"whatsapp\": { \"enabled\": true, \"dmPolicy\": \"open\", \"allowFrom\": [\"*\"] }"
        ;;
      *)
        channel_block="\"telegram\": { \"enabled\": true, \"botToken\": \"${CHANNEL_TOKEN:-}\", \"dmPolicy\": \"open\", \"allowFrom\": [\"*\"] }"
        warn "未设置 CHANNEL，默认使用 telegram。设置: CHANNEL=telegram|discord|qqbot|whatsapp"
        ;;
    esac

    export GATEWAY_TOKEN LLM_MODEL LLM_PROVIDER OPENCLAW_HOME
    # Use envsubst-style replacement
    local template="${OPENCLAW_DIR}/config/openclaw.json.example"
    if [[ -f "$template" ]]; then
      sed \
        -e "s|\${GATEWAY_TOKEN}|${GATEWAY_TOKEN}|g" \
        -e "s|\${LLM_MODEL}|${LLM_MODEL}|g" \
        -e "s|\${LLM_PROVIDER}|${LLM_PROVIDER}|g" \
        -e "s|\${OPENCLAW_HOME}|${OPENCLAW_HOME}|g" \
        -e "s|\"channels\": {}|\"channels\": { ${channel_block} }|" \
        "$template" > "${OPENCLAW_DIR}/openclaw.json"
      chmod 600 "${OPENCLAW_DIR}/openclaw.json"
      log "openclaw.json 已生成"
    fi
  else
    log "openclaw.json 已存在，跳过"
  fi

  # mind-config.json
  if [[ ! -f "${OPENCLAW_DIR}/mind-config.json" ]]; then
    info "生成 mind-config.json ..."
    local template="${OPENCLAW_DIR}/config/mind-config.json.example"
    if [[ -f "$template" ]]; then
      sed \
        -e "s|\${LLM_MODEL}|${LLM_MODEL}|g" \
        -e "s|\${LLM_BASE_URL}|${LLM_BASE_URL}|g" \
        -e "s|\"name\": \"Clawdbot\"|\"name\": \"${PERSONA_NAME}\"|g" \
        -e "s|\"language\": \"English\"|\"language\": \"${PERSONA_LANGUAGE}\"|g" \
        -e "s|You are a thoughtful AI companion with your own moods and memories|${PERSONA_IDENTITY}|g" \
        "$template" > "${OPENCLAW_DIR}/mind-config.json"
      chmod 600 "${OPENCLAW_DIR}/mind-config.json"
      log "mind-config.json 已生成"
    fi
  else
    log "mind-config.json 已存在，跳过"
  fi

  # SOUL.md
  if [[ ! -f "${WORKSPACE_DIR}/SOUL.md" ]]; then
    info "生成 SOUL.md ..."
    local template="${OPENCLAW_DIR}/config/SOUL.md.example"
    if [[ -f "$template" ]]; then
      sed \
        -e "s|\${PERSONA_NAME}|${PERSONA_NAME}|g" \
        -e "s|\${PERSONA_IDENTITY}|${PERSONA_IDENTITY}|g" \
        "$template" > "${WORKSPACE_DIR}/SOUL.md"
      log "SOUL.md 已生成"
    fi
  else
    log "SOUL.md 已存在，跳过"
  fi
}

# ============================================================
# 权限 + 服务
# ============================================================
fix_permissions() {
  chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "$OPENCLAW_HOME" 2>/dev/null || true
}

install_service() {
  local unit="/etc/systemd/system/openclaw-gateway.service"
  if [[ -f "$unit" ]]; then
    log "systemd 服务已存在，跳过"
    return
  fi

  info "安装 systemd 服务..."
  cat > "$unit" << UNITEOF
[Unit]
Description=Mood_OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${DEPLOY_USER}
WorkingDirectory=${OPENCLAW_DIR}
Environment=NODE_ENV=production
Environment=OPENCLAW_HOME=${OPENCLAW_HOME}
Environment=MIND_LLM_API_KEY=${MIND_LLM_API_KEY}
Environment=TZ=${TZ}
ExecStart=/usr/bin/node ${OPENCLAW_DIR}/openclaw.mjs gateway run --port 18789 --allow-unconfigured
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF

  systemctl daemon-reload
  systemctl enable openclaw-gateway
  systemctl start openclaw-gateway
  log "openclaw-gateway 服务已安装并启动"
}

# ============================================================
# 主流程
# ============================================================
main() {
  echo ""
  echo -e "${GREEN}  Mood_OpenClaw 部署脚本${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  case "$MODE" in
    check)  do_check; exit 0;;
    update) do_update; exit 0;;
  esac

  # ── 安装模式: 检查前置条件 ──
  if [[ "$(id -u)" != "0" ]]; then
    err "请用 root 运行: sudo bash deploy.sh"
  fi

  if [[ -z "${MIND_LLM_API_KEY:-}" ]]; then
    err "请设置 MIND_LLM_API_KEY 环境变量"
  fi

  # 安装依赖
  if ! command -v node &>/dev/null; then
    info "安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  if ! command -v sqlite3 &>/dev/null; then
    apt-get install -y sqlite3
  fi

  node_version=$(node -v 2>/dev/null || echo "none")
  log "Node.js: $node_version"

  # 创建用户
  if ! id -u "$DEPLOY_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$DEPLOY_USER"
    log "用户 $DEPLOY_USER 已创建"
  fi

  # 下载 + 解压 + 配置 + 启动
  download_release
  extract_release
  generate_configs
  fix_permissions
  install_service

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════╗${NC}"
  echo -e "${GREEN}║  部署完成!                       ║${NC}"
  echo -e "${GREEN}╠══════════════════════════════════╣${NC}"
  echo -e "${GREEN}║  查看状态: systemctl status openclaw-gateway${NC}"
  echo -e "${GREEN}║  查看日志: journalctl -u openclaw-gateway -f${NC}"
  echo -e "${GREEN}║  情绪事件: tail -f ${MIND_DIR}/events.log${NC}"
  echo -e "${GREEN}║  配置检查: bash deploy.sh --check${NC}"
  echo -e "${GREEN}║  代码更新: bash deploy.sh --update${NC}"
  echo -e "${GREEN}╚══════════════════════════════════╝${NC}"
}

main "$@"
