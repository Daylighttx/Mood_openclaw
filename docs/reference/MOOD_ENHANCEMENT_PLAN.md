# Mood 增强计划 v2

## Phase 1: 时间感知精力调节（昼夜节律）

**问题**：精力只依赖 `lastInteractionAt`，没有真实世界的昼夜概念。Agent 凌晨和下午精力一样。

**方案**：在 `advanceTime` 中根据当前时区小时数调整能量平衡。

### 改动位置

```typescript
// src/agents/mood.ts — advanceTime 方法内，energy 计算段

// 现有代码（L121-L124）:
const energyDecay = elapsed / this.config.energyDecayMs;
this.state.energy = clamp(this.state.energy - energyDecay);
const energyRecoveryFromRest = elapsed / this.config.energyRecoveryMs * 0.25;
this.state.energy = clamp(this.state.energy + energyRecoveryFromRest);

// → 改为:
const hour = new Date(now).getHours();
const isQuietHour = hour >= 0 && hour < 6;  // 凌晨 0-6 点
const isActiveHour = hour >= 10 && hour <= 22; // 上午 10 点-晚上 10 点

let decayMultiplier = 1.0;
let recoveryMultiplier = 1.0;

if (isQuietHour) {
    decayMultiplier = 0.2;      // 消耗降到 20%（睡觉）
    recoveryMultiplier = 2.0;   // 恢复翻倍
} else if (!isActiveHour) {
    decayMultiplier = 0.6;      // 早晨/傍晚 消耗降低
    recoveryMultiplier = 1.2;   // 恢复略高
}

const energyDecay = elapsed / this.config.energyDecayMs * decayMultiplier;
this.state.energy = clamp(this.state.energy - energyDecay);
const energyRecoveryFromRest = elapsed / this.config.energyRecoveryMs * 0.25 * recoveryMultiplier;
this.state.energy = clamp(this.state.energy + energyRecoveryFromRest);
```

### 同时：安静时段抑制 soc 上限

在 S 曲线 bonus 计算后追加：

```typescript
// S曲线bonus后
if (isQuietHour) {
    const nightCap = 0.5;  // 深夜社交欲上限
    if (this.state.sociability > nightCap) {
        this.state.sociability = lerp(this.state.sociability, nightCap, t);
    }
}
```

### 模拟验证

| 时段 | decay | recovery | soc cap | 行为 |
|------|-------|----------|---------|------|
| 00-06 | ×0.2 | ×2.0 | 0.5 | 深度休息，不想说话 |
| 06-10 | ×0.6 | ×1.2 | 无 | 慢慢醒来 |
| 10-22 | ×1.0 | ×1.0 | 无 | 正常活跃 |
| 22-00 | ×0.6 | ×1.2 | 无 | 准备入睡 |

---

## Phase 2: 好奇心遗忘机制

**问题**：主动发了消息用户不理，cur 只会衰减到 baseline 0.8，不会真正"失望"。

**方案**：在 `advanceTime` 中增加"被冷落惩罚"——当 idle > 1 小时且 sent 了消息但没回复，大幅降低 cur。

### 改动位置

```typescript
// src/agents/mood.ts — advanceTime 方法内，soc S曲线段之后

// 新增：如果发了消息超过1小时用户没回 → 好奇心大幅下降
const idleSeconds = idleSinceInteraction / 1000;
if (idleSeconds > 3600 && this._pendingMessagesSinceLastReply > 0) {
    // 有发消息但用户没回超过1小时
    const neglectFactor = Math.min((idleSeconds - 3600) / 7200, 1); // 1-3h → 0→1
    const curiosityPenalty = neglectFactor * 0.3;
    this.state.curiosity = clamp(this.state.curiosity - curiosityPenalty * t);
    // t ≈ 0.18, 所以每 tick 减约 0.05 → 20分钟降0.3
}
```

需要新增一个内部状态追踪 `_pendingMessagesSinceLastReply`：
- 发 proactive_message 时 +1
- 用户互动时清零

```typescript
// 在 AgentMood 类中新增:
private _pendingMessagesSinceLastReply: number = 0;

// 新增公共方法:
markProactiveSent(): void {
    this._pendingMessagesSinceLastReply++;
}

markUserReplied(): void {
    this._pendingMessagesSinceLastReply = 0;
}
```

### 在 bridge 中调用

```typescript
// src/memory/agent-mind-bridge.ts
// mindOnHeartbeat — 当 agent 发了 proactive 消息:
mind.getMood().markProactiveSent();

// mindOnInboundMessage — 用户回了消息:
mind.getMood().markUserReplied();
```

---

## Phase 3: 情绪互斥与耦合

**问题**：cur/soc/eng/con 四维完全独立，缺乏心理学上的联动。

**方案**：在 `advanceTime` 末尾增加耦合逻辑。

### 改动位置

```typescript
// src/agents/mood.ts — advanceTime 方法末尾，before lastUpdatedAt

// 1. 极度担忧压制社交欲
if (this.state.concern > 0.8) {
    this.state.sociability = lerp(this.state.sociability, 0.3, t * 0.5);
}

// 2. 高精力 + 高社交欲 = 好奇心也高（兴奋状态）
if (this.state.energy > 0.7 && this.state.sociability > 0.7) {
    this.state.curiosity = lerp(this.state.curiosity, 
        Math.max(this.state.curiosity, 0.5), t * 0.3);
}

// 3. 极度疲惫 + 高担忧 = 焦虑（不应社交，好奇心上升）
if (this.state.energy < 0.25 && this.state.concern > 0.6) {
    this.state.sociability = lerp(this.state.sociability, 0.2, t * 0.5);
    this.state.curiosity = lerp(this.state.curiosity, 
        Math.max(this.state.curiosity, 0.6), t * 0.2);
}
```

---

## Phase 4: 配置外置化

**问题**：关键行为参数硬编码在 `mood.ts` 中，需要重新编译才能调。

**方案**：在 `mind-config.json` 中新增 `moodConfig` 和 `behaviorConfig` 段，所有魔法数字可配。

### mind-config.json 新增字段

```json
{
  "moodConfig": {
    "decayRate": 0.003,
    "idleConcernRiseMs": 7200000,
    "postInteractionCooldownMs": 900000,
    "energyDecayMs": 14400000,
    "energyRecoveryMs": 3600000,
    "sCurveMultiplier": 0.08,
    "sCurvePeakMinutes": 30,
    "curiosityIdleDecayStartMin": 30,
    "curiosityIdleDecayDurationMin": 120,
    "curiosityIdleDecayTarget": 0.2,
    "concernRiseStartMin": 120,
    "concernRiseDurationMin": 480,
    "concernMax": 1.0
  },
  "behaviorConfig": {
    "onInteractionSocMultiplier": 0.85,
    "onInteractionCurMultiplier": 0.95,
    "onInteractionEngCost": 0.05,
    "onSuppressedDampeningPerUnit": 0.01,
    "onSuppressedDampeningMax": 0.3,
    "onReflectionCurBoost": 0.1,
    "onReflectionEngBoost": 0.05,
    "nightHours": { "start": 0, "end": 6 },
    "nightDecayMultiplier": 0.2,
    "nightRecoveryMultiplier": 2.0,
    "nightSocCap": 0.5,
    "neglectCuriosityPenalty": 0.3,
    "neglectPenaltyStartSeconds": 3600,
    "highConcernSociabilityTarget": 0.3,
    "highConcernThreshold": 0.8
  }
}
```

### 代码改动

构造函数中合并 config，暴露到 `getMoodConfig()` 供 thinking-loop 读取。

---

## Phase 5: 精细化 mood 描述

**问题**：`getMoodDescription()` 只用简单的 if/else 生成"feeling social"等单一标签。

**方案**：根据数值组合生成更有层次的情绪描述。

```typescript
getMoodDescription(): string {
    const mood = this.getMood();
    const { curiosity, sociability, energy, concern } = mood;

    // 复合情绪优先
    if (sociability > 0.85 && energy < 0.25) return "restless — wants to connect but exhausted";
    if (sociability > 0.85 && energy > 0.7) return "eager to chat, full of energy";
    if (concern > 0.7 && energy < 0.3) return "anxious and drained";
    if (concern > 0.5 && sociability < 0.3) return "worried, preferring solitude";
    if (curiosity < 0.3 && sociability > 0.7) return "chatty but not intellectually engaged";
    if (curiosity > 0.7 && sociability < 0.3) return "deep in thought, doesn't want to talk";
    if (energy < 0.2) return "exhausted, need rest";
    if (energy > 0.9 && curiosity > 0.7) return "bright and inquisitive";

    // 单一维度 fallback
    const parts: string[] = [];
    if (sociability > 0.7) parts.push("sociable");
    else if (sociability < 0.3) parts.push("withdrawn");
    if (curiosity > 0.7) parts.push("curious");
    else if (curiosity < 0.3) parts.push("indifferent");
    if (energy < 0.3) parts.push("tired");
    else if (energy > 0.8) parts.push("energetic");
    if (concern > 0.5) parts.push("uneasy");
    if (parts.length === 0) parts.push("balanced");
    return parts.join(", ");
}
```

---

## 实施顺序

| Phase | 改动文件 | 预计改动行数 | 独立可测 |
|-------|---------|------------|---------|
| P1 昼夜节律 | mood.ts | +25 | ✅ |
| P1 sim 验证 | sim-mood.mjs | +15 | ✅ |
| P2 好奇心遗忘 | mood.ts + bridge.ts | +25 | ✅ |
| P3 情绪耦合 | mood.ts | +15 | ✅ |
| P4 配置外置 | mood.ts + config | +40 | ✅ |
| P5 描述优化 | mood.ts | +20 | ✅ |
| 全量 sim 复验 | sim-mood.mjs | — | ✅ |
| 编译 + test | — | — | ✅ |

每 phase 独立可回滚，不依赖其他 phase。
