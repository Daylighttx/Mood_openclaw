# Agent Mood 系统公式 & 决策链完整手册 (v36)

## 一、MoodState — 四个情绪维度

```typescript
// src/agents/mood.ts — L3-L7
interface MoodState {
  curiosity: number;    // 好奇心    0~1
  sociability: number;  // 社交欲    0~1
  energy: number;       // 精力      0~1
  concern: number;      // 担忧      0~1
}
```

### 基线来自 personality.traits（mind-config.json 可配）

```typescript
// src/agents/mood.ts — L324-L334
static fromTraits(traits): AgentMood {
    return new AgentMood({
        curiosity: traits.curiosity,     // 默认 0.8
        sociability: traits.sociability, // 默认 0.7
        energy: 1.0,
        concern: 0.1,
    });
}
```

### 初始化：lastInteractionAt = now

```typescript
// L82-L84 — v30 修复: 新 agent 启动后 S 曲线自然启动
const now = Date.now();
this.lastUpdatedAt = now;
this.lastInteractionAt = now;
```

---

## 二、advanceTime — 每 tick 引擎（每分钟 heartbeat 调用一次）

每次 `getMood()` 必修此方法。执行顺序 = 公式①②③④⑤⑥⑦⑧。

```typescript
// src/agents/mood.ts — L94-L176
private advanceTime(now: number): void {
    const elapsed = now - this.lastUpdatedAt;
    if (elapsed <= 0) return;

    const t = Math.min(this.config.decayRate * (elapsed / 1000), 1);
    //        = Math.min(0.003 × 60, 1) = 0.18   (每分钟)
    const idleSinceInteraction = now - this.lastInteractionAt;
    const idleMinutes = idleSinceInteraction / 60_000;
```

### 公式 ① — lerp（基线回归）

```typescript
// L56-L58
function lerp(from, to, t): number {
    return clamp(from + (to - from) * t);
}
```

**每分钟（t=0.18）**：
```
cur_new = cur_old + (target - cur_old) × 0.18
soc_new = soc_old + (0.7 - soc_old) × 0.18
```

### 公式 ② — S 曲线闲置社交欲

```typescript
// L105-L108
const raw = idleMinutes / (this.config.sCurvePeakMinutes ?? 30);
const curve = raw * Math.exp(1 - raw);
sociabilityBonus = Math.max(0, curve * this.baselines.sociability * 
    (this.config.sCurveMultiplier ?? 0.08));
// L136-L138: bonus 为叠加式（非 lerp），直接加到 soc 上
this.state.sociability = clamp(this.state.sociability + sociabilityBonus);
```

```
raw     = idleMinutes / 30          ← 峰值 30 分钟 (sCurvePeakMinutes 可配)
curve   = raw × e^(1-raw)           ← S曲线: 0→1(峰值)→0
bonus   = max(0, curve × 0.7 × 0.08) ← sCurveMultiplier 可配
soc    += bonus                     ← 叠加到当前值（不是 lerp）

数值表 (multiplier=0.08, baseline=0.7):
  5min: raw=0.17   curve=0.39   bonus=+0.022
 15min: raw=0.50   curve=0.82   bonus=+0.046
 30min: raw=1.00   curve=1.00   bonus=+0.056  ← 峰值
 45min: raw=1.50   curve=0.91   bonus=+0.051
 60min: raw=2.00   curve=0.74   bonus=+0.041
 90min: raw=3.00   curve=0.41   bonus=+0.023
120min: raw=4.00   curve=0.20   bonus=+0.011
```

**关键**：bonus 是**加法叠加**不是 lerp。soc 同时被 lerp 往基线 0.7 拉，两者博弈决定 net 方向。

### 公式 ③ — 闲置好奇心衰减

```typescript
// L110-L114
if (concernMinutes > 30) {
    curiosityTarget = 0.8 - Math.min((concernMinutes - 30) / 120, 1) * 0.5;
    if (curiosityTarget < 0.2) curiosityTarget = 0.2;
}
```

```
闲置 0-30min:   target = 0.8（基线）
闲置 30min:      target = 0.80 → 开始降
闲置 60min:      target = 0.8 - (30/120)×0.5 = 0.675
闲置 90min:      target = 0.8 - (60/120)×0.5 = 0.550
闲置 150min(2.5h): target = 0.2（floor）
```

curiosity 通过 lerp 趋近这个 target，所以实际下降是缓慢平滑的。

### 公式 ④ — 担忧（lerp 方式）

```typescript
// L116-L121 (闲置) / L122-L124 (非闲置)
if (concernMinutes > 120) {
    const targetConcern = 0.1 + Math.min((concernMinutes - 120) / 480, 1) * 0.9;
    this.state.concern = lerp(this.state.concern, targetConcern, t);
} else {
    this.state.concern = lerp(this.state.concern, 0.1, t);  // 回归基线
}
```

```
0-2h:   target = 0.1 → con 向 0.1 回归（不担心）
2h:     target 从 0.1 开始上升
6h:     target = 0.1 + (240/480)×0.9 = 0.55
10h:    target = 1.0（封顶）
```

**关键改变（v31）**：从旧的累积叠加改为 lerp 趋近目标——con 不会每 tick 爆炸式增长。

### 公式 ⑤ — 被冷落惩罚（Neglect Penalty）

```typescript
// L127-L133 — v32 新增
if (idleSinceInteraction > 0 && this._pendingMessagesSinceLastReply > 0) {
    const idleSec = idleSinceInteraction / 1000;
    if (idleSec > 3600) {  // 超过 1 小时
        const neglectFactor = Math.min((idleSec - 3600) / 7200, 1); // 1h→0, 3h→1
        this.state.curiosity = clamp(
            this.state.curiosity - neglectFactor * (neglectCuriosityPenalty ?? 0.3) * t
        );
    }
}
```

**触发条件**：发了 proactive 消息 + 用户 >1h 没回。

```
1h:   neglectFactor=0      → 无惩罚
2h:   neglectFactor=0.5    → cur -= 0.5×0.3×0.18 = 0.027/tick
3h:   neglectFactor=1.0    → cur -= 1.0×0.3×0.18 = 0.054/tick (最大)
```

*"我问了你不理我，没意思。"*

### 公式 ⑥ — 昼夜节律（Circadian）

```typescript
// L141-L162 — v32 新增
const hour = new Date(now).getHours();
const isDeepNight  = hour >= 0  && hour < 6;   // 凌晨 0-6
const isTwilight   = (hour >= 6 && hour < 10) || (hour >= 22);

let decayMultiplier = 1.0, recoveryMultiplier = 1.0;
if (isDeepNight)       { decayMultiplier = 0.2;  recoveryMultiplier = 2.0; }
else if (isTwilight)   { decayMultiplier = 0.6;  recoveryMultiplier = 1.2; }

// 深夜 soc 上限
if (isDeepNight && soc > (nightSocCap ?? 0.5)) {
    this.state.sociability = lerp(this.state.sociability, nightSocCap, t);
}

const energyDecay = elapsed / (4h) * decayMultiplier;
this.state.energy = clamp(energy - energyDecay);
const energyRecovery = elapsed / (1h) * 0.25 * recoveryMultiplier;
this.state.energy = clamp(energy + energyRecovery);
```

| 时段 | decay | recovery | soc cap | 行为 |
|------|-------|----------|:-------:|------|
| 00-06 深夜 | ×0.2 | ×2.0 | 0.5 | 睡觉：精力恢复，不想说话 |
| 06-10 晨 | ×0.6 | ×1.2 | 无 | 慢慢醒来 |
| 10-22 白天 | ×1.0 | ×1.0 | 无 | 正常活跃 |
| 22-24 黄昏 | ×0.6 | ×1.2 | 无 | 准备休息 |

### 公式 ⑦ — 精力平衡（Energy）

```typescript
// L158-L162 — v31 优化
const energyDecay = elapsed / (4h) * decayMultiplier;       // 0.00417/min (白天)
const energyRecovery = elapsed / (1h) * 0.25 * recoveryMultiplier; // 0.00417/min (白天)
// 白天 net=0 → 精力稳定，深夜 net>0 → 精力回升
```

```
白天: decay=0.00417/min, recovery=0.00417/min → net=0 (稳定)
深夜: decay=0.00083/min, recovery=0.00833/min → net=+0.0075/min (回升)
```

### 公式 ⑧ — 情绪耦合（Cross-dimension Coupling）

```typescript
// L164-L173 — v32 新增
// 1. 极度担忧 → 压制社交欲
if (this.state.concern > 0.8) {
    this.state.sociability = lerp(this.state.sociability, 0.3, t * 0.5);
}
// 2. 高精力 + 高社交 → 兴奋（cur 也涨）
if (this.state.energy > 0.7 && this.state.sociability > 0.7) {
    this.state.curiosity = lerp(this.state.curiosity, 
        Math.max(this.state.curiosity, 0.5), t * 0.3);
}
// 3. 低精力 + 高担忧 → 焦虑（不社交但好奇）
if (this.state.energy < 0.25 && this.state.concern > 0.6) {
    this.state.sociability = lerp(this.state.sociability, 0.2, t * 0.5);
    this.state.curiosity = lerp(this.state.curiosity, 
        Math.max(this.state.curiosity, 0.6), t * 0.2);  // 焦虑时反刍式好奇
}
```

**耦合规则优先级**：三种状态互斥（不会同时激活），高担忧优先于焦虑。

---

## 三、事件驱动

### 用户发消息 — onInteraction

```typescript
// L202-L218
onInteraction(): void {
    this.advanceTime(now);
    this.lastInteractionAt = now;       // 重置闲置计时器

    this.state.sociability = clamp(soc * 0.85);  // floor 0.15
    this.state.curiosity   = clamp(cur * 0.95);  // floor 0.2
    this.state.concern     = clamp(con * 0.95);  // floor 0.05
    this.state.energy      = clamp(eng - 0.05);
}
```

### 被规则压制 — onSuppressed

```typescript
// L240-L245
onSuppressed(count): void {
    const dampening = Math.min(count × 0.01, 0.3);  // 每次 0.01, 上限 0.3
    soc -= dampening;
    cur -= dampening × 0.5;
}
```

### 反思 — onReflection

```typescript
// L234-L238
cur += 0.1;  eng += 0.05;
```

### 重要事件 — onImportantEvent

```typescript
// L226-L232
impact = importance / 9;
cur += impact × 0.2;  con += impact × 0.15;  eng += impact × 0.1;
```

### 标记主动消息/用户回复（用于 Neglect Penalty）

```typescript
// L247-L253
markProactiveSent(): void { this._pendingMessagesSinceLastReply++; }
markUserReplied(): void  { this._pendingMessagesSinceLastReply = 0; }
```

---

## 四、决策阈值

### shouldActivate — LLM 思考激活（门控⑤）

```typescript
// thinking-loop.ts
const thinkingDrive = cur × 0.4 + soc × 0.3 + eng × 0.3;
return thinkingDrive > 0.3 && eng > 0.15;
```

### shouldProactivelyMessage — 该不该主动说话

```typescript
// L255-L269
const desireToMessage = soc × 0.5 + cur × 0.25 + con × 0.25;
return desireToMessage > 0.55 && eng > 0.2;
```

### getProactiveUrgency — 紧迫度

```typescript
// L271-L275
const desire = soc × 0.5 + cur × 0.25 + con × 0.25;
return max(0, (desire - 0.5) × 2);
```

### getMoodDescription — LLM 看到的情绪文本（v32 优化）

```typescript
// L281-L303 — 复合情绪优先，单一维度 fallback
if (soc > 0.85 && eng < 0.25) → "restless — wants to connect but exhausted"
if (soc > 0.85 && eng > 0.7)  → "eager to chat, full of energy"
if (con > 0.7 && eng < 0.3)   → "anxious and drained"
if (con > 0.5 && soc < 0.3)   → "worried, preferring solitude"
if (cur < 0.3 && soc > 0.7)   → "chatty but not intellectually engaged"
if (cur > 0.7 && soc < 0.3)   → "deep in thought, doesn't want to talk"
if (eng < 0.2)                → "exhausted, needs rest"
if (eng > 0.9 && cur > 0.7)   → "bright and inquisitive"
// fallback: "sociable, curious, energetic" / "withdrawn, indifferent, tired"
```

---

## 五、LLM 决策链 — 6 层门控

```typescript
// thinking-loop.ts — prepareAction()
prepareAction():
    ① cooldown?                now - lastThoughtAt < minIntervalMs(5min) → return
    ② 日上限?                  proactiveToday >= 48 → return
    ③ 用户还在聊?              now - userLastMessageAt < 5min → return
    ④ 安静时段?                isQuietHour() → return
    ⑤ 用户没回?                unansweredProactiveCount >= 1 → return  ← v34 新增
    ⑥ mood 门槛?               shouldActivate(mood) → thinkingDrive > 0.3

    → 全通过 → 调 LLM
```

---

## 六、四维相互作用一览

```
                    ┌──────────┐
        ┌──────────→│ curiosity │←──────────┐
        │           └─────┬─────┘           │
        │  idle decay     │  excited耦合     │
        │  neglect惩罚    │  anxious耦合     │
        │                 │                  │
   ┌────┴────┐      ┌─────┴─────┐      ┌────┴────┐
   │ concern │      │sociability│      │ energy  │
   └────┬────┘      └─────┬─────┘      └────┬────┘
        │  high con→soc↓  │  S曲线pump      │
        │                 │  night cap      │  circadian
        │                 │                 │  recovery
        └─────────────────┴─────────────────┘
              shouldProactivelyMessage
              desire = soc×0.5+cur×0.25+con×0.25
```

---

## 七、mind-config.json 可配参数

```json
{
  "moodConfig": {
    "decayRate": 0.003,
    "energyDecayMs": 14400000,
    "energyRecoveryMs": 3600000,
    "sCurveMultiplier": 0.08,
    "sCurvePeakMinutes": 30,
    "neglectCuriosityPenalty": 0.3,
    "nightSocCap": 0.5
  }
}
```

| 参数 | 默认 | 作用 |
|------|------|------|
| `sCurveMultiplier` | 0.08 | S曲线振幅。高=更粘人，低=更独立 |
| `sCurvePeakMinutes` | 30 | 闲置多少分钟后社交欲达到顶点 |
| `neglectCuriosityPenalty` | 0.3 | 被冷落时 curiosity 下降幅度 |
| `nightSocCap` | 0.5 | 深夜(0-6点)社交欲上限 |
| `decayRate` | 0.003 | lerp 回归速率，高=更快速回到基线 |
| `energyDecayMs` | 4h | 精力从 1→0 的标称时间 |
| `energyRecoveryMs` | 1h | 精力从 0→1 的标称时间 |

---

## 八、版本变更记录

| 版本 | 改动 |
|------|------|
| v29-v30 | S 曲线系数调至 0.08, concern 改 lerp, energy 平衡修正, lastInteractionAt=now |
| v31 | idle curiosity 衰减, concern lerp 公式重写, fallback 防重复 |
| v32 | P1 昼夜节律, P2 好奇遗忘, P3 情绪耦合, P4 配置外置, P5 描述优化 |
| v34 | 门控新增: unanswered≥1 不调 LLM |
| v35 | Memory 导入 CLI 工具, Relationship 迭代 |
| v36 | CLI 错误报告+config 多路径搜索 |
