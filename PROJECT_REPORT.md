# 社交 AI Agent 技术报告 (v48)

## 一、项目概述

基于 OpenClaw 框架构建的**双 LLM 主动社交 AI Agent**。核心创新：

- **情绪引擎**：4 维连续数值情绪 + 8 个公式实时演进（S 曲线、昼夜节律、被冷落惩罚、情绪耦合）
- **自主决策**：每分钟审视 mood + memory + personality，自主决定是否说话
- **人格复刻**：LLM 分析聊天记录 → 自动生成 personality 配置 + SOUL.md
- **自我进化**：每 12 小时 LLM 审视行为模式，自主调参

---

## 二、双 LLM 架构全景

```
                    ┌──────────────────────────────┐
                    │     mind-config.json         │
                    │  ┌───────────┐ ┌──────────┐ │
                    │  │personality│ │moodConfig │ │
                    │  └─────┬─────┘ └────┬─────┘ │
                    └────────┼─────────────┼───────┘
                             │             │
              ┌──────────────┼──────┐      │
              │  persona-import      │      │
              │  --update-config     │      │
              │       │              │      │
              │       ▼              │      │
              │  workspace/          │      │
              │  SOUL.md             │      │
              └──────┬───────────────┘      │
                     │                      │
      ┌──────────────▼──────────┐  ┌───────▼──────────────┐
      │    对话 LLM            │  │   思维 LLM           │
      │  (Chat)                │  │  (Proactive Think)    │
      │                        │  │                      │
      │  读取:                 │  │  读取:               │
      │  - SOUL.md (身份)      │  │  - personality 配置   │
      │  - mood 情绪状态       │  │  - mood 实时值        │
      │  - 对话历史            │  │  - SQLite 记忆        │
      │  - OpenClaw 系统提示词 │  │  - 自己说过的话      │
      │                        │  │  - 未回复计数         │
      │  做: 回复用户消息      │  │                      │
      │                        │  │  做: 决策+主动发消息  │
      └────────────────────────┘  └──────────────────────┘
```

### 两个 LLM 读什么

| | 对话 LLM | 思维 LLM |
|------|:---:|:---:|
| 身份（名字/性格） | SOUL.md（OpenClaw base prompt 内置） | mind-config.json personality |
| 说话风格 | SOUL.md | buildPersonalityPrompt() 展开 |
| 情绪数值 | buildMindSystemPromptSection 注入 | mood.getMood() 直接读 |
| 记忆/对话历史 | OpenClaw session context | SQLite listMemories() |
| 自己说过的话 | — | recentProactiveContents |
| 今天发了多少条 | — | proactiveToday |
| 用户回复了没 | — | unansweredProactiveCount |

---

## 三、情绪系统 — 4 维 × 8 公式

```
MoodState { curiosity, sociability, energy, concern }  0~1 连续值
```

| # | 公式 | 作用 | 触发条件 |
|---|------|------|---------|
| ① | lerp 基线回归 | cur/soc 向基线自然恢复 | 每 tick |
| ② | S 曲线社交欲 | 闲置越久越想聊，有峰值然后回落 | 闲置 > 0 |
| ③ | 闲置好奇衰减 | 没人互动就觉得无聊 | 闲置 > 30min |
| ④ | 担忧 lerp | 长时间不联系会挂念 | 闲置 > 2h |
| ⑤ | 被冷落惩罚 | 问了你不理 → 好奇心大幅下降 | sent msg + 闲置 > 1h |
| ⑥ | 昼夜节律 | 凌晨精力回升，社交欲封顶 0.5 | 00-06/06-10/22-24 |
| ⑦ | 精力平衡 | 白天 net=0 稳定，深夜 net>0 回升 | 每 tick |
| ⑧ | 情绪耦合 | 高担忧压制 soc / 兴奋增强 cur / 焦虑不社交 | 阈值触发 |

### key 参数 — 全部 mind-config.json 可配

| 参数 | 默认 | 作用 |
|------|------|------|
| sCurveMultiplier | 0.08 | 闲置后多想说话（粘人度） |
| sCurvePeakMinutes | 30 | 闲置多久达到社交欲峰值 |
| neglectCuriosityPenalty | 0.3 | 被冷落时好奇下降有多快 |
| nightSocCap | 0.5 | 深夜社交欲上限 |
| decayRate | 0.003 | 情绪回归基线速率 |
| energyDecayMs | 4h | 精力消耗标称时间 |
| energyRecoveryMs | 1h | 精力恢复标称时间 |

### 情绪耦合规则

```
concern > 0.8 → soc 被强行拉向 0.3（极度担忧 → 不想社交）
energy > 0.7 && soc > 0.7 → cur 被拉向 ≥0.5（兴奋 → 好奇也高）
energy < 0.25 && concern > 0.6 → soc 被拉向 0.2 + cur 被拉向 ≥0.6（焦虑：不社交但反刍式思考）
```

---

## 四、决策链 — 渐进式退却门控

```
每分钟 heartbeat → tick() → prepareAction()

门控（6层, 都在 LLM 调用之前）:
  ① cooldown         now - lastThoughtAt < 5min → 跳过
  ② 日上限            proactiveToday >= 48 → 跳过
  ③ 用户还在聊        userLastMessageAt < 5min → 跳过
  ④ 安静时段          用户配置免打扰 → 跳过
  ⑤ mood 惩罚         shouldActivate(mood, unansweredCount)
                      count=0 → drive×1.0
                      count=1 → drive×0.5 → harder to trigger
                      count=2 → drive×0.2 → very rare
                      count≥3 → drive×0   → never trigger
  ⑥ 通过的 → 调 LLM
```

**渐进式退却原理**：不发消息时 `unansweredCount` 递增 → `shouldActivate` 的 penalty 增大 → mood 需要涨到更高才能突破门槛 → retry 时间由 mood 自然决定（不是定时器）。

---

## 五、人格复刻 — Persona Import

```bash
node persona-import.mjs chat.jsonl \
  --target CHAR_NAME --user USER_NAME \
  --update-config
```

| 输出 | 消费者 | 作用 |
|------|--------|------|
| `mind-config.json` → `personality` | 思维 LLM | 构建 prompt 用的名字/身份/风格 |
| `mind-config.json` → `moodConfig` | mood 引擎 | S曲线/冷落惩罚/夜间帽等参数 |
| `workspace/SOUL.md` | 对话 LLM | 身份在 base prompt 中，不每轮注入 |

---

## 六、自我进化

### Relationship 迭代
每 6h 或 8 轮对话 → LLM 审视关系变化 → 更新 relationship.description

### Personality 自适应
每 12h → LLM 审视行为+情绪 → 自主调参 ±20%

```
LLM 决策: "太粘人了" → sCurveMultiplier 从 0.08 降到 0.06
         "被冷落太多" → neglectPenalty 从 0.3 升到 0.38
```

两层安全：prompt 约束 ±20% + 代码硬限制 ±30%

---

## 七、反重复机制

```
思维 LLM prompt 末尾:
  You recently said:
  - "雨天窝在家里太享受了～"
  - "今天天气不错"

  DO NOT repeat these same sentiments.
```

追踪最近 5 条主动消息的完整内容，LLM 看到自己说过什么不会再重复。

---

## 八、与主流产品对比

| 维度 | 本项目 | 豆包/ChatGPT | Character.AI |
|------|:---:|:---:|:---:|
| 主动性 | ✅ 自主思考+发送 | ❌ 纯被动 | ⚠️ 提示式 |
| 情绪系统 | ✅ 4维连续值+8公式 | ❌ | ⚠️ 固定 |
| 自我进化 | ✅ 12h 自主调参 | ❌ | ❌ |
| 被冷落反馈 | ✅ "不理我→没意思" | ❌ | ❌ |
| 关系演进 | ✅ 吵架后自动更新 | ❌ | ❌ |
| 人格复刻 | ✅ 聊天记录→自动 | ❌ 手动 | ⚠️ 手动 |
| 反重复 | ✅ 追踪自己说的话 | ❌ | ❌ |
| 门控防护 | ✅ 6层+渐进退却 | ❌ | ❌ |
| Token 效率 | ✅ 静态 SOUL.md | — | — |
| 多平台 | ✅ QQ/Discord/Telegram | ⚠️ 单App | ⚠️ Web |
| 全配置驱动 | ✅ 一个 JSON 换人 | ❌ | ⚠️ |

---

## 九、配置体系

```
mind-config.json  ← 唯一配置文件
  ├─ llm          ← 思维 LLM 的 API 配置
  ├─ personality  ← 身份/性格（思维 LLM 读）
  ├─ moodConfig   ← 30+ 情绪参数
  └─ thinkingConfig ← 门控阈值

workspace/SOUL.md  ← 对话 LLM 身份（OpenClaw base prompt 内嵌）
```

---

## 十、源码

| 模块 | 文件 | 行数 |
|------|------|:---:|
| 情绪引擎 | `src/agents/mood.ts` | 425 |
| 决策循环 | `src/memory/thinking-loop.ts` | 600 |
| Agent 总控 | `src/memory/agent-mind.ts` | 450 |
| 桥接层 | `src/memory/agent-mind-bridge.ts` | 380 |
| 人格定义 | `src/agents/personality.ts` | 110 |
| 记忆存储 | `src/memory/store.ts` | 250 |
| 人格导入 CLI | `scripts/persona-import.mjs` | 450 |
| **总计** | | **~2665 行** |

---

## 十一、一句话

> **不是你在跟 AI 聊天，是 AI 在跟你做朋友——它有自己的情绪、记忆、性格，会主动找你，被冷落会难过，凌晨会困，相处久了性格还会自己变。**
