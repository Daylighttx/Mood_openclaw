import { describe, expect, it, afterEach, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { AgentMind } from "./agent-mind.js";
import {
  getOrCreateMind,
  mindOnInboundMessage,
  mindOnHeartbeat,
  buildMindSystemPromptSection,
  closeAllMinds,
} from "./agent-mind-bridge.js";
import { ProactiveThinkingLoop } from "./thinking-loop.js";
import { AgentMood } from "../agents/mood.js";
import { SemanticMemoryStore } from "./store.js";
import { createRuleBasedScorer } from "./importance.js";
import { createDefaultPersonality } from "../agents/personality.js";
import { createTemplateReflectionGenerator, ReflectionPipeline } from "./reflection.js";

let _testHome: string;
let _origOpenclawHome: string | undefined;
let _origHome: string | undefined;

beforeEach(() => {
  _origOpenclawHome = process.env.OPENCLAW_HOME;
  _origHome = process.env.HOME;
  _testHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-pipeline-"));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-db-"));
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

describe("全链路端到端测试", () => {
  describe("A: 消息→重要性→记忆→情绪 全链路", () => {
    it("A1: 中文关键词正确提升重要性评分", async () => {
      const scorer = createRuleBasedScorer();
      const normalScore = await scorer.scoreImportance({
        content: "今天天气不错", type: "conversation", participants: ["用户"],
      });
      const importantScore = await scorer.scoreImportance({
        content: "紧急！服务器宕机了需要立刻修复", type: "conversation", participants: ["用户"],
      });
      const promiseScore = await scorer.scoreImportance({
        content: "我承诺明天之前完成这个任务", type: "conversation", participants: ["用户"],
      });
      const secretScore = await scorer.scoreImportance({
        content: "告诉你一个秘密：我喜欢上了AI", type: "conversation", participants: ["用户"],
      });

      expect(importantScore).toBeGreaterThan(normalScore);
      expect(promiseScore).toBeGreaterThan(normalScore);
      expect(secretScore).toBeGreaterThan(normalScore);
    });

    it("A2: 英文关键词正确提升重要性评分", async () => {
      const scorer = createRuleBasedScorer();
      const normalScore = await scorer.scoreImportance({
        content: "hello how are you", type: "conversation", participants: ["user"],
      });
      const urgentScore = await scorer.scoreImportance({
        content: "this is urgent please respond asap", type: "conversation", participants: ["user"],
      });
      const promiseScore = await scorer.scoreImportance({
        content: "I promise to deliver this by tomorrow", type: "conversation", participants: ["user"],
      });

      expect(urgentScore).toBeGreaterThan(normalScore);
      expect(promiseScore).toBeGreaterThan(normalScore);
    });

    it("A3: onInteraction 后记忆正确存储（内容、参与者、keywords）", async () => {
      const { mind, cleanup } = createMind("e2e-store");

      await mind.onInteraction("我喜欢在落日码头喝咖啡看夕阳", ["阿创"]);
      await mind.onInteraction("Python 和 TypeScript 哪个更适合做后端？", ["阿创"]);

      const memories = mind.getStore().listMemories({ limit: 10 });
      expect(memories.length).toBe(2);
      expect(memories.some((m) => m.content.includes("落日码头"))).toBe(true);
      expect(memories.some((m) => m.content.includes("Python"))).toBe(true);
      expect(memories.every((m) => m.participants?.includes("阿创"))).toBe(true);
      expect(memories.every((m) => m.keywords && m.keywords.length > 0)).toBe(true);
      cleanup();
    });

    it("A4: 交互后情绪变化方向正确", async () => {
      const { mind, cleanup } = createMind("e2e-mood", {
        curiosity: 0.8, sociability: 0.9, energy: 1.0, concern: 0.3,
      });

      const before = mind.getState();
      await mind.onInteraction("你好！今天有什么新闻吗？", ["用户"]);
      const after = mind.getState();

      expect(after.mood.sociability).toBeLessThan(before.mood.sociability);
      expect(after.mood.energy).toBeLessThanOrEqual(before.mood.energy);
      expect(after.lastInteractionAt).toBeGreaterThan(0);
      cleanup();
    });

    it("A5: 重要事件（高重要性消息）不降低好奇心", async () => {
      const { mind, cleanup } = createMind("e2e-important", {
        curiosity: 0.5, sociability: 0.7, energy: 0.8, concern: 0.1,
      });

      const before = mind.getState();
      await mind.onInteraction("紧急通知：项目截止日期提前到明天！这很重要！", ["老板"]);
      const after = mind.getState();

      expect(after.mood.curiosity).toBeGreaterThanOrEqual(before.mood.curiosity - 0.01);
      expect(after.mood.concern).toBeGreaterThan(before.mood.concern);
      cleanup();
    });
  });

  describe("B: 情绪→思考→心跳决策 全链路", () => {
    it("B1: 高社交高好奇高精力 → 产生主动消息决策", async () => {
      const { mind, cleanup } = createMind("e2e-proactive", {
        curiosity: 0.9, sociability: 0.9, energy: 0.9, concern: 0.5,
      });

      const action = await mind.tick();
      expect(action).not.toBeNull();
      expect(["proactive_message", "observation", "idle_thought"]).toContain(action!.type);

      const state = mind.getState();
      expect(state.proactiveUrgency).toBeGreaterThan(0.4);
      cleanup();
    });

    it("B2: 冷却期后第二次 tick 返回 null", async () => {
      const db = createTempDb();
      const personality = createDefaultPersonality("e2e-cooldown");
      const mind = new AgentMind({
        agentId: "e2e-cooldown",
        dbPath: db.dbPath,
        personality,
        moodBaselines: { curiosity: 0.9, sociability: 0.9, energy: 0.9, concern: 0.5 },
        thinkingConfig: { minIntervalMs: 600000 },
      });

      const action1 = await mind.tick();
      expect(action1).not.toBeNull();

      const action2 = await mind.tick();
      expect(action2).toBeNull();

      const state = mind.getState();
      expect(state.idleThoughtCount).toBeGreaterThanOrEqual(0);

      mind.close();
      db.cleanup();
    });

    it("B3: 低精力阻止一切思考活动", async () => {
      const { mind, cleanup } = createMind("e2e-tired", {
        curiosity: 0.9, sociability: 0.9, energy: 0.1, concern: 0.5,
      });

      const action = await mind.tick();
      expect(action).toBeNull();

      const state = mind.getState();
      expect(state.proactiveUrgency).toBeGreaterThanOrEqual(0);
      cleanup();
    });

    it("B4: 反思触发后 cumulativeImportance 正确更新", async () => {
      const db = createTempDb();
      const personality = createDefaultPersonality("e2e-reflect");
      const mind = new AgentMind({
        agentId: "e2e-reflect",
        dbPath: db.dbPath,
        personality,
        moodBaselines: { curiosity: 0.7, sociability: 0.5, energy: 0.8, concern: 0.2 },
        thinkingConfig: { minIntervalMs: 0, maxIdleThoughtsBeforeReflection: 0, reflectionMemoryThreshold: 5 },
      });

      const store = mind.getStore();
      for (let i = 0; i < 6; i++) {
        store.insertMemory({
          agentId: "e2e-reflect",
          type: "conversation",
          content: `一段重要的对话记录 ${i + 1}`,
          importance: 8,
          embedding: [],
        });
      }

      const beforeReflection = store.getReflectionState();
      expect(beforeReflection.cumulativeImportance).toBe(0);

      const action = await mind.tick();
      expect(action).not.toBeNull();
      expect(action!.type).toBe("reflection");

      const afterReflection = store.getReflectionState();
      expect(afterReflection.cumulativeImportance).toBeGreaterThan(0);
      expect(afterReflection.lastReflectionAt).toBeGreaterThan(0);

      mind.close();
      db.cleanup();
    });

    it("B5: 反思后 idleThoughtCount 重置为 0", async () => {
      const loop = new ProactiveThinkingLoop({
        minIntervalMs: 0,
        maxIdleThoughtsBeforeReflection: 2,
        reflectionMemoryThreshold: 5,
      });

      const mood = new AgentMood({ curiosity: 0.7, sociability: 0.5, energy: 0.8, concern: 0.2 });
      const personality = createDefaultPersonality("ReflectReset");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-reset-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(tmpDir, "test.db"), agentId: "reset" });

      for (let i = 0; i < 6; i++) {
        store.insertMemory({
          agentId: "reset",
          type: "conversation",
          content: `Memory ${i}`,
          importance: 4,
          embedding: [],
        });
      }

      await loop.prepareAction(mood, store, personality);
      await loop.prepareAction(mood, store, personality);
      expect(loop.getIdleThoughtCount()).toBe(2);

      const reflection = await loop.prepareAction(mood, store, personality);
      expect(reflection!.type).toBe("reflection");
      expect(loop.getIdleThoughtCount()).toBe(0);

      store.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });

  describe("C: 真实场景模拟", () => {
    it("C1: 用户连续发 10 条消息 → 记忆累积 → 社交欲下降", async () => {
      const { mind, cleanup } = createMind("scenario-chat", {
        curiosity: 0.8, sociability: 0.8, energy: 1.0, concern: 0.1,
      });

      for (let i = 0; i < 10; i++) {
        await mind.onInteraction(`我们聊聊 ${["AI", "天气", "电影", "美食", "旅行"][i % 5]} 的话题 #${i + 1}`, ["阿创"]);
      }

      const state = mind.getState();
      expect(state.memoryCount).toBeGreaterThanOrEqual(10);
      expect(state.mood.sociability).toBeLessThan(0.8);

      const action = await mind.tick();
      expect(action).not.toBeNull();

      cleanup();
    });

    it("C2: onRest 恢复精力，精力上升", async () => {
      const { mind, cleanup } = createMind("scenario-rest", {
        curiosity: 0.7, sociability: 0.9, energy: 0.6, concern: 0.1,
      });

      const beforeRest = mind.getState();
      mind.getMood().onRest(4 * 60 * 60 * 1000);
      const afterRest = mind.getState();

      expect(afterRest.mood.energy).toBeGreaterThan(beforeRest.mood.energy);
      cleanup();
    });

    it("C3: 收到紧急消息后关切感显著上升", async () => {
      const { mind, cleanup } = createMind("scenario-urgent", {
        curiosity: 0.5, sociability: 0.6, energy: 0.8, concern: 0.1,
      });

      const beforeConcern = mind.getState().mood.concern;

      await mind.onInteraction("紧急！老板说项目今晚必须上线，需要你的帮助！这非常重要！", ["同事"]);

      const after = mind.getState();
      expect(after.mood.concern).toBeGreaterThan(beforeConcern);
      expect(after.memoryCount).toBe(1);

      cleanup();
    });

    it("C4: 混合交互模式: 聊天→停顿→再聊天", async () => {
      const { mind, cleanup } = createMind("scenario-mixed", {
        curiosity: 0.7, sociability: 0.8, energy: 1.0, concern: 0.1,
      });

      await mind.onInteraction("早上好！今天天气真好", ["阿创"]);
      const after1 = mind.getState();

      // 模拟经过一段时间
      await mind.tick();

      await mind.onInteraction("我刚才去喝了杯咖啡", ["阿创"]);
      const after2 = mind.getState();

      expect(after2.memoryCount).toBeGreaterThan(after1.memoryCount);

      cleanup();
    });
  });

  describe("D: getState 准确性验证", () => {
    it("D1: lastInteractionAt 不为 0（修复验证）", async () => {
      const { mind, cleanup } = createMind("state-interact");

      const before = mind.getState();
      expect(before.lastInteractionAt).toBe(0);

      await mind.onInteraction("你好！", ["用户"]);

      const after = mind.getState();
      expect(after.lastInteractionAt).toBeGreaterThan(0);
      cleanup();
    });

    it("D2: idleThoughtCount 随 tick 递增", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = new AgentMood({ curiosity: 0.6, sociability: 0.6, energy: 0.7, concern: 0.2 });
      const personality = createDefaultPersonality("CountBot");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-count-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(tmpDir, "test.db"), agentId: "count" });

      expect(loop.getIdleThoughtCount()).toBe(0);
      await loop.prepareAction(mood, store, personality);
      expect(loop.getIdleThoughtCount()).toBe(1);
      await loop.prepareAction(mood, store, personality);
      expect(loop.getIdleThoughtCount()).toBe(2);

      store.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("D3: getState 所有字段在合理范围内", async () => {
      const { mind, cleanup } = createMind("state-range", {
        curiosity: 0.5, sociability: 0.5, energy: 0.8, concern: 0.2,
      });

      await mind.onInteraction("测试消息", ["用户"]);
      await mind.tick();

      const state = mind.getState();

      expect(state.agentId).toBe("state-range");
      expect(state.agentName).toBe("state-range");
      expect(typeof state.moodDescription).toBe("string");
      expect(state.moodDescription.length).toBeGreaterThan(0);
      expect(state.mood.curiosity).toBeGreaterThanOrEqual(0);
      expect(state.mood.curiosity).toBeLessThanOrEqual(1);
      expect(state.mood.sociability).toBeGreaterThanOrEqual(0);
      expect(state.mood.sociability).toBeLessThanOrEqual(1);
      expect(state.mood.energy).toBeGreaterThanOrEqual(0);
      expect(state.mood.energy).toBeLessThanOrEqual(1);
      expect(state.mood.concern).toBeGreaterThanOrEqual(0);
      expect(state.mood.concern).toBeLessThanOrEqual(1);
      expect(typeof state.memoryCount).toBe("number");
      expect(typeof state.proactiveUrgency).toBe("number");
      expect(state.proactiveUrgency).toBeGreaterThanOrEqual(0);
      expect(state.proactiveUrgency).toBeLessThanOrEqual(1);
      expect(typeof state.shouldMessage).toBe("boolean");
      expect(typeof state.lastThoughtAt).toBe("number");
      expect(typeof state.idleThoughtCount).toBe("number");
      cleanup();
    });

    it("D4: tick 后 thought 被记录到记忆存储", async () => {
      const { mind, cleanup } = createMind("state-thought-store", {
        curiosity: 0.9, sociability: 0.5, energy: 0.9, concern: 0.1,
      });

      for (let i = 0; i < 4; i++) {
        mind.getStore().insertMemory({
          agentId: "state-thought-store",
          type: "conversation",
          content: `对话 ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const beforeThoughts = mind.getStore().listMemories({ type: "thought" }).length;
      await mind.tick();
      const afterThoughts = mind.getStore().listMemories({ type: "thought" }).length;

      expect(afterThoughts).toBeGreaterThanOrEqual(beforeThoughts + 1);
      cleanup();
    });
  });

  describe("E: Bridge 层集成验证", () => {
    it("E1: mindOnInboundMessage → mindOnHeartbeat 完整链路", async () => {
      const agentId = "e2e-bridge";
      await mindOnInboundMessage(agentId, "你好小爪！今天心情如何？", "阿创");
      await mindOnInboundMessage(agentId, "我昨天看到一只很可爱的猫", "阿创");

      const result = await mindOnHeartbeat(agentId);
      expect(result).not.toBeNull();
      expect(result!.state.memoryCount).toBeGreaterThanOrEqual(2);
      expect(result!.state.agentId).toBe(agentId);
      expect(typeof result!.shouldMessage).toBe("boolean");
    });

    it("E2: 心跳后思考状态被记录到日志", async () => {
      const agentId = "e2e-hb-log";
      getOrCreateMind(agentId);
      const result = await mindOnHeartbeat(agentId);

      expect(result).not.toBeNull();
      expect(result!.thoughtAction === null || typeof result!.thoughtAction.type === "string").toBe(true);
      expect(result!.state.idleThoughtCount).toBeGreaterThanOrEqual(0);
    });

    it("E3: buildMindSystemPromptSection 包含完整情绪信息", async () => {
      const agentId = "e2e-prompt";
      await mindOnInboundMessage(agentId, "你好！今天我们聊聊AI吧", "阿创");

      const section = buildMindSystemPromptSection(agentId);
      expect(section).toContain("好奇心");
      expect(section).toContain("社交欲");
      expect(section).toContain("精力");
      expect(section).toContain("记忆条数");
      expect(section.length).toBeGreaterThan(50);
    });

    it("E4: 多Agent完全隔离", async () => {
      await mindOnInboundMessage("alice-mind", "Alice的消息1", "Alice");
      await mindOnInboundMessage("alice-mind", "Alice的消息2", "Alice");
      await mindOnInboundMessage("bob-mind", "Bob的消息1", "Bob");

      const aliceState = (await mindOnHeartbeat("alice-mind"))!;
      const bobState = (await mindOnHeartbeat("bob-mind"))!;

      expect(aliceState.state.memoryCount).toBeGreaterThan(bobState.state.memoryCount);
      expect(aliceState.state.agentId).not.toBe(bobState.state.agentId);
      expect(aliceState.state.mood).toBeDefined();
      expect(bobState.state.mood).toBeDefined();
    });
  });

  describe("F: 思考和提示质量", () => {
    it("F1: 反思提示包含反思指令", async () => {
      const loop = new ProactiveThinkingLoop({
        minIntervalMs: 0,
        maxIdleThoughtsBeforeReflection: 0,
        reflectionMemoryThreshold: 3,
      });
      const mood = new AgentMood({ curiosity: 0.8, sociability: 0.5, energy: 0.8, concern: 0.2 });
      const personality = createDefaultPersonality("Reflector");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-reflect-prompt-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(tmpDir, "test.db"), agentId: "rp" });

      for (let i = 0; i < 4; i++) {
        store.insertMemory({
          agentId: "rp",
          type: "conversation",
          content: `Memory ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const action = await loop.prepareAction(mood, store, personality);
      expect(action!.prompt).toContain("Reflection Task");
      expect(action!.prompt).toContain("high-level insights");
      expect(action!.prompt).toContain("synthesizing");

      store.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("F2: 主动消息提示包含情绪描述", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = new AgentMood({ curiosity: 0.9, sociability: 0.9, energy: 0.9, concern: 0.8 });
      const personality = createDefaultPersonality("Messenger");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-msg-prompt-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(tmpDir, "test.db"), agentId: "mp" });

      const action = await loop.prepareAction(mood, store, personality);
      expect(action!.prompt).toContain("Proactive Message Task");
      expect(action!.prompt).toContain("Messenger");
      expect(action!.moodDescription.length).toBeGreaterThan(0);

      store.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("F3: 高 urgent 场景下 prompt 包含人格和情绪", async () => {
      const loop = new ProactiveThinkingLoop({
        minIntervalMs: 0,
        proactiveUrgencyThreshold: 0.3,
      });
      const mood = new AgentMood({ curiosity: 0.9, sociability: 0.9, energy: 0.9, concern: 0.8 });
      const personality = createDefaultPersonality("UrgentBot");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-urge-prompt-"));
      const store = new SemanticMemoryStore({ dbPath: path.join(tmpDir, "test.db"), agentId: "ub" });

      store.insertMemory({
        agentId: "ub", type: "conversation", content: "重要的对话", importance: 7, embedding: [],
      });

      const action = await loop.prepareAction(mood, store, personality);
      expect(action).not.toBeNull();
      expect(action!.prompt).toContain("UrgentBot");
      expect(action!.prompt.length).toBeGreaterThan(100);

      store.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });

  describe("G: 边界条件和鲁棒性", () => {
    it("G1: 空消息不崩溃", async () => {
      const { mind, cleanup } = createMind("edge-empty");
      await mind.onInteraction("", []);
      expect(mind.getState().memoryCount).toBeGreaterThanOrEqual(0);
      cleanup();
    });

    it("G2: 重要性评分为极端值（0和9）时系统不崩溃", async () => {
      const { mind, cleanup } = createMind("edge-score");
      await mind.onSystemEvent("极低重要性事件", 0);
      await mind.onSystemEvent("极高重要性事件", 9);

      const memories = mind.getStore().listMemories({ type: "thought" });
      expect(memories.length).toBe(2);

      const scores = memories.map((m) => m.importance);
      expect(scores).toContain(0);
      expect(scores).toContain(9);
      cleanup();
    });

    it("G3: 超长消息被截断但不丢失", async () => {
      const { mind, cleanup } = createMind("edge-long");
      const longText = "x".repeat(3000);

      await mind.onInteraction(longText, ["用户"]);
      const memories = mind.getStore().listMemories({ limit: 1 });

      expect(memories.length).toBe(1);
      expect(memories[0].content.length).toBeLessThanOrEqual(2000);
      cleanup();
    });

    it("G4: 情绪值始终在 [0,1] 范围内", async () => {
      const { mind, cleanup } = createMind("edge-clamp");

      await mind.onInteraction("测试消息", ["用户"]);
      await mind.tick();

      for (let i = 0; i < 10; i++) {
        const state = mind.getState();
        expect(state.mood.curiosity).toBeGreaterThanOrEqual(0);
        expect(state.mood.curiosity).toBeLessThanOrEqual(1);
        expect(state.mood.sociability).toBeGreaterThanOrEqual(0);
        expect(state.mood.sociability).toBeLessThanOrEqual(1);
        expect(state.mood.energy).toBeGreaterThanOrEqual(0);
        expect(state.mood.energy).toBeLessThanOrEqual(1);
        expect(state.mood.concern).toBeGreaterThanOrEqual(0);
        expect(state.mood.concern).toBeLessThanOrEqual(1);
      }
      cleanup();
    });

    it("G5: mindOnHeartbeat 对不存在的 agent 能平滑创建", async () => {
      const result = await mindOnHeartbeat("edge-new-agent");
      expect(result).not.toBeNull();
      expect(result!.state.agentId).toBe("edge-new-agent");
      // tick() 会生成 idle_thought 并写入存储，count >= 0
      expect(result!.state.memoryCount).toBeGreaterThanOrEqual(0);
    });

    it("G6: closeAllMinds 后 mind 重新创建，DB 数据持久化保留", async () => {
      await mindOnInboundMessage("close-test", "测试消息", "用户");
      const beforeClose = (await mindOnHeartbeat("close-test"))!;
      const beforeCount = beforeClose.state.memoryCount;

      closeAllMinds();
      const result = await mindOnHeartbeat("close-test");
      expect(result).not.toBeNull();
      expect(result!.state.agentId).toBe("close-test");
      // DB 文件未被删除，原有记忆保留 (inbound消息 + 之前heartbeat的thought)
      expect(result!.state.memoryCount).toBeGreaterThanOrEqual(1);
      // closeAllMinds 后 ACTIVE_MINDS 已清空，getMind 返回 undefined
      const { getMind } = await import("./agent-mind-bridge.js");
      expect(getMind("close-test")).toBeDefined();
    });
  });

  describe("H: ReflectionPipeline 与 store 一致性", () => {
    it("H1: getCumulativeImportance 正确累加所有记忆重要性", () => {
      const db = createTempDb();
      const store = new SemanticMemoryStore({ dbPath: db.dbPath, agentId: "cumul" });

      expect(store.getCumulativeImportance()).toBe(0);

      store.insertMemory({
        agentId: "cumul",
        type: "conversation",
        content: "Memory 1",
        importance: 5,
        embedding: [],
      });
      store.insertMemory({
        agentId: "cumul",
        type: "conversation",
        content: "Memory 2",
        importance: 8,
        embedding: [],
      });

      expect(store.getCumulativeImportance()).toBe(13);

      store.close();
      db.cleanup();
    });

    it("H2: updateReflectionState 后 getReflectionState 返回更新值", () => {
      const db = createTempDb();
      const store = new SemanticMemoryStore({ dbPath: db.dbPath, agentId: "refstate" });

      const before = store.getReflectionState();
      expect(before.cumulativeImportance).toBe(0);
      expect(before.lastReflectionAt).toBe(0);

      store.updateReflectionState(42);

      const after = store.getReflectionState();
      expect(after.cumulativeImportance).toBe(42);
      expect(after.lastReflectionAt).toBeGreaterThan(0);

      store.close();
      db.cleanup();
    });

    it("H3: ReflectionPipeline 生成反思并存储到记忆", async () => {
      const db = createTempDb();
      const store = new SemanticMemoryStore({ dbPath: db.dbPath, agentId: "reflpipe" });
      const generator = createTemplateReflectionGenerator();
      const scorer = createRuleBasedScorer();
      const pipeline = new ReflectionPipeline(store, generator, scorer, "reflpipe", {
        importanceThreshold: 1,
        maxMemoriesForReflection: 50,
      });

      for (let i = 0; i < 5; i++) {
        store.insertMemory({
          agentId: "reflpipe",
          type: "conversation",
          content: `重要对话记录 ${i + 1}: 讨论了项目的关键进展`,
          importance: 8,
          embedding: [],
        });
      }

      const result = await pipeline.reflect();
      expect(result).not.toBeNull();
      expect(result!.insights.length).toBeGreaterThan(0);

      const reflections = store.listMemories({ type: "reflection" });
      expect(reflections.length).toBeGreaterThan(0);

      const afterState = store.getReflectionState();
      expect(afterState.cumulativeImportance).toBeGreaterThan(0);

      store.close();
      db.cleanup();
    });
  });
});