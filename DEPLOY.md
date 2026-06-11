# OpenClaw Agent Mind — 部署指南

## 前置要求

- Ubuntu 22.04+ 干净服务器 (2C2G 即可)
- LLM API Key (豆包/OpenAI 兼容)
- QQ 机器人 AppID + Token (如需 QQ 频道)

---

## 架构

```
┌─────────────────────────────────────────────┐
│  服务器                                      │
│  /home/openclaw/.openclaw/                  │
│  ├── dist/                 ← JS 编译产物     │
│  ├── node_modules/         ← 依赖 (hoisted) │
│  ├── docs/reference/templates/ ← 模板文件   │
│  ├── patches/              ← patch 文件     │
│  ├── openclaw.mjs          ← CLI 入口       │
│  ├── openclaw.json         ← OpenClaw 主配置 │
│  ├── mind-config.json      ← Agent Mind 配置 │
│  └── npm/                  ← QQ Bot 插件     │
│      └── node_modules/@openclaw/qqbot/       │
└─────────────────────────────────────────────┘

数据目录: /home/openclaw/
├── .openclaw/mind/main.db   ← SQLite 记忆
├── .openclaw/mind/events.log ← mood 事件
└── .openclaw/workspace/SOUL.md ← 对话身份
```

---

## 快速部署 (3 步)

### 步骤 1: 准备服务器

```bash
# SSH 到服务器
ssh root@your-server

# 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs sqlite3 unzip

# 创建服务用户
useradd -m -s /bin/bash openclaw
```

### 步骤 2: 部署 Release 包

```bash
# 方式 A: 从 GitHub Release 下载
TOKEN="ghp_xxx"  # GitHub personal access token
ARTIFACT_URL=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/USER_NAMEtx/generative_openclaw/actions/artifacts?per_page=1" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['artifacts'][0]['archive_download_url']")
curl -L -H "Authorization: Bearer $TOKEN" "$ARTIFACT_URL" -o /tmp/openclaw-release.zip
unzip /tmp/openclaw-release.zip -d /tmp/

# 方式 B: 手动下载 artifact 后 scp 上传
# scp openclaw-release.tar.gz root@your-server:/tmp/

# 解压
mkdir -p /home/openclaw/.openclaw
tar -xzf /tmp/openclaw-release.tar.gz -C /home/openclaw/.openclaw/
chown -R openclaw:openclaw /home/openclaw
```

### 步骤 3: 配置 + 启动

```bash
# --- systemd 服务 ---
cat > /etc/systemd/system/openclaw-gateway.service << 'UNITEOF'
[Unit]
Description=OpenClaw Gateway
After=network-online.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw/.openclaw
Environment=NODE_ENV=production
Environment=OPENCLAW_HOME=/home/openclaw
Environment=MIND_LLM_API_KEY=YOUR_API_KEY
ExecStart=/usr/bin/node /home/openclaw/.openclaw/openclaw.mjs gateway run --port 18789 --allow-unconfigured
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now openclaw-gateway

# --- 运行 onboard 向导 ---
sudo -u openclaw -H node /home/openclaw/.openclaw/openclaw.mjs onboard
#   → 认证: token (已配置，enter 确认)
#   → 模型: 选 OpenAI-compatible
#       Model: doubao-seed-2.0-lite
#       Base URL: https://ark.cn-beijing.volces.com/api/coding/v3
#       API Key: 你的 key
#   → 通道: 选 QQ Bot，填入 AppID 和 ClientSecret

systemctl restart openclaw-gateway
```

---

## 部署后的额外步骤

### 导入人格

```bash
# 上传聊天记录
scp her_chat.jsonl root@your-server:/tmp/

# 导入
cd /home/openclaw/.openclaw
sudo -u openclaw node scripts/persona-import.mjs /tmp/her_chat.jsonl \
  --target CHAR_NAME --user USER_NAME \
  --update-config \
  --api-key "your-api-key"

sudo systemctl restart openclaw-gateway
```

### 更新代码

```bash
# 下载新 release → 解压 → 重启
tar -xzf /tmp/openclaw-release.tar.gz -C /home/openclaw/.openclaw/
chown -R openclaw:openclaw /home/openclaw
systemctl restart openclaw-gateway
```

---

## 监控

```bash
# 服务状态
systemctl status openclaw-gateway

# 实时日志
journalctl -u openclaw-gateway -f

# QQ 频道日志
journalctl -u openclaw-gateway -f | grep qqbot

# 情绪事件
tail -f /home/openclaw/.openclaw/mind/events.log | grep heartbeat_tick

# 主动消息 prompt
journalctl -u openclaw-gateway -f | grep "promptFull"
```

---

## 部署踩坑记录

以下是在实际部署中遇到的 6 个坑，均已在 release workflow 中修复。

### 坑 1: tar 解压后 openclaw.mjs 不存在

**现象**: `Cannot find module '/home/openclaw/.openclaw/openclaw.mjs'`
**原因**: release tar.gz 没上传到服务器
**解决**: 先 `scp` 上传到 `/tmp/`，再 `tar -xzf` 解压

### 坑 2: Refusing to run as root

**现象**: `[openclaw] Refusing to run as root`
**原因**: systemd 的 `User=` 必须是 `openclaw`，不能是 `root`
**解决**: systemd service 里设 `User=openclaw`，文件用 `chown -R openclaw:openclaw`

### 坑 3: json5 / jiti 模块找不到

**现象**: `Cannot find package 'json5' imported from dist/redact-xxx.js`
**原因**: pnpm 默认用符号链接 (symlink)，tar 打包后链接断裂
**解决**: CI 用 `node-linker=hoisted` → 零符号链接，所有依赖平铺在 `node_modules/`

### 坑 4: 缺少 docs/reference/templates/

**现象**: `Missing workspace template: SOUL.md (Ensure docs/reference/templates are packaged)`
**原因**: 最初 `tar` 命令只打包了 `dist/ openclaw.mjs scripts/ package.json pnpm-lock.yaml node_modules/`，漏了 `docs/`
**解决**: tar 命令加入 `docs/ patches/`

### 坑 5: QQ Bot 插件版本不匹配

**现象**: `Cannot find module 'dist/plugin-sdk/root-alias.cjs/channel-outbound'`
**原因**: `onboard` 用 npm 安装了**最新版** `@openclaw/qqbot`，但本项目基于 `2026.5.12-beta.1`，API 不兼容。新版 qqbot 需要的 `channel-outbound` 在老版本不存在
**解决**: 使用 `npm install @openclaw/qqbot@2026.5.12-beta.1` 装匹配版本

### 坑 6: npm 破坏 pnpm node_modules

**现象**: 在项目根目录跑 `npm install` 后服务挂了
**原因**: npm 和 pnpm 的 `node_modules` 结构不兼容，混用会互相覆盖
**解决**: npm 装 qqbot 必须在独立的 `npm/` 子目录，不碰主 `node_modules/`

---

## 项目结构

```
generative_openclaw/
├── src/
│   ├── agents/
│   │   ├── mood.ts               ← 情绪引擎 (425行)
│   │   └── personality.ts        ← 人格定义 (110行)
│   └── memory/
│       ├── agent-mind.ts          ← 总控 (450行)
│       ├── agent-mind-bridge.ts   ← Chat/Mind 桥接 (380行)
│       ├── thinking-loop.ts       ← 决策循环 (600行)
│       ├── conversation-memory.ts ← 对话记忆
│       └── store.ts              ← SQLite (250行)
├── scripts/
│   └── persona-import.mjs        ← 人格复刻 CLI (450行)
├── docs/reference/templates/     ← 14 个模板文件
├── patches/                      ← pnpm patch 文件
├── .github/workflows/release.yml ← CI 构建
├── openclaw.mjs                  ← CLI 入口
├── README.md / README_CN.md      ← 项目文档
├── DEPLOY.md                     ← 本文件
└── PROJECT_REPORT.md             ← 技术报告
```

---

## 技术栈

| 层 | 技术 |
|------|------|
| 框架 | OpenClaw 2026.5.12-beta.1 |
| 运行时 | Node.js 22 |
| 情绪引擎 | 自研 8 公式 advanceTime |
| 决策引擎 | LLM (doubao-seed-2.0-lite) |
| 存储 | SQLite + JSONL events log |
| 消息平台 | QQ Bot |
| 构建 | pnpm (hoisted layout) |
| CI/CD | GitHub Actions |
| 配置 | openclaw.json + mind-config.json + SOUL.md |
