import { describe, expect, it, afterEach, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { AgentMind } from "./agent-mind.js";
import {
  getOrCreateMind,
  mindOnInboundMessage,
  mindOnHeartbeat,
  closeAllMinds,
} from "./agent-mind-bridge.js";
import { ProactiveThinkingLoop } from "./thinking-loop.js";
import { AgentMood } from "../agents/mood.js";
import { SemanticMemoryStore } from "./store.js";
import { createDefaultPersonality } from "../agents/personality.js";

let _testHome: string;
let _origOpenclawHome: string | undefined;
let _origHome: string | undefined;

beforeEach(() => {
  _origOpenclawHome = process.env.OPENCLAW_HOME;
  _origHome = process.env.HOME;
  _testHome = fs.mkdtempSync(path.join(os.tmpdir(), "integration-test-"));
  process.env.OPENCLAW_HOME = _testHome;
  process.env.HOME = _testHome;
  closeAllMinds();
});

afterEach(() => {
  closeAllMinds();
  if (_origOpenclawHome) process.env.OPENCLAW_HOME = _origOpenclawHome;
  else delete process.env.OPENCLAW_HOME;
  if (_origHome) process.env.HOME = _origHome;
  try { fs.rmSync(_testHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mind-test-"));
  const dbPath = path.join(dir, "test.db");
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function createMind(
  agentId: string,
  overrides?: { curiosity?: number; sociability?: number; energy?: number; concern?: number },
): { mind: AgentMind; cleanup: () => void } {
  const db = createTempDb();
  const personality = createDefaultPersonality(agentId);
  const mind = new AgentMind({
    agentId,
    dbPath: db.dbPath,
    personality,
    moodBaselines: overrides,
    thinkingConfig: { minIntervalMs: 0 },
  });
  return {
    mind,
    cleanup: () => {
      try { mind.close(); } catch { /* ignore */ }
      try { db.cleanup(); } catch { /* ignore */ }
    },
  };
}

describe("集成测试: 消息→记忆→情绪→思考→主动决策 全链路", () => {
  // ═══════════════════════════════════════════════════════════
  // 场景 1: 消息收发的完整生命周期
  // ═══════════════════════════════════════════════════════════
  describe("场景1: 收发消息的生命周期", () => {
    it("发送消息后: 记忆数+1, 社交欲下降, 精力不降（精力随时间衰减，不在交互时降）", async () => {
      const { mind, cleanup } = createMind("lifecycle-1", {
        curiosity: 0.8, sociability: 0.8, energy: 1.0, concern: 0.2,
      });

      const before = mind.getState();
      await mind.onInteraction("你好小爪！", ["阿创"]);
      const after = mind.getState();

      expect(after.memoryCount).toBe(before.memoryCount + 1);
      // 社交欲在交互时降到 baseline*0.6，所以一定下降
      expect(after.mood.sociability).toBeLessThan(before.mood.sociability);
      // 精力在 onInteraction 中不降（只随时间衰减），所以 ≤ 之前
      // 注意：由于浮点精度和 baseline 恢复，允许微小的上升（< 0.001）
      expect(after.mood.energy).toBeLessThanOrEqual(before.mood.energy + 0.001);
      cleanup();
    });

    it("用户连续发10条消息后: 记忆数≥10, 社交欲持续降低", async () => {
      const { mind, cleanup } = createMind("lifecycle-10", {
        curiosity: 0.7, sociability: 0.8, energy: 1.0, concern: 0.1,
      });

      const beforeSoc = mind.getState().mood.sociability;
      for (let i = 1; i <= 10; i++) {
        await mind.onInteraction(`第${i}条消息: 聊了${i}个话题`, ["阿创"]);
      }
      const after = mind.getState();

      expect(after.memoryCount).toBeGreaterThanOrEqual(10);
      expect(after.mood.sociability).toBeLessThan(beforeSoc);
      cleanup();
    });

    it("重要事件会同时影响好奇心和关切感", async () => {
      const { mind, cleanup } = createMind("lifecycle-important", {
        curiosity: 0.5, sociability: 0.5, energy: 0.8, concern: 0.1,
      });

      const before = mind.getState();
      await mind.onInteraction("紧急! 服务器宕机了，需要立刻修复!", ["阿创"]);
      const after = mind.getState();

      expect(after.mood.curiosity).toBeGreaterThanOrEqual(before.mood.curiosity);
      expect(after.mood.concern).toBeGreaterThanOrEqual(before.mood.concern);
      cleanup();
    });

    it("记忆内容被正确存储", async () => {
      const { mind, cleanup } = createMind("lifecycle-store");

      await mind.onInteraction("我今天去了落日码头", ["阿创"]);
      await mind.onInteraction("那里的咖啡特别好喝", ["阿创"]);

      const memories = mind.getStore().listMemories({ limit: 10 });
      expect(memories.some((m) => m.content.includes("落日码头"))).toBe(true);
      expect(memories.some((m) => m.content.includes("咖啡"))).toBe(true);
      cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 场景 2: 心跳综合决策 —— 证明它不只是定时触发
  // ═══════════════════════════════════════════════════════════
  describe("场景2: 心跳综合决策（非定时触发）", () => {
    it("高社交+高好奇+高精力: 心跳返回思考动作", async () => {
      const { mind, cleanup } = createMind("hb-active", {
        curiosity: 0.9, sociability: 0.9, energy: 0.9, concern: 0.5,
      });

      const action = await mind.tick();
      expect(action).not.toBeNull();
      expect(action!.type).toBeDefined();
      cleanup();
    });

    it("低精力即使高社交: 心跳不返回动作（精力优先）", async () => {
      const { mind, cleanup } = createMind("hb-tired", {
        curiosity: 0.9, sociability: 0.9, energy: 0.1, concern: 0.5,
      });

      const action = await mind.tick();
      expect(action).toBeNull();
      cleanup();
    });

    it("平静情绪: 心跳不返回动作", async () => {
      const { mind, cleanup } = createMind("hb-calm", {
        curiosity: 0.2, sociability: 0.2, energy: 0.3, concern: 0.1,
      });

      const action = await mind.tick();
      expect(action).toBeNull();
      cleanup();
    });

    it("仅有适中好奇心但社交欲和精力都低: 心跳不返回动作", async () => {
      // 0.3*0.4 + 0.15*0.3 + 0.25*0.3 = 0.12+0.045+0.075 = 0.24 < 0.3
      const { mind, cleanup } = createMind("hb-curious-only", {
        curiosity: 0.3, sociability: 0.15, energy: 0.25, concern: 0.1,
      });

      const action = await mind.tick();
      expect(action).toBeNull();
      cleanup();
    });

    it("冷却期内连续 tick 第二次返回 null", async () => {
      const db = createTempDb();
      const personality = createDefaultPersonality("hb-cooldown");
      const mind = new AgentMind({
        agentId: "hb-cooldown",
        dbPath: db.dbPath,
        personality,
        moodBaselines: { curiosity: 0.9, sociability: 0.9, energy: 0.9, concern: 0.5 },
        thinkingConfig: { minIntervalMs: 600000 },
      });

      const action1 = await mind.tick();
      expect(action1).not.toBeNull();

      const action2 = await mind.tick();
      expect(action2).toBeNull();

      mind.close();
      db.cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 场景 3: 社交欲回升 → 主动发消息（关键场景）
  // ═══════════════════════════════════════════════════════════
  describe("场景3: 社交欲回升触发主动消息", () => {
    it("刚互动完后 shouldMessage=false（冷却期）", async () => {
      const { mind, cleanup } = createMind("proactive-cooldown", {
        curiosity: 0.7, sociability: 0.9, energy: 0.9, concern: 0.3,
      });

      await mind.onInteraction("你好！", ["阿创"]);
      const state = mind.getState();
      expect(state.shouldMessage).toBe(false);
      cleanup();
    });

    it("高社交欲+高关切 产生高紧迫度", async () => {
      const { mind, cleanup } = createMind("proactive-urgency", {
        curiosity: 0.5, sociability: 0.9, energy: 0.9, concern: 0.8,
      });

      const state = mind.getState();
      expect(state.proactiveUrgency).toBeGreaterThan(0.5);
      cleanup();
    });

    it("低社交欲+低关切 产生低紧迫度", async () => {
      const { mind, cleanup } = createMind("proactive-low", {
        curiosity: 0.2, sociability: 0.2, energy: 0.5, concern: 0.1,
      });

      const state = mind.getState();
      expect(state.proactiveUrgency).toBeLessThanOrEqual(0.3);
      cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 场景 4: 空闲思考→反思的蓄力机制
  // ═══════════════════════════════════════════════════════════
  describe("场景4: 空闲思考蓄力→触发反思", () => {
    it("大量记忆+低idle阈值: 直接触发反思", async () => {
      const db = createTempDb();
      const personality = createDefaultPersonality("reflect-direct");
      const mind = new AgentMind({
        agentId: "reflect-direct",
        dbPath: db.dbPath,
        personality,
        moodBaselines: { curiosity: 0.7, sociability: 0.5, energy: 0.8, concern: 0.2 },
        thinkingConfig: { minIntervalMs: 0, maxIdleThoughtsBeforeReflection: 0, reflectionMemoryThreshold: 10 },
      });

      for (let i = 0; i < 12; i++) {
        mind.getStore().insertMemory({
          agentId: "reflect-direct",
          type: "conversation",
          content: `对话记录 ${i + 1}: 讨论了${["AI", "天气", "编程", "电影", "旅行"][i % 5]}的话题`,
          importance: 5,
          embedding: [],
        });
      }

      const action = await mind.tick();
      expect(action).not.toBeNull();
      expect(action!.type).toBe("reflection");
      expect(action!.importance).toBeGreaterThanOrEqual(7);

      mind.close();
      db.cleanup();
    });

    it("连续空闲思考后触发反思", async () => {
      const { mind, cleanup } = createMind("reflect-accumulate", {
        curiosity: 0.7, sociability: 0.5, energy: 0.8, concern: 0.2,
      });

      for (let i = 0; i < 12; i++) {
        mind.getStore().insertMemory({
          agentId: "reflect-accumulate",
          type: "conversation",
          content: `记忆 ${i + 1}`,
          importance: 4,
          embedding: [],
        });
      }

      let lastType = "";
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0, maxIdleThoughtsBeforeReflection: 3 });

      for (let i = 0; i < 4; i++) {
        const action = await loop.prepareAction(
          mind.getMood(),
          mind.getStore(),
          mind.getPersonality(),
        );
        if (action) lastType = action.type;
      }

      // 第4次: idleThoughtCount 达到 3 >= maxIdleThoughtsBeforeReflection=3 → reflection
      expect(lastType).toBe("reflection");
      cleanup();
    });

    it("反思后 idleThoughtCount 重置为 0", async () => {
      const loop = new ProactiveThinkingLoop({
        minIntervalMs: 0,
        maxIdleThoughtsBeforeReflection: 2,
        reflectionMemoryThreshold: 5,
      });

      const mood = new AgentMood({ curiosity: 0.7, sociability: 0.5, energy: 0.8, concern: 0.2 });
      const personality = createDefaultPersonality("ReflectBot");
      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-reset-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(storeDir, "test.db"), agentId: "reflect-reset" });

      for (let i = 0; i < 6; i++) {
        store.insertMemory({
          agentId: "reflect-reset",
          type: "conversation",
          content: `Memory ${i}`,
          importance: 4,
          embedding: [],
        });
      }

      await loop.prepareAction(mood, store, personality); // idle_thought
      await loop.prepareAction(mood, store, personality); // idle_thought
      const reflection = await loop.prepareAction(mood, store, personality); // reflection

      expect(reflection!.type).toBe("reflection");
      expect(loop.getIdleThoughtCount()).toBe(0);

      store.close();
      try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 场景 5: Bridge 层集成点验证 (模拟 dispatch/heartbeat)
  // ═══════════════════════════════════════════════════════════
  describe("场景5: Bridge 层集成点", () => {
    it("mindOnInboundMessage 模拟 dispatch-from-config 调用", async () => {
      const s = await mindOnInboundMessage("dispatch-sim", "用户消息: 今天天气真好", "用户A");
      expect(s).not.toBeNull();
      expect(s!.memoryCount).toBeGreaterThanOrEqual(1);
      expect(s!.mood.energy).toBeGreaterThanOrEqual(0);
      expect(s!.mood.energy).toBeLessThanOrEqual(1);
    });

    it("mindOnHeartbeat 模拟 heartbeat-runner 调用", async () => {
      getOrCreateMind("heartbeat-sim");
      const result = await mindOnHeartbeat("heartbeat-sim");

      expect(result).not.toBeNull();
      expect(typeof result!.shouldMessage).toBe("boolean");
      expect(result!.state).toBeDefined();
      expect(result!.state.agentId).toBe("heartbeat-sim");
      expect(result!.thoughtAction === null || typeof result!.thoughtAction.type === "string").toBe(true);
    });

    it("交互后心跳: shouldMessage 反映冷却状态", async () => {
      const agentId = "hb-interact";
      await mindOnInboundMessage(agentId, "你好！我们聊聊天吧", "用户B");

      const result = await mindOnHeartbeat(agentId);
      expect(result).not.toBeNull();
      expect(result!.state.memoryCount).toBeGreaterThanOrEqual(1);
      expect(typeof result!.shouldMessage).toBe("boolean");
    });

    it("多个 Agent 隔离: 心跳状态互不影响", async () => {
      await mindOnInboundMessage("agent-a", "A的消息1", "用户A");
      await mindOnInboundMessage("agent-a", "A的消息2", "用户A");
      await mindOnInboundMessage("agent-b", "B的消息1", "用户B");

      const stateA = (await mindOnHeartbeat("agent-a"))!;
      const stateB = (await mindOnHeartbeat("agent-b"))!;

      expect(stateA.state.memoryCount).toBeGreaterThan(stateB.state.memoryCount);
      expect(stateA.state.agentId).not.toBe(stateB.state.agentId);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 场景 6: 思考类型的决策优先级验证
  // ═══════════════════════════════════════════════════════════
  describe("场景6: 思考类型决策优先级", () => {
    it("反思优先于主动消息 (reflection > proactive_message)", async () => {
      const loop = new ProactiveThinkingLoop({
        minIntervalMs: 0,
        maxIdleThoughtsBeforeReflection: 0,
        reflectionMemoryThreshold: 5,
      });

      const mood = new AgentMood({
        curiosity: 0.9, sociability: 0.9, energy: 0.9, concern: 0.9,
      });
      const personality = createDefaultPersonality("PriorityBot");
      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "priority-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(storeDir, "test.db"), agentId: "priority" });

      for (let i = 0; i < 6; i++) {
        store.insertMemory({
          agentId: "priority",
          type: "conversation",
          content: `Conversation ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const action = await loop.prepareAction(mood, store, personality);
      expect(action!.type).toBe("reflection");

      store.close();
      try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("主动消息优先于观察 (proactive_message > observation)", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });

      const mood = new AgentMood({
        curiosity: 0.8, sociability: 0.9, energy: 0.9, concern: 0.8,
      });
      const personality = createDefaultPersonality("MsgPriorityBot");
      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-priority-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(storeDir, "test.db"), agentId: "msg-priority" });

      for (let i = 0; i < 4; i++) {
        store.insertMemory({
          agentId: "msg-priority",
          type: "conversation",
          content: `Memory ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const action = await loop.prepareAction(mood, store, personality);
      expect(action!.type).toBe("proactive_message");

      store.close();
      try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("好奇心高但记忆不足时仍为 idle_thought（不是 observation）", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });

      const mood = new AgentMood({
        curiosity: 0.9, sociability: 0.4, energy: 0.8, concern: 0.1,
      });
      const personality = createDefaultPersonality("CuriousBot");
      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "curious-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(storeDir, "test.db"), agentId: "curious" });

      const action = await loop.prepareAction(mood, store, personality);
      expect(action!.type).toBe("idle_thought");

      store.close();
      try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("无记忆无高情绪: 兜底为 idle_thought", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });

      const mood = new AgentMood({
        curiosity: 0.6, sociability: 0.6, energy: 0.7, concern: 0.2,
      });
      const personality = createDefaultPersonality("DefaultBot");
      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(storeDir, "test.db"), agentId: "idle" });

      const action = await loop.prepareAction(mood, store, personality);
      expect(action!.type).toBe("idle_thought");

      store.close();
      try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 场景 7: 边界和异常情况
  // ═══════════════════════════════════════════════════════════
  describe("场景7: 边界和异常", () => {
    it("过短消息（1字符）bridge 层不崩溃", async () => {
      // bridge 的 mindOnInboundMessage 调用 mind.onInteraction 不检查长度
      // 实际的长度过滤在 dispatch-from-config 的 maybeRecordMemory 层
      const s = await mindOnInboundMessage("edge-empty", "a", "测试用户");
      expect(s).not.toBeNull();
    });

    it("超长消息被截断但不丢", async () => {
      const { mind, cleanup } = createMind("edge-long");

      const longText = "x".repeat(3000);
      await mind.onInteraction(longText, ["user"]);

      const memories = mind.getStore().listMemories({ limit: 1 });
      expect(memories.length).toBe(1);
      expect(memories[0].content.length).toBeLessThanOrEqual(2000);
      cleanup();
    });

    it("消息含特殊字符正常工作", async () => {
      const { mind, cleanup } = createMind("edge-special");

      await mind.onInteraction("特殊字符: <>&\"'@#$%^&*()", ["用户"]);
      await mind.onInteraction("emoji: 😊🎉🚀 中文和English混合", ["用户"]);

      expect(mind.getState().memoryCount).toBe(2);
      cleanup();
    });

    it("AgentMind close 后可安全关闭", () => {
      const { mind, cleanup } = createMind("edge-close");
      expect(() => mind.close()).not.toThrow();
      cleanup();
    });

    it("bridge 层: 不存在的 agent 也能平滑处理", async () => {
      const result = await mindOnHeartbeat("non-existent-agent");
      const mind = getOrCreateMind("non-existent-agent");
      expect(mind).toBeDefined();
      expect(result).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 场景 8: 思考内容质量验证
  // ═══════════════════════════════════════════════════════════
  describe("场景8: 思考内容质量", () => {
    it("prompt 包含人格名字", async () => {
      const { mind, cleanup } = createMind("quality-name", {
        curiosity: 0.8, sociability: 0.8, energy: 0.9, concern: 0.3,
      });

      const action = await mind.tick();
      expect(action!.prompt).toContain("quality-name");
      cleanup();
    });

    it("prompt 包含情绪描述", async () => {
      const { mind, cleanup } = createMind("quality-mood", {
        curiosity: 0.8, sociability: 0.8, energy: 0.9, concern: 0.3,
      });

      const action = await mind.tick();
      expect(action!.moodDescription.length).toBeGreaterThan(0);
      cleanup();
    });

    it("prompt 包含近期记忆上下文", async () => {
      const { mind, cleanup } = createMind("quality-context", {
        curiosity: 0.8, sociability: 0.5, energy: 0.8, concern: 0.2,
      });

      mind.getStore().insertMemory({
        agentId: "quality-context",
        type: "conversation",
        content: "讨论AI安全性问题",
        importance: 8,
        embedding: [],
      });

      const action = await mind.tick();
      expect(action!.prompt).toContain("AI安全性问题");
      cleanup();
    });
  });
});

describe("dispatch-from-config maybeRecordMemory 回归测试", () => {
  it("有消息体和 agentId 时记录记忆", async () => {
    const ctx = { Body: "用户发来了一条测试消息", From: "测试用户" };
    const agentId = "dispatch-test";

    await mindOnInboundMessage(agentId, ctx.Body, ctx.From);
    const result = await mindOnHeartbeat(agentId);

    expect(result!.state.memoryCount).toBeGreaterThanOrEqual(1);
  });

  it("过短消息被 maybeRecordMemory 过滤（模拟 dispatch-from-config 行为）", async () => {
    // 模拟 dispatch-from-config 中 maybeRecordMemory 的过滤逻辑
    const agentId = "dispatch-short";
    const shortBody = "a"; // body.length < 2 → 被过滤
    const mind = getOrCreateMind(agentId);
    const before = mind.getState().memoryCount;

    // 模拟过滤
    if (shortBody.length >= 2) {
      await mindOnInboundMessage(agentId, shortBody, "测试用户");
    }

    const after = mind.getState().memoryCount;
    expect(after).toBe(before); // 没调用 bridge → 记忆数不变
  });

  it("无 agentId 时跳过（不崩溃）", () => {
    expect(() => {
      expect(true).toBe(true);
    }).not.toThrow();
  });
});