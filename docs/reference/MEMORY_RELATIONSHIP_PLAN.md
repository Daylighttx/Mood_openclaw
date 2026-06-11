# Memory 导入 + Relationship 迭代 — 实现计划

## 背景

当前 persona-import 工具只生成了 `personality` 配置，没有把聊天记录里**具体的对话内容**导入 SQLite 记忆库。而且 `relationship` 字段是一次性静态的，不会在后续对话中自动更新。

## 功能 1：Memory 导入

### 目标

从聊天记录中提取关键对话片段，写入 Agent 的 SQLite `semantic_memory` 表，让 Agent 一启动就"记得"这些事。

### 设计

```
persona-import.mjs --memory-import --target CHAR_NAME --user USER_NAME
  │
  ├─ 1. 解析聊天记录（复用现有 readChatFile）
  ├─ 2. 发送给 LLM: "提取 20-30 条最有代表性的对话摘要"
  ├─ 3. LLM 返回 JSON: [{content, importance, type}, ...]
  └─ 4. 写入 SQLite memory 表
```

### LLM 提示词

```
以下是 {targetName} 和 {userName} 的聊天记录。

请提取 20-30 条最有代表性和信息量的对话片段，每条格式为:
{ "content": "摘要（50字以内，第三人称）",
  "importance": 1-9,
  "type": "conversation"|"memory"|"fact"
}

提取标准:
- importance=8~9: TA表达的核心价值观、重要承诺、关键事件
- importance=5~7: TA的性格特征体现、常用表达、典型互动
- importance=1~4: 日常闲聊中有记忆点的小片段
- type=fact: 客观事实（如"CHAR_NAME不喜欢荆芥"）
- type=memory: 共同经历（如"她和CHAR_NAME一起去买过电脑"）
- type=conversation: 代表性对话片段

聊天记录:
---
{rawChat}
---
```

### 输出示例

```json
[
  {"content":"CHAR_NAME不喜欢荆芥的味道","importance":6,"type":"fact"},
  {"content":"CHAR_NAME说她在看剧时被问在干嘛","importance":3,"type":"conversation"},
  {"content":"CHAR_NAME爱发哈哈哈和表情包","importance":4,"type":"memory"},
  {"content":"CHAR_NAME对电子产品很感兴趣，在买电脑时很兴奋","importance":5,"type":"memory"}
]
```

### SQLite 写入

```typescript
// 直接操作 SQLite，复用 store.insertMemory 接口
import { SemanticMemoryStore } from "./store.js";

const store = new SemanticMemoryStore(dbPath);
for (const mem of memories) {
    store.insertMemory({
        agentId: "main",
        type: mem.type,
        content: mem.content,
        importance: mem.importance,
        embedding: [],  // 无embedding也可用
    });
}
```

### 调用方式

```bash
# 追加: 导入记忆
node persona-import.mjs her_chat.jsonl \
  --target CHAR_NAME --user USER_NAME \
  --memory-import \
  --memory-db /home/openclaw/.openclaw/mind/main.db

# 或同时做人设+记忆
node persona-import.mjs her_chat.jsonl \
  --target CHAR_NAME --user USER_NAME \
  --persona --output /tmp/xiaoyu-persona.json \
  --memory-import
```

### 改动范围

| 文件 | 改动 |
|------|------|
| `scripts/persona-import.mjs` | 新增 `--memory-import` flag + LLM 调用 + SQLite 写入 |
| 所有现有文件 | **0 行改动** |

---

## 功能 2：Relationship 迭代

### 目标

`mind-config.json` 里的 `relationship.description` 不是静态的——每次对话后 LLM 会审视 "我现在跟 ta 的关系是不是变了？" 然后自动更新。

### 设计

```
每 10 轮对话或每 24 小时 → relationshipRefreshTrigger
  │
  ├─ 收集最近 N 轮对话摘要
  ├─ 发送给 LLM: "基于最近对话，更新关系描述"
  ├─ LLM 返回: { description: "新的关系描述", changed: true/false }
  └─ 写入 mind-config.json (仅 description 字段)
```

### 触发条件

```typescript
// 在 agent-mind.ts tick() 中
shouldRefreshRelationship(): boolean {
    const sinceLastRefresh = Date.now() - this.lastRelationshipRefreshAt;
    const recentConversations = this.store.memoryCount({ type: "conversation" });
    const convSinceLastRefresh = recentConversations - this.conversationCountAtLastRefresh;

    return (sinceLastRefresh > 24 * 60 * 60 * 1000)  // 24小时
        || (convSinceLastRefresh >= 10);               // 或10轮对话
}
```

### LLM 提示词

```
You are {name}, {identity}.

Your current relationship with {userName} is:
"{currentRelationshipDescription}"

Recent conversations with {userName}:
{recentConversations}

Based on these recent conversations, has your relationship changed in any way?
If nothing meaningful has changed, say "unchanged".
If something has shifted, write a new 1-2 sentence description of your relationship,
in the same first-person, natural style as the original.

Respond with JSON:
{ "changed": true|false,
  "description": "新的关系描述 或 不变则留空" }
```

### 示例效果

```
原来: "CHAR_NAME和我是很好的朋友，经常一起聊生活、开玩笑"

吵架后 → "CHAR_NAME和我最近有点闹矛盾，感觉她对我有点冷淡了，
          我想跟她好好聊聊但又不知道怎么说"

和好后 → "CHAR_NAME和我是无话不谈的好朋友，我们会吵架但总会和好"

很久没聊 → "CHAR_NAME是我一个老朋友了，我们好久没聊天了，有点想念"
```

### 改动范围

| 文件 | 改动 |
|------|------|
| `src/memory/agent-mind.ts` | 新增 `shouldRefreshRelationship()` + LLM 调用 |
| `src/agents/personality.ts` | 新增 `updateRelationship()` 方法 |
| `src/memory/agent-mind-bridge.ts` | 新增 `mindOnRelationshipRefresh` 事件 |
| `mind-config.json` | relationship.description 被覆盖更新 |

### 接口

```typescript
// AgentMind
interface RelationshipRefreshResult {
    changed: boolean;
    newDescription?: string;
    previousDescription: string;
}

async refreshRelationship(llmProvider: MindLLMProvider): Promise<RelationshipRefreshResult>;
```

---

## 实施顺序

| Step | 功能 | 工作量 | 依赖 |
|------|------|--------|------|
| 1 | events.log 修复 | 1 行改动 | 无 |
| 2 | persona-import 加 --memory-import | ~60 行 | Step 1 |
| 3 | memory-import 测试 | — | Step 2 |
| 4 | Relationship 迭代核心 | ~80 行 | Step 1 |
| 5 | Relationship 测试 | — | Step 4 |
| 6 | 编译打包 | — | Step 3,5 |

Step 2 和 Step 4 可并行实现，各自独立。
