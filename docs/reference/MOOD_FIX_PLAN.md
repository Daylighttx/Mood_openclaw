# Mood 系统修复计划

## 问题清单（按严重程度排序）

### P0 — soc S 曲线泵太快，30min 到顶

**现象**：基线 soc=0.7 + S曲线 bonus=0.056/min(at peak) → lerp拉力只有 0.054/min → soc 一直卡在 1.0，只有 bonus 降到 lerp 以下时才回落（约40分钟后）。

**根因**：S曲线系数 `0.08 × baseline(0.7) = 0.056` 的峰值 bonus 略大于 lerp 从 1.0 往 0.7 拉的力 `(1.0-0.7)×0.18 = 0.054`，导致短暂平台期。

**评估**：当前 0.08 已经是多次调试后的结果，平台期约 10 分钟。如果需要进一步缩短，可以降到 0.06。
- 0.06: 峰值 bonus=0.042 < lerp=0.054 → 永远不会到 1.0，峰值约 0.92
- 0.07: 峰值 bonus=0.049 < lerp=0.054 → 到不了 1.0
- 0.08: 峰值 bonus=0.056 > lerp=0.054 → 能到 1.0，平台约 10min ← 当前值
- 0.09: 平台约 15min

**建议**：保持 0.08。10 分钟的平台期是合理的——被冷落后短暂地"还想聊"，然后自然冷却。

---

### P1 — energy 几乎不变，门槛形同虚设

**现象**：`energyDecay = 0.00167/min`，`energyRecovery = 0.00139/min`，净变 `-0.00028/min`。24小时才从 1.0 降到 0.6。

**影响**：`shouldActivate(energy>0.15)` 和 `shouldProactivelyMessage(energy>0.2)` 永远满足。energy 失去了"累了就不想说话"的语义。

**修复方案**：

```typescript
// src/agents/mood.ts — 修改 DEFAULT_MOOD_CONFIG
energyDecayMs: 4 * 60 * 60 * 1000,     // 4h从1→0 (原10h)
energyRecoveryMs: 6 * 60 * 60 * 1000,  // 6h从0→1 (原3h)

// 恢复系数从 0.25 → 0.15（净变稍微负，idle 时缓慢下降）
const energyRecoveryFromRest = elapsed / this.config.energyRecoveryMs * 0.15;

// 效果:
// 消耗 = 1/4h = 0.00417/min
// 恢复 = 0.15/6h = 0.00042/min
// 净变 = -0.00375/min
// 4h后: eng从1.0降到0.1  ← 能量真的会"用完"
// onInteraction 也多加一点消耗: eng -= 0.05 (原0.03)
```

---

### P2 — concern 累积式增长过快

**现象**：
```typescript
// 当前: 每个 tick 都根据 idleSec 计算完整 bonus 然后叠加
const concernBonus = ((idleSec - 7200) / 7200) * 0.02;
this.state.concern = clamp(this.state.concern + concernBonus);
// 问题是 ADD(不是SET)：第N次tick叠加了相当于 idle=N 时的全量bonus
```

**修复方案**：改为增量式——只加从上一次 tick 到现在的 delta：

```typescript
// 只加这段时间的新增量，不重复叠加
const prevBonus = lastConcernBonus || 0;
const fullBonus = Math.max(0, ((idleSec - 7200) / 7200) * 0.02);
const delta = fullBonus - prevBonus;
if (delta > 0) {
    this.state.concern = clamp(this.state.concern + delta);
    this._lastConcernBonus = fullBonus;
}
```

但这样改了之后 concern 会涨很慢。需要调大系数 `0.02 → 0.06`：
- 增量式 0.06: 每小时 +0.05 → 20h 到 1.0

**或者**：直接用 lerp 方式让 concern 向 idle-based 目标值回归：

```typescript
// 更简单的方案：concern 的目标值 = idleFunction(idleSec)
const targetConcern = Math.min(1, 0.1 + Math.max(0, (idleSec - 7200) / 7200) * 0.3);
this.state.concern = lerp(this.state.concern, targetConcern, t);
```

**建议**：用 lerp 方案，逻辑干净，手动调也直观。

---

### P3 — S曲线 idle bonus 需要 lastInteractionAt > 0

**现象**：
```typescript
if (idleSinceInteraction > 0 && this.lastInteractionAt > 0) {
    // S曲线...
}
```
`lastInteractionAt = 0` → 永不过。v30 用 `lastInteractionAt = now` 做了 workaround，但语义不对（"刚聊过"和"从未聊过"应该有不同的 behavior）。

**修复方案**：第一次互动前（lastInteractionAt=0），给一个温和的初始上升：

```typescript
if (this.lastInteractionAt === 0) {
    // 从未互动：soc 温和地向 1.0 趋近（模拟 "想交朋友"）
    // 但不是 S 曲线的 idle bonus，而是主动探索的新交友社交欲
    const warmupBonus = Math.min(1, (now - this.lastUpdatedAt) / (60 * 60 * 1000)) * 0.3;
    this.state.sociability = lerp(this.state.sociability, 0.9, warmupBonus);
}
```

---

### P4 — fallback 规则与 LLM 提示词采用不同的决策逻辑

**现象**：LLM 看到的是"你有新话题吗？用户回了吗？"，fallback 用的是 `urgency >= threshold && shouldProactivelyMessage()`。两套完全不同的标准。

**修复方案**：统一。在 fallback 也注入同样的上下文检查：

```typescript
prepareActionFallback(...) {
    // 新加：跟 LLM 提示词一样的条件
    if (this.unansweredProactiveCount >= 2) return null;      // 发了2条没回 → 闭嘴
    if (this.recentProactiveTopics.length >= 3) {
        const lastTopic = this.recentProactiveTopics[this.recentProactiveTopics.length-1];
        if (now - lastTopic.ts < 30 * 60 * 1000) return null; // 30min内刚说过 → 跳过
    }
    // ...原有规则...
}
```

---

### P5 — concern 偏高 + energy 影响太小导致所有维度不够区分

**现象**：cur/soc/con/eng 在大多数情况下都接近基线，只有 soc 因为有 S 曲线会动。cur 只在 onInteraction 时 ×0.95（变化很小），con 只走累积，eng 几乎不变。

**修复方案**：给 cur 和 con 也加闲置行为：

```typescript
// advanceTime 中新增：闲置好奇心
// 没人互动 → 好奇心慢慢衰减（没新信息，不探索了）
if (idleSinceInteraction > 30 * 60 * 1000) {  // 30min idle
    this.state.curiosity = lerp(this.state.curiosity, 0.3, t * 0.5);
}
```

---

## 实施步骤

| 步骤 | 修复 | 影响文件 | 风险评估 |
|------|------|---------|---------|
| Step 1 | energy 衰减加速 | mood.ts | 低 — 纯数值调整 |
| Step 2 | concern 改用 lerp | mood.ts | 中 — 公式重写 |
| Step 3 | idle curiosity 衰减 | mood.ts | 低 — 新增逻辑 |
| Step 4 | fallback 同步 LLM 条件 | thinking-loop.ts | 低 — 条件追加 |
| Step 5 | 首次启动 warmup | mood.ts | 低 — 替换 v30 workaround |
| Step 6 | sim 复验 | sim-mood.mjs | — |
| Step 7 | 部署 | — | — |

每个 step 独立可验证，互不依赖。建议从 Step 1 开始。
