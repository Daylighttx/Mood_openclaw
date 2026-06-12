# Mood_OpenClaw — 部署指南

## 三步部署

### 步骤 1: 解压 + 安装依赖

```bash
# 上传 release.tar.gz 到服务器后
tar -xzf openclaw-release.tar.gz -C /home/openclaw/.openclaw/
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs sqlite3
```

### 步骤 2: 交互式配置

```bash
cd /home/openclaw/.openclaw

# ① OpenClaw onboard — 配置 Gateway + Model + Channel（交互式）
node openclaw.mjs onboard

# ② Mood setup — 配置 Agent 人格 + 思维 LLM（交互式）
node scripts/setup-mind.mjs
```

`openclaw onboard` 会引导你：
- 设置 Gateway 鉴权 token（自动生成）
- 选择 AI 模型（OpenAI / Anthropic / 自定义 compatible）
- 设置 Channel（Telegram / Discord / QQ Bot / WhatsApp）
- 安装推荐插件

`node scripts/setup-mind.mjs` 会引导你：
- 配置思维 LLM（API Key、模型、地址）
- 设置 Agent 名字、身份描述、语言
- 调节好奇心/社交欲/趣味性
- 选择情绪预设（社交型/平衡型/内敛型/好奇型）

### 步骤 3: 设置环境变量 + 启动

```bash
export MIND_LLM_API_KEY="sk-your-key"
export OPENCLAW_HOME=/home/openclaw

# 前台测试
NODE_ENV=production node openclaw.mjs gateway run --port 18789

# 确认正常后 Ctrl+C，安装 systemd 服务
cat > /etc/systemd/system/openclaw-gateway.service << 'EOF'
[Unit]
Description=Mood_OpenClaw Gateway
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/openclaw/.openclaw
Environment=NODE_ENV=production
Environment=OPENCLAW_HOME=/home/openclaw
Environment=MIND_LLM_API_KEY=sk-your-key
Environment=TZ=Asia/Shanghai
ExecStart=/usr/bin/node /home/openclaw/.openclaw/openclaw.mjs gateway run --port 18789
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now openclaw-gateway
```

---

## 部署后

```bash
systemctl status openclaw-gateway        # 服务状态
journalctl -u openclaw-gateway -f        # 实时日志
tail -f /home/openclaw/.openclaw/mind/events.log | grep heartbeat_tick  # 情绪事件
```

---

## 配置文件位置

| 文件 | 用途 | 生成方式 |
|------|------|---------|
| `~/.openclaw/openclaw.json` | Gateway + Channel + Model | `openclaw onboard` 交互生成 |
| `~/.openclaw/mind-config.json` | 思维 LLM + 情绪引擎 | `node scripts/setup-mind.mjs` 交互生成 |
| `~/.openclaw/workspace/SOUL.md` | Agent 身份描述 | `node scripts/setup-mind.mjs` 交互生成 |

## 人格复刻（可选）

```bash
cd /home/openclaw/.openclaw

# 上传聊天记录
scp chat.jsonl root@server:/tmp/

# 分析 + 导入
node scripts/persona-import.mjs /tmp/chat.jsonl \
  --target "角色名" --user "你的名字" \
  --update-config --api-key "$MIND_LLM_API_KEY"

systemctl restart openclaw-gateway
```

## 支持的 Channel

| Channel | onboard 中选什么 |
|---------|----------------|
| Telegram | Telegram |
| Discord | Discord |
| QQ 机器人 | QQ Bot |
| WhatsApp | WhatsApp |
| 更多... | 见 `openclaw onboard` 完整列表 |

---

## 故障排查

| 现象 | 解决 |
|------|------|
| `Cannot find module` | 确认正确解压到 `/home/openclaw/.openclaw/` |
| `Refusing to run as root` | systemd 设 `User=openclaw`，`chown -R openclaw:openclaw` |
| QQ Bot 报错 | 版本匹配: 不要用 npm 装最新版，用 release 自带的 |
| 不发主动消息 | 检查 `MIND_LLM_API_KEY` 是否设置 + `mind-config.json` 中 `llm` 配置 |
| 情绪不变化 | 发一条消息即可激活 idle 情绪演化 |
