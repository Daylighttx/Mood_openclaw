# 🏗️ AI Town 思考系统 — 架构文档

## 系统全景

```
                         ┌─────────────────────────────────────┐
                         │           OpenClaw Gateway          │
                         │    (Heartbeat / Cron / Channels)    │
                         └──────────────┬──────────────────────┘
                                        │ tick() / onInteraction()
                                        ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                          AgentMind                                  │
  │  ┌─────────────┐  ┌───────────────┐  ┌──────────────────────────┐  │
  │  │    Mood     │  │  Personality  │  │    ProactiveThinkingLoop │  │
  │  │  状态机     │  │   人格定义     │  │    Sense-Think-Act      │  │
  │  └──────┬──────┘  └───────────────┘  └────────────┬─────────────┘  │
  │         │                                          │                │
  │         ▼                                          ▼                │
  │  ┌──────────────────────────────────────────────────────────────┐   │
  │  │                   SemanticMemoryStore                        │   │
  │  │  SQLite ─── 记忆CRUD ─── 向量搜索 ─── 时间衰减 ─── 反思追踪  │   │
  │  └──────────┬───────────────┬───────────────┬───────────────────┘   │
  │             │               │               │                       │
  │             ▼               ▼               ▼                       │
  │    ┌────────────┐  ┌──────────────┐  ┌──────────────┐              │
  │    │ Embeddings │  │  Importance  │  │   Memory     │              │
  │    │  Provider  │  │   Scorer     │  │   Searcher   │              │
  │    └────────────┘  └──────────────┘  └──────────────┘              │
  └─────────────────────────────────────────────────────────────────────┘
```

## 分层架构

### Layer 1: 基础设施 (Infrastructure)

#### `types.ts` — 核心类型
```
SemanticMemory        → 记忆实体 (id, type, content, importance, embedding...)
MemorySearchResult    → 搜索结果 (relevanceScore, recencyScore, importanceScore)
ReflectionResult      → 反思结果 (insights, importance)
ConversationSummary   → 对话摘要 (participants, keywords, messages)
```

#### `store.ts` — SQLite 存储
```
SemanticMemoryStore
├── insertMemory()          → 插入记忆 (自动生成 ID、时间戳)
├── getMemory(id)           → 按 ID 查询
├── listMemories(options)   → 列表查询 (支持按 type、分页、排序)
├── searchMemories(vec)     → 向量相似度搜索 (余弦相似度 + 时间衰减 + 重要性加权)
├── deleteMemory(id)        → 删除记忆
├── memoryCount()           → 记忆总数
├── getReflectionState()    → 反思状态 (上次反思时间 + 累积重要性)
├── updateReflectionState() → 更新反思状态
└── getCumulativeImportance() → 累积重要性
```

**搜索算法**: 综合评分 = `relevance × 0.6 + recency × 0.25 + importance × 0.15`

**时间衰减**: `score = exp(-ln(2) × (age / halfLife))`，默认半衰期 30 天

#### `embeddings.ts` — 嵌入向量
```
EmbeddingProvider (接口)
├── embedQuery(text)  → Promise<number[]>
└── embedBatch(texts) → Promise<number[][]>

SimpleEmbeddingProvider (实现)
├── Bag-of-Words 哈希桶编码，384 维
├── 内置 LRU 缓存
└── L2 归一化输出
```

#### `importance.ts` — 重要性评分
```
ImportanceScorer (接口)
└── scoreImportance({content, type, participants}) → Promise<number>

createRuleBasedScorer()
├── 基于内容长度、关键词、参与者数量的启发式评分
└── 返回 1-9 分
```

### Layer 2: 能力层 (Capabilities)

#### `search.ts` — 记忆搜索
```
MemorySearcher
├── search({query, limit, type, minScore, participantFilter})
│   └── 嵌入查询 → 向量搜索 → 参与者过滤加分
├── searchByTopic(topic)        → 按主题搜索
├── searchAboutPerson(name)     → 按参与者搜索
└── formatMemoriesForPrompt()   → 格式化为 LLM prompt
```

#### `conversation-memory.ts` — 对话记忆化
```
ConversationMemoryPipeline
└── rememberConversation(input)
    ├── 生成对话摘要 (前2+后2条消息)
    ├── 提取关键词 (TF 统计)
    ├── 评分重要性
    ├── 生成嵌入向量
    └── 存入 SQLite
```

#### `reflection.ts` — 反思管道
```
ReflectionPipeline
├── shouldReflect()           → 检查累积重要性是否超过阈值
├── reflect()                 → 生成反思并存入记忆
│   ├── 提取最近 100 条记忆
│   ├── 模板生成器分析主题和模式
│   └── 逐条 insight 存入记忆
└── forceReflect()            → 强制执行反思
```

### Layer 3: 行为层 (Behavior)

#### `personality.ts` — 人格系统
```
PersonalityTraits
├── curiosity:          0~1  好奇心
├── sociability:        0~1  社交欲
├── conscientiousness:  0~1  尽责性
├── playfulness:        0~1  趣味性
└── formality:          0~1  正式度

AgentPersonality
├── name               → Agent 名称
├── identity           → 身份描述
├── plan               → 目标计划
├── traits             → 性格特征
├── interests          → 兴趣爱好
├── conversationStyle  → 沟通风格
├── quirks             → 小癖好
└── boundaries         → 行为边界

buildPersonalityPrompt()  → 生成 LLM System Prompt
```

#### `mood.ts` — 心情状态机
```
MoodState { curiosity, sociability, energy, concern }
        每个维度 0.0 ~ 1.0

生命周期:
  ┌──────────┐   时间流逝    ┌──────────┐   事件触发    ┌───────────┐
  │ Baseline │ ──lerp──→  │  Current │ ←──delta──→  │  Modified │
  │ (目标值)  │  ←──decay─ │  (当前)  │  ──boost──→  │  (临时)    │
  └──────────┘             └──────────┘              └───────────┘

事件效果:
  onInteraction()     → sociability×0.6, curiosity×0.8, concern×0.5, energy-0.05
  onImportantEvent(n) → curiosity+0.2, concern+0.15, energy+0.1 (× n/9)
  onRest(duration)    → energy+duration/recoveryMs
  onReflection()      → curiosity+0.1, energy+0.05
  applyDelta()        → 直接修改各维度

冷却/积累:
  postInteractionCooldownMs: 15分钟 (交互后不发消息)
  idleSociabilityRiseMs:     30分钟 (空闲后社交欲回升)
  idleConcernRiseMs:         2小时  (空闲后担忧上升)
  energyDecayMs:             6小时  (精力自然衰减)
  energyRecoveryMs:          2小时  (休息恢复精力)
```

### Layer 4: 决策层 (Decision)

#### `thinking-loop.ts` — 主动思考循环
```
ProactiveThinkingLoop
│
├── shouldActivate(mood) → boolean
│   ├── energy < 0.15 → 休眠
│   └── thinkingDrive > 0.3 → 激活
│       thinkingDrive = curiosity×0.4 + sociability×0.3 + energy×0.3
│
└── prepareAction(mood, store, personality) → ThoughtAction | null
    ├── 冷却检查 (minIntervalMs, 默认5分钟)
    ├── 思考类型判定:
    │   ├── memoryCount≥10 + idleCount≥8 → reflection   (importance: 7-9)
    │   ├── urgency≥0.6 + shouldMessage    → proactive_message (importance: 6)
    │   ├── curiosity>0.6 + memoryCount>3  → observation  (importance: 5)
    │   └── 默认                           → idle_thought  (importance: 3)
    └── 构建 LLM Prompt (含人格、心情、近期记忆)
```

### Layer 5: 集成层 (Integration)

#### `agent-mind.ts` — 统一入口
```
AgentMind
├── onInteraction(content, participants)
│   ├── 生成 embedding → 评分重要性 → 存入记忆 (type: conversation)
│   ├── mood.onInteraction()  (降低社交欲/担忧)
│   └── mood.onImportantEvent(importance) (提升好奇心/担忧)
│
├── onSystemEvent(content, importance)
│   ├── 存入记忆 (type: thought)
│   └── mood.onImportantEvent(importance)
│
├── tick() → ThoughtAction | null
│   ├── thinkingLoop.prepareAction() → 决策
│   └── thinkingLoop.recordThought() → 存为记忆
│
├── searchMemories(query, limit) → 向量搜索
├── searchAboutPerson(name, limit) → 按人搜索
└── getState() → 完整快照
```

## 数据流

```
 用户消息
    │
    ▼
 onInteraction("你好", ["user"])
    │
    ├──→ Embedder.embedQuery("你好") → [0.1, 0.3, ...]
    ├──→ Scorer.scoreImportance(...)  → 5
    ├──→ Store.insertMemory({ type: "conversation", ... })
    ├──→ Mood.onInteraction()         → sociability↓, curiosity↓
    └──→ Mood.onImportantEvent(5)     → curiosity↑, concern↑
 
 
 Heartbeat (每 5 分钟)
    │
    ▼
 mind.tick()
    │
    ├──→ ThinkingLoop.prepareAction(mood, store, personality)
    │    ├── shouldActivate? → thinkingDrive > 0.3?
    │    ├── cooldown? → 距上次 < 5min?
    │    └── 类型判定 → proactive_message / reflection / observation / idle
    │
    ├── null → 无事发生
    │
    └── ThoughtAction { type, prompt, importance, urgency }
         │
         ├── type=proactive_message → 发 prompt 给 LLM → 发消息给用户
         ├── type=reflection        → 发 prompt 给 LLM → 存反思到记忆
         ├── type=observation       → 发 prompt 给 LLM → 存思考到记忆
         └── type=idle_thought      → 发 prompt 给 LLM → 存思考到记忆
```

## 状态转换图

```
  ┌─────────┐    低紧迫度    ┌──────────┐
  │  IDLE   │ ←────────── │ OBSERVING│
  │  (休眠)  │ ──────────→ │  (观察)   │
  └────┬─────┘  curiosity> └────┬─────┘
       │        0.6 + mem>3     │
       │                        │ idleCount
       │ energy<0.15            │ ≥ 8
       ▼                        ▼
  ┌─────────┐              ┌──────────────┐
  │  REST   │              │  REFLECTION  │
  │  (休息)  │              │   (反思)     │
  └─────────┘              └──────────────┘
       
  当 urgency≥0.6 + shouldMessage:
  ┌──────────────────┐
  │ PROACTIVE_MSG    │
  │  (主动发消息)     │
  └──────────────────┘
```