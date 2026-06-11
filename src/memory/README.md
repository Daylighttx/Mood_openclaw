# 🧠 AI Town 思考系统集成

将 [AI Town](https://github.com/a16z-infra/ai-town) 的自主思考架构集成到 OpenClaw Agent 中，
让 Agent 拥有**记忆、反思、心情、人格**和**主动发消息**的能力。

## 核心能力

| 能力 | 描述 |
|------|------|
| 📝 **语义记忆** | 自动存储对话、生成 embedding、重要性评分、向量搜索 |
| 🎭 **人格系统** | 定义 Agent 的身份、性格特征、兴趣、沟通风格 |
| 💭 **心情状态机** | 好奇心/社交欲/精力/担忧 四维情绪，随时间衰减和事件驱动变化 |
| 🔄 **主动思考循环** | Sense-Think-Act 循环，Agent 自主决定何时思考、思考什么 |
| 📨 **主动消息** | 基于心情紧迫度自动判断是否给用户发送消息 |

## 快速开始

### 1. 创建 AgentMind 实例

```typescript
import { AgentMind } from "./memory/agent-mind.js";
import { createDefaultPersonality } from "./agents/personality.js";

const personality = createDefaultPersonality("小助手");

const mind = new AgentMind({
  agentId: "my-agent-1",
  dbPath: "./data/agent-memory.db",
  personality,
});
```

### 2. 记录对话

```typescript
await mind.onInteraction("用户问今天天气怎么样？", ["user"]);
```

### 3. 心跳中运行思考循环

```typescript
const action = mind.tick();

if (action === null) {
  // Agent 不想说话，跳过
  return;
}

if (action.type === "proactive_message") {
  // 把 action.prompt 发给 LLM，获得回复后发给用户
  const reply = await llm.chat(action.prompt);
  await sendMessageToUser(reply);
}

// 其他类型 (reflection/observation/idle_thought)：
// action.prompt 可发给 LLM 生成思考内容，存为记忆
```

### 4. 查询状态

```typescript
const state = mind.getState();
console.log(state.moodDescription);   // "feeling social, very curious, energetic"
console.log(state.proactiveUrgency);  // 0.0 ~ 1.0
console.log(state.shouldMessage);     // true/false
console.log(state.memoryCount);       // 记忆总数
```

## 模块结构

```
src/
├── agents/
│   ├── personality.ts       # 人格定义 + 提示词构建
│   ├── mood.ts              # 心情状态机
│   └── index.ts             # 统一导出
├── memory/
│   ├── types.ts             # 核心类型定义
│   ├── store.ts             # SQLite 记忆存储
│   ├── embeddings.ts        # 嵌入向量生成 + 缓存
│   ├── importance.ts        # 重要性评分
│   ├── search.ts            # 向量相似度搜索
│   ├── conversation-memory.ts # 对话→记忆转换
│   ├── reflection.ts        # 反思生成管道
│   ├── thinking-loop.ts     # 主动思考循环 (Sense-Think-Act)
│   ├── agent-mind.ts        # 🎯 统一集成入口
│   └── index.ts             # 统一导出
```

## 心情状态

```
     curiosity (好奇心)     ─── 高 → 喜欢探索新话题
     sociability (社交欲)   ─── 高 → 想找人聊天
     energy (精力)          ─── 低 → 不想说话
     concern (担忧)         ─── 高 → 担心某事，想确认
```

- 随时间自然衰减至基线
- 对话后重置社交欲、降低担忧
- 重要事件会提升心情各维度
- 长时间空闲会积累社交欲和担忧

## 测试

```bash
# 运行全部测试 (59 个)
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts \
  src/memory/personality.test.ts \
  src/memory/mood.test.ts \
  src/memory/thinking-loop.test.ts \
  src/memory/agent-mind.test.ts
```

## 构建

```bash
pnpm build
```

所有 `.ts` 文件经由 `tsdown` 编译到 `dist/` 目录，保持 ESM 模块格式。