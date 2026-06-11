#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="/opt/openclaw"
SERVICE_USER="openclaw"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=12

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" ]]; then
    err "Usage: bash deploy-ecs.sh <archive.tar.gz>"
    exit 1
fi

if [[ ! -f "$ARCHIVE" ]]; then
    err "Archive not found: $ARCHIVE"
    exit 1
fi

echo ""
echo -e "${CYAN}=== OpenClaw AI Town - ECS Deployment ===${NC}"
echo ""

# ── Node.js ────────────────────────────────────────────────────
info "Checking Node.js..."
if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
    NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
    if [[ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]] || { [[ "$NODE_MAJOR" -eq "$NODE_MIN_MAJOR" ]] && [[ "$NODE_MINOR" -lt "$NODE_MIN_MINOR" ]]; }; then
        info "Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ required, found v${NODE_VERSION}. Installing via nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        nvm install 22
        nvm use 22
        nvm alias default 22
    fi
    ok "Node.js $(node -v)"
else
    info "Node.js not found. Installing via nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm use 22
    nvm alias default 22
    ok "Node.js $(node -v)"
fi

# ── npm ────────────────────────────────────────────────────────
info "Checking npm..."
ok "npm $(npm -v)"

# ── Service user ───────────────────────────────────────────────
info "Creating service user: $SERVICE_USER"
if id "$SERVICE_USER" &>/dev/null; then
    ok "User $SERVICE_USER already exists"
else
    useradd -m -s /bin/bash "$SERVICE_USER"
    ok "User $SERVICE_USER created"
fi

# ── Systemd service file ──────────────────────────────────────
info "Writing systemd service file..."
SERVICE_FILE="/etc/systemd/system/openclaw-gateway.service"

cat > "$SERVICE_FILE" <<'SYSTEMD'
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/opt/openclaw
Environment=NODE_ENV=production
Environment=HOME=/home/openclaw
Environment=PATH=/home/openclaw/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -c 'export NVM_DIR="/home/openclaw/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; exec node /opt/openclaw/openclaw.mjs gateway --port 18789 --bind lan'
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw-gateway

[Install]
WantedBy=multi-user.target
SYSTEMD
ok "Service file written to $SERVICE_FILE"

# ── Install Node.js for service user ───────────────────────────
info "Setting up Node.js for $SERVICE_USER..."
if ! su - "$SERVICE_USER" -c 'command -v node &>/dev/null'; then
    su - "$SERVICE_USER" -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
    su - "$SERVICE_USER" -c 'source ~/.nvm/nvm.sh && nvm install 22 && nvm alias default 22'
fi
ok "Node.js ready for $SERVICE_USER"

# ── Extract ────────────────────────────────────────────────────
info "Installing to $INSTALL_DIR ..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$ARCHIVE" -C "$INSTALL_DIR"
ok "Files extracted"

# ── Dependencies ───────────────────────────────────────────────
info "Installing production dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev --ignore-scripts
ok "Dependencies installed"

info "Setting permissions..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── openclaw command ───────────────────────────────────────────
mkdir -p "/home/$SERVICE_USER/.local/bin"
cat > "/home/$SERVICE_USER/.local/bin/openclaw" <<'SCRIPT'
#!/usr/bin/env bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
exec node /opt/openclaw/openclaw.mjs "$@"
SCRIPT
chmod +x "/home/$SERVICE_USER/.local/bin/openclaw"
chown -R "$SERVICE_USER:$SERVICE_USER" "/home/$SERVICE_USER/.local"

grep -q '/.local/bin' "/home/$SERVICE_USER/.bashrc" 2>/dev/null || {
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "/home/$SERVICE_USER/.bashrc"
}

ln -sf "/home/$SERVICE_USER/.local/bin/openclaw" /usr/local/bin/openclaw 2>/dev/null || true
ok "openclaw command created"

# ── Verify ─────────────────────────────────────────────────────
info "Verifying installation..."
VER=$(su - "$SERVICE_USER" -c 'source ~/.nvm/nvm.sh 2>/dev/null; export PATH="$HOME/.local/bin:$PATH"; openclaw --version' 2>/dev/null || echo "unknown")
if [[ "$VER" != "unknown" ]]; then
    ok "OpenClaw $VER installed successfully!"
else
    warn "Could not verify version, but files are in place"
fi

# ── Activate systemd service ──────────────────────────────────
if systemctl daemon-reload 2>/dev/null; then
    systemctl enable openclaw-gateway 2>/dev/null && ok "Gateway service enabled (auto-start on boot)" || warn "Could not enable gateway service"
    systemctl start openclaw-gateway 2>/dev/null && ok "Gateway service started" || warn "Gateway start failed (run 'openclaw onboard' first, then 'sudo systemctl start openclaw-gateway')"
else
    warn "systemctl unavailable — skip service activation. Start manually with: nohup openclaw gateway --port 18789 --bind lan &"
fi

# ── Done ───────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo ""
echo "  Version:   $VER"
echo "  Install:   $INSTALL_DIR"
echo "  User:      $SERVICE_USER"
echo "  Command:   openclaw"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo "  1. Configure OpenClaw:"
echo "     su - $SERVICE_USER"
echo "     openclaw onboard"
echo ""
echo "  2. Gateway service (system-level systemd):"
echo "     sudo systemctl status openclaw-gateway"
echo "     sudo systemctl restart openclaw-gateway"
echo ""
echo "  3. View logs:"
echo "     sudo journalctl -u openclaw-gateway -f"
echo ""