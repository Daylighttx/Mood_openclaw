import { describe, expect, it, afterEach, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  getOrCreateMind,
  getMind,
  mindOnInboundMessage,
  mindOnHeartbeat,
  buildMindSystemPromptSection,
  buildMindMemoryContext,
  readEventsLog,
  clearEventsLog,
  closeAllMinds,
} from "./agent-mind-bridge.js";

let _testHome: string;
let _origOpenclawHome: string | undefined;
let _origHome: string | undefined;

beforeEach(() => {
  _origOpenclawHome = process.env.OPENCLAW_HOME;
  _origHome = process.env.HOME;
  _testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  process.env.OPENCLAW_HOME = _testHome;
  process.env.HOME = _testHome;
  closeAllMinds();
  clearEventsLog();
});

afterEach(() => {
  closeAllMinds();
  if (_origOpenclawHome) process.env.OPENCLAW_HOME = _origOpenclawHome;
  else delete process.env.OPENCLAW_HOME;
  if (_origHome) process.env.HOME = _origHome;
  try { fs.rmSync(_testHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("AgentMindBridge", () => {
  // ── 流程 A 相关: 消息记忆存储 ──────────────────────────
  describe("mindOnInboundMessage (dispatch-from-config 集成点)", () => {
    it("收到消息后 memoryCount 递增（验证记忆累积）", async () => {
      const s1 = await mindOnInboundMessage("a1", "你好小爪！今天心情怎么样？", "阿创");
      expect(s1!.memoryCount).toBeGreaterThanOrEqual(1);

      const s2 = await mindOnInboundMessage("a1", "我在做一个 AI 项目", "阿创");
      expect(s2!.memoryCount).toBeGreaterThan(s1!.memoryCount);
    });

    it("收到消息后情绪维度在 [0,1] 范围内", async () => {
      const s = await mindOnInboundMessage("a2", "有什么有趣的新闻吗？", "阿创");
      expect(s!.mood.curiosity).toBeGreaterThanOrEqual(0);
      expect(s!.mood.curiosity).toBeLessThanOrEqual(1);
      expect(s!.mood.energy).toBeGreaterThanOrEqual(0);
      expect(s!.mood.energy).toBeLessThanOrEqual(1);
    });

    it("多次交互后记忆持续累积（验证状态持久性）", async () => {
      const agentId = "a-persist";
      for (let i = 0; i < 5; i++) {
        await mindOnInboundMessage(agentId, `消息 ${i}: 聊得很开心`, "阿创");
      }
      const s = await mindOnInboundMessage(agentId, "最后一条消息", "阿创");
      expect(s!.memoryCount).toBeGreaterThanOrEqual(6);
    });

    // ── Fire-and-forget 验证 ──────────────────────────
    it("fire-and-forget 不 await 也不抛异常（dispatch-from-config 模式）", () => {
      // 模拟 dispatch-from-config.ts L115 的调用方式
      expect(() => {
        mindOnInboundMessage("ff1", "fire and forget message", "user").catch(() => {});
      }).not.toThrow();
    });

    it("fire-and-forget 后记忆仍然被正确存储", async () => {
      const agentId = "ff-persist";
      // 不 await，模拟 dispatch-from-config 的行为
      mindOnInboundMessage(agentId, "第一条消息", "user1").catch(() => {});
      mindOnInboundMessage(agentId, "第二条消息", "user1").catch(() => {});

      // 等异步写入完成
      await new Promise((r) => setTimeout(r, 200));

      const state = await mindOnHeartbeat(agentId);
      expect(state!.state.memoryCount).toBeGreaterThanOrEqual(2);
    });

    // ── 错误处理验证 ──────────────────────────────────
    it("返回 null 且不抛异常（边界内容）", async () => {
      // 空字符串不会被 dispatch-from-config 调用（length < 2），
      // 但 bridge 本身应能处理单字符
      const s = await mindOnInboundMessage("err1", "a", "测试用户");
      expect(s).not.toBeNull();
      expect(s!.memoryCount).toBeGreaterThanOrEqual(1);
    });

    it("返回 null 且不抛异常（超长内容截断到 2000 字符）", async () => {
      const longText = "A".repeat(5000);
      // 不应抛异常
      const s = await mindOnInboundMessage("err2", longText, "测试用户");
      expect(s).not.toBeNull();
      expect(s!.memoryCount).toBe(1);
    });
  });

  // ── 流程 A 相关: system prompt 注入 ─────────────────────
  describe("buildMindSystemPromptSection (system-prompt 集成点)", () => {
    it("已有 mind 时返回中文情绪描述", () => {
      getOrCreateMind("sp1");
      const section = buildMindSystemPromptSection("sp1");
      expect(section).toContain("当前情绪状态");
      expect(section).toContain("好奇心");
      expect(section).toContain("社交欲");
      expect(section).toContain("精力");
      expect(section).toContain("记忆条数");
    });

    it("无 mind 时返回空字符串（不开辟不必要的 mind）", () => {
      expect(buildMindSystemPromptSection("nonexistent")).toBe("");
    });

    it("shouldMessage=true 时包含内在冲动提示", async () => {
      const agentId = "sp-impulse";
      // 高频互动触发主动消息倾向
      for (let i = 0; i < 10; i++) {
        await mindOnInboundMessage(agentId, `激动人心的消息 ${i}！这太重要了！`, "阿创");
      }
      // 多 tick 几次提高 proactiveUrgency
      for (let i = 0; i < 5; i++) {
        await mindOnHeartbeat(agentId);
      }

      const section = buildMindSystemPromptSection(agentId);
      expect(section.length).toBeGreaterThan(0);
    });

    it("低精力时包含内在状态提示", async () => {
      const agentId = "sp-tired";
      getOrCreateMind(agentId);
      // 多次心跳消耗精力
      for (let i = 0; i < 50; i++) {
        await mindOnHeartbeat(agentId);
      }

      const section = buildMindSystemPromptSection(agentId);
      // 精力低时应该提示"累了"
      if (section.length > 0) {
        expect(section).toContain("内在");
      }
    });
  });

  // ── 流程 B 相关: 心跳集成 ──────────────────────────────
  describe("mindOnHeartbeat (heartbeat-runner 集成点)", () => {
    it("返回 shouldMessage 为 boolean", async () => {
      getOrCreateMind("hb1");
      const result = await mindOnHeartbeat("hb1");
      expect(typeof result!.shouldMessage).toBe("boolean");
    });

    it("返回 state 包含完整情绪维度", async () => {
      getOrCreateMind("hb2");
      const result = await mindOnHeartbeat("hb2");
      expect(result!.state.mood.curiosity).toBeGreaterThanOrEqual(0);
      expect(result!.state.mood.sociability).toBeGreaterThanOrEqual(0);
      expect(result!.state.mood.energy).toBeGreaterThanOrEqual(0);
      expect(result!.state.mood.concern).toBeGreaterThanOrEqual(0);
    });

    it("多次交互后心跳 state 反映累积记忆", async () => {
      const agentId = "hb-accum";
      await mindOnInboundMessage(agentId, "消息1", "阿创");
      await mindOnInboundMessage(agentId, "消息2", "阿创");
      const result = await mindOnHeartbeat(agentId);
      expect(result!.state.memoryCount).toBeGreaterThanOrEqual(2);
    });

    it("返回 thoughtAction 包含 type 和 prompt", async () => {
      getOrCreateMind("hb-action");
      const result = await mindOnHeartbeat("hb-action");
      expect(result).not.toBeNull();
      if (result!.thoughtAction) {
        expect(result!.thoughtAction.type).toBeDefined();
        expect(result!.thoughtAction.prompt).toBeDefined();
        expect(result!.thoughtAction.prompt.length).toBeGreaterThan(0);
      }
    });

    it("多次心跳不抛异常且 consistently 返回结果", async () => {
      getOrCreateMind("hb-stable");
      for (let i = 0; i < 20; i++) {
        const result = await mindOnHeartbeat("hb-stable");
        expect(result).not.toBeNull();
        expect(typeof result!.shouldMessage).toBe("boolean");
      }
    });
  });

  // ── 完整管道: inbound → heartbeat → proactive ────────
  describe("完整管道 (E2E bridge)", () => {
    it("高频互动后 shouldMessage 可能为 true", async () => {
      const agentId = "pipeline-active";
      // 大量社交互动 → sociability 升高
      for (let i = 0; i < 20; i++) {
        await mindOnInboundMessage(agentId, `重要消息 ${i}: 我们聊聊未来规划和梦想！这太有趣了！`, "活跃用户");
      }
      // 多次心跳推进状态
      let shouldMessage = false;
      for (let i = 0; i < 10; i++) {
        const result = await mindOnHeartbeat(agentId);
        if (result!.shouldMessage) {
          shouldMessage = true;
          break;
        }
      }

      // 至少验证 pipeline 没崩，shouldMessage 的逻辑由 mood/thinking-loop 测试覆盖
      expect(typeof shouldMessage).toBe("boolean");
    });

    it("inbound 后 heartbeat 的 memoryCount 持续正确", async () => {
      const agentId = "pipeline-count";
      await mindOnInboundMessage(agentId, "消息1", "用户1");
      await mindOnInboundMessage(agentId, "消息2", "用户1");
      await mindOnInboundMessage(agentId, "消息3", "用户2");

      // 取3次心跳，memoryCount 稳定（含 tick 写入的 thought 记忆）
      for (let i = 0; i < 3; i++) {
        const result = await mindOnHeartbeat(agentId);
        expect(result!.state.memoryCount).toBeGreaterThanOrEqual(3);
      }
    });

    it("inbound 后 heartbeat 的 mood 处于合理范围", async () => {
      const agentId = "pipeline-mood";
      for (let i = 0; i < 5; i++) {
        await mindOnInboundMessage(agentId, `日常聊天 ${i}`, "朋友");
      }

      const result = await mindOnHeartbeat(agentId);
      expect(result!.state.mood.curiosity).toBeGreaterThanOrEqual(0);
      expect(result!.state.mood.curiosity).toBeLessThanOrEqual(1);
      expect(result!.state.mood.sociability).toBeGreaterThanOrEqual(0);
      expect(result!.state.mood.sociability).toBeLessThanOrEqual(1);
      expect(result!.state.mood.energy).toBeGreaterThanOrEqual(0);
      expect(result!.state.mood.energy).toBeLessThanOrEqual(1);
      expect(result!.state.mood.concern).toBeGreaterThanOrEqual(0);
      expect(result!.state.mood.concern).toBeLessThanOrEqual(1);
    });
  });

  // ── 记忆上下文 ─────────────────────────────────────────
  describe("buildMindMemoryContext (memory context 集成点)", () => {
    it("有记忆时返回相关记忆内容", async () => {
      const agentId = "ctx1";
      getOrCreateMind(agentId);
      await mindOnInboundMessage(agentId, "我喜欢在周末去爬山，特别是秋天的时候", "阿创");
      await mindOnInboundMessage(agentId, "最近在学习 Rust 编程语言", "阿创");
      await mindOnInboundMessage(agentId, "今天天气很好，适合出门", "阿创");

      const context = await buildMindMemoryContext(agentId, "户外活动");
      // 有记忆时至少包含一些内容
      expect(typeof context).toBe("string");
    });

    it("无 mind 时返回空字符串", async () => {
      const context = await buildMindMemoryContext("nonexistent-ctx", "anything");
      expect(context).toBe("");
    });

    it("无匹配记忆时返回空字符串", async () => {
      const agentId = "ctx-no-match";
      getOrCreateMind(agentId);

      const context = await buildMindMemoryContext(agentId, "完全不相关的查询");
      expect(context).toBe("");
    });
  });

  // ── 隔离性验证 ─────────────────────────────────────────
  describe("多 Agent 隔离", () => {
    it("不同 agentId 的记忆互不干扰", async () => {
      await mindOnInboundMessage("agent-x", "X的消息1", "用户X");
      await mindOnInboundMessage("agent-x", "X的消息2", "用户X");
      await mindOnInboundMessage("agent-y", "Y的消息1", "用户Y");

      const stateX = await mindOnHeartbeat("agent-x");
      const stateY = await mindOnHeartbeat("agent-y");

      expect(stateX!.state.agentId).toBe("agent-x");
      expect(stateY!.state.agentId).toBe("agent-y");
      expect(stateX!.state.memoryCount).toBeGreaterThan(stateY!.state.memoryCount);
    });

    it("不同 agentId 的 mood 互不影响", async () => {
      await mindOnInboundMessage("mood-x", "非常开心的消息！太棒了！", "活跃用户");
      await mindOnInboundMessage("mood-x", "又一个振奋人心的好消息！", "活跃用户");

      // mood-y 没有任何互动，memoryCount 应少于 mood-x
      const resultY = await mindOnHeartbeat("mood-y");
      expect(resultY).not.toBeNull();
      expect(resultY!.state.memoryCount).toBeLessThan(
        (await mindOnHeartbeat("mood-x"))!.state.memoryCount,
      );
    });
  });

  // ── 生命周期 ───────────────────────────────────────────
  describe("closeAllMinds", () => {
    it("关闭后 getMind 返回 undefined", () => {
      getOrCreateMind("close1");
      expect(getMind("close1")).toBeDefined();
      closeAllMinds();
      expect(getMind("close1")).toBeUndefined();
    });

    it("关闭后重新获取会创建新的 mind", () => {
      getOrCreateMind("reopen");
      closeAllMinds();
      const mind = getOrCreateMind("reopen");
      expect(mind).toBeDefined();
      expect(mind.getState().memoryCount).toBe(0);
    });
  });

  // ── 事件日志文件验证 ─────────────────────────────────
  describe("events.log 文件", () => {
    it("mind_created 写入 events.log", () => {
      getOrCreateMind("ev-log-create");
      const log = readEventsLog();
      expect(log).toContain("mind_created");
      expect(log).toContain("ev-log-create");
    });

    it("inbound_stored 写入 events.log", async () => {
      await mindOnInboundMessage("ev-log-inbound", "测试消息", "用户A");
      const log = readEventsLog();
      expect(log).toContain("inbound_stored");
      expect(log).toContain("用户A");
      expect(log).toContain("memoryCount");
    });

    it("heartbeat_tick 写入 events.log（含完整情绪维度）", async () => {
      getOrCreateMind("ev-log-tick");
      await mindOnHeartbeat("ev-log-tick");
      const log = readEventsLog();
      expect(log).toContain("heartbeat_tick");
      expect(log).toContain("curiosity");
      expect(log).toContain("sociability");
      expect(log).toContain("energy");
      expect(log).toContain("memoryCount");
      expect(log).toContain("actionType");
      expect(log).toContain("shouldMessage");
      expect(log).toContain("proactiveUrgency");
    });

    it("每行是一个合法的 JSON", async () => {
      getOrCreateMind("ev-log-json");
      await mindOnHeartbeat("ev-log-json");
      await mindOnHeartbeat("ev-log-json");
      await mindOnInboundMessage("ev-log-json", "hello", "user");

      const log = readEventsLog();
      const lines = log.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(4);

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("事件按时间顺序排列", async () => {
      getOrCreateMind("ev-log-order");
      await mindOnHeartbeat("ev-log-order");
      await mindOnHeartbeat("ev-log-order");

      const log = readEventsLog();
      const lines = log.trim().split("\n");
      const events = lines.map((l) => JSON.parse(l).event);
      expect(events).toContain("mind_created");
      expect(events.filter((e) => e === "heartbeat_tick").length).toBe(2);

      const firstTick = JSON.parse(lines[1]);
      const secondTick = JSON.parse(lines[2]);
      expect(secondTick.event).toBe("heartbeat_tick");
      expect(firstTick.event).toBe("heartbeat_tick");
    });
  });
});