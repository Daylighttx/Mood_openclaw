# 部署指南 — AI Town 版 OpenClaw

## 这是什么？

这是 **OpenClaw 的自定义版本**，在原版基础上集成了 AI Town 的思考系统（记忆、人格、情绪、主动思考）。因为未发布到 npm，不能直接 `npm install`，但部署依然很简单——**只需 2 条命令**。

---

## 部署架构

```
你的 Windows 电脑 (编译)          云服务器 ECS (运行)
┌──────────────────┐            ┌──────────────────┐
│ pnpm build       │            │                  │
│ pack-deploy.ps1  │──scp──→    │ deploy-ecs.sh    │
│ 生成 tar.gz      │            │ 自动完成一切      │
└──────────────────┘            └──────────────────┘
```

为什么要这样？因为 OpenClaw 编译（tsdown）需要 2-4GB 内存，小内存 ECS 跑不动。但你本地电脑可以。所以：**本地编译 → 打包 → 传到服务器 → 一键部署**。

---

## 第一步：在你本机编译并打包

### 前提

| 要求 | 说明 |
|------|------|
| **Node.js** | ≥ 22.12 |
| **pnpm** | ≥ 11 |

### 操作

```powershell
# 进入项目目录
cd D:\Code\AI_Only\AI_Town\generative_openclaw

# 安装依赖（首次）
pnpm install

# 编译
$env:NODE_OPTIONS="--max-old-space-size=4096"
pnpm build

# 打包（自动排除 UI、sourcemap、类型声明，减小体积）
powershell scripts\pack-deploy.ps1
```

打包完成后会在项目根目录生成 `openclaw-deploy.tar.gz`。

---

## 第二步：上传到服务器

```powershell
scp openclaw-deploy.tar.gz root@你的服务器IP:/tmp/
```

---

## 第三步：在服务器上一键部署

```bash
bash /tmp/deploy-ecs.sh /tmp/openclaw-deploy.tar.gz
```

**就这一条命令。** 脚本会自动完成：

| 自动执行的操作 | 说明 |
|---|---|
| 检查/安装 Node.js 22+ | 通过 nvm 自动安装 |
| 检查/安装 pnpm | npm install -g pnpm |
| 创建 openclaw 用户 | 非 root 运行，更安全 |
| 解压文件到 /opt/openclaw | 标准安装位置 |
| 安装运行时依赖 | pnpm install --prod |
| 创建 openclaw 命令 | 全局可用 |
| 配置 systemd 服务 | 开机自启、崩溃重启 |
| 验证安装 | 输出版本号 |

---

## 部署后操作

### 初始化配置

```bash
su - openclaw
openclaw onboard
```

### 启动网关

```bash
sudo systemctl start openclaw
```

### 查看状态

```bash
sudo systemctl status openclaw
```

### 查看日志

```bash
journalctl -u openclaw -f
```

### 停止/重启

```bash
sudo systemctl stop openclaw
sudo systemctl restart openclaw
```

---

## 更新版本

当代码有更新时，重复打包流程：

```powershell
# 本机
git pull
pnpm install
$env:NODE_OPTIONS="--max-old-space-size=4096"
pnpm build
powershell scripts\pack-deploy.ps1
scp openclaw-deploy.tar.gz root@你的服务器IP:/tmp/
```

```bash
# 服务器
bash /tmp/deploy-ecs.sh /tmp/openclaw-deploy.tar.gz
sudo systemctl restart openclaw
```

---

## 方案对比

| 方案 | 步骤数 | 难度 | 适用场景 |
|---|---|---|---|
| **pack-deploy + deploy-ecs**（推荐） | 2 条命令 | ⭐ | 所有 Linux 服务器 |
| Docker Compose | 3 条命令 | ⭐⭐ | 已有 Docker 的服务器 |
| 手动源码部署 | 10+ 步 | ⭐⭐⭐⭐ | 高内存服务器（≥4GB） |

### Docker Compose 方案

如果服务器已安装 Docker，也可以用 Docker：

```powershell
# 本机构建镜像
docker build -t openclaw-aitown .
docker save openclaw-aitown -o openclaw-aitown.tar
scp openclaw-aitown.tar root@你的服务器IP:/tmp/
```

```bash
# 服务器加载并运行
docker load -i /tmp/openclaw-aitown.tar
docker run -d \
  --name openclaw \
  --restart unless-stopped \
  -p 18789:18789 \
  -v ~/.openclaw:/home/node/.openclaw \
  openclaw-aitown
```

---

## 常见问题

### Q: 部署脚本报 Node.js 版本不够？

deploy-ecs.sh 会自动通过 nvm 安装 Node 22，不需要你手动操作。

### Q: pnpm install 在服务器上 OOM？

脚本已经加了 `--max-old-space-size=2048` 和 `--prod`（只装运行时依赖），通常不会 OOM。如果还是不行，先在服务器上加 swap：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### Q: 想用 root 直接运行？

不推荐，但如果是在容器/CI 中：

```bash
OPENCLAW_ALLOW_ROOT=1 node /opt/openclaw/openclaw.mjs gateway --port 18789 --bind lan
```

### Q: 如何卸载？

```bash
sudo systemctl stop openclaw
sudo systemctl disable openclaw
sudo rm /etc/systemd/system/openclaw.service
sudo systemctl daemon-reload
sudo userdel -r openclaw
sudo rm -rf /opt/openclaw
```

---

## 完整流程总结（3 条命令）

```powershell
# 本机：编译 + 打包
powershell scripts\pack-deploy.ps1

# 本机：上传
scp openclaw-deploy.tar.gz root@SERVER:/tmp/

# 服务器：一键部署
bash /tmp/deploy-ecs.sh /tmp/openclaw-deploy.tar.gz
```
