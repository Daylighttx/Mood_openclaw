# Mood_OpenClaw — 部署指南

## 两步部署

### 步骤 1: 设置环境变量

```bash
# 必填
export MIND_LLM_API_KEY="sk-your-api-key"

# 可选 — 默认已包含合理值
export LLM_MODEL="doubao-seed-2.0-lite"
export LLM_BASE_URL="https://api.openai.com/v1"
export CHANNEL="telegram"                          # telegram | discord | qqbot | whatsapp
export CHANNEL_TOKEN="123456:ABCDEF..."            # Bot Token
export CHANNEL_APP_ID="..."                        # 仅 QQ Bot
export PERSONA_NAME="Clawdbot"
export PERSONA_IDENTITY="You are a thoughtful AI companion..."
export PERSONA_LANGUAGE="English"
export TZ="Asia/Shanghai"
```

### 步骤 2: 运行部署脚本

```bash
curl -fsSL https://raw.githubusercontent.com/Daylighttx/Mood_openclaw/main/deploy.sh | bash
```

**完成！** 3 分钟后 Agent 上线，情绪系统自动运行。

---

## 部署后

```bash
# 查看服务状态
systemctl status openclaw-gateway

# 实时日志
journalctl -u openclaw-gateway -f

# 情绪事件追踪
tail -f /home/openclaw/.openclaw/mind/events.log | grep heartbeat_tick

# 配置检查
bash deploy.sh --check
```

---

## 配置说明

部署脚本自动生成 3 个文件:

| 文件 | 路径 | 作用 |
|------|------|------|
| `openclaw.json` | `~/.openclaw/openclaw.json` | Gateway + Channel 配置 |
| `mind-config.json` | `~/.openclaw/mind-config.json` | 双 LLM + 情绪引擎配置 |
| `SOUL.md` | `~/.openclaw/workspace/SOUL.md` | Agent 身份描述 |

所有文件均由 `${PLACEHOLDER}` 模板从环境变量生成。

### 高级: 手动编辑配置

部署后可直接编辑以上文件，修改后重启:
```bash
systemctl restart openclaw-gateway
```

### 人格复刻

```bash
# 上传聊天记录并导入
scp chat.jsonl root@your-server:/tmp/
cd /home/openclaw/.openclaw
sudo -u openclaw node scripts/persona-import.mjs /tmp/chat.jsonl \
  --target "角色名" --user "你的名字" \
  --update-config --api-key "$MIND_LLM_API_KEY"
systemctl restart openclaw-gateway
```

### 更新代码

```bash
bash deploy.sh --update
```

---

## 支持的 Channel

| Channel | 环境变量 | 需要 |
|---------|---------|------|
| Telegram | `CHANNEL=telegram` `CHANNEL_TOKEN=<bot_token>` | @BotFather 创建 |
| Discord | `CHANNEL=discord` `CHANNEL_TOKEN=<bot_token>` | Discord Developer Portal |
| QQ Bot | `CHANNEL=qqbot` `CHANNEL_APP_ID=<appid>` `CHANNEL_TOKEN=<secret>` | QQ 开放平台 |
| WhatsApp | `CHANNEL=whatsapp` | WhatsApp QR 扫码 |

---

## 前置要求

- Ubuntu 22.04+ 或 Debian 12+ 服务器
- 2C2G 即可运行
- 可访问外网（LLM API + Channel API）
- root 权限（deploy.sh 需要安装 Node 和创建 systemd 服务）
- GitHub 仓库有 Release 或 CI artifact

---

## 系统架构

```
/home/openclaw/
├── .openclaw/
│   ├── dist/                   ← JS 编译产物
│   ├── node_modules/           ← 依赖 (hoisted, 无符号链接)
│   ├── openclaw.mjs            ← CLI 入口
│   ├── openclaw.json           ← Gateway 主配置
│   ├── mind-config.json        ← Agent Mind 配置
│   ├── config/                 ← 配置模板 *.example
│   ├── docs/reference/templates/ ← 系统模板
│   ├── scripts/                ← 工具脚本 (persona-import, sim-*)
│   ├── events.log              ← 情绪事件日志 (每 tick 一条)
│   └── mind/
│       ├── main.db             ← SQLite 记忆存储
│       └── main-mood.json      ← mood 状态快照 (重启恢复)
└── workspace/
    └── SOUL.md                 ← Agent 身份文件
```

---

## 故障排查 FAQ

| 现象 | 原因 | 解决 |
|------|------|------|
| `Cannot find module 'openclaw.mjs'` | release 包未解压或权限问题 | `chown -R openclaw:openclaw /home/openclaw` |
| `Refusing to run as root` | systemd 用了 root | 确认 `User=openclaw` |
| `Cannot find package 'json5'` | pnpm symlink 断裂 | CI 用 `node-linker=hoisted` 已修复 |
| `Missing workspace template` | 缺少模板目录 | CI 打包了 `docs/` 已修复 |
| QQ Bot 报错 | 插件版本不匹配 | 检查 qqbot 版本与 OpenClaw 版本一致 |
| npm 覆盖 pnpm deps | 根目录跑了 `npm install` | 只用 pnpm；qqbot 装在独立 `npm/` 子目录 |
| 情绪不变化 | `lastInteractionAt=0` 或无入站消息 | 发一条消息即可激活 idle 情绪演化 |
| 不发主动消息 | mood 不够高 / cooldown / 无思维 LLM | 检查 `mind-config.json` 中的 `llm` 配置和 `moodConfig` |
| 记忆丢失重启后 | mood 持久化在 Stage 5 才加入 | 确认 commit ≥ `e4fd8912` |
