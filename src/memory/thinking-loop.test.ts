import { describe, expect, it, beforeEach } from "vitest";
import {
  ProactiveThinkingLoop,
  DEFAULT_THINKING_CONFIG,
  type ThoughtType,
} from "./thinking-loop.js";
import { AgentMood } from "../agents/mood.js";
import { createDefaultPersonality } from "../agents/personality.js";
import { SemanticMemoryStore } from "./store.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function createTestStore(agentId: string): SemanticMemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-loop-test-"));
  const dbPath = path.join(dir, "test.db");
  return new SemanticMemoryStore({ dbPath, agentId });
}

function createSocialMood(): AgentMood {
  return new AgentMood({
    curiosity: 0.8,
    sociability: 0.8,
    energy: 0.9,
    concern: 0.3,
  });
}

function createLowEnergyMood(): AgentMood {
  return new AgentMood({
    curiosity: 0.8,
    sociability: 0.8,
    energy: 0.1,
    concern: 0.3,
  });
}

function createCalmMood(): AgentMood {
  return new AgentMood({
    curiosity: 0.3,
    sociability: 0.3,
    energy: 0.3,
    concern: 0.1,
  });
}

const testPersonality = createDefaultPersonality("TestAgent");

describe("ProactiveThinkingLoop", () => {
  let loop: ProactiveThinkingLoop;

  beforeEach(() => {
    loop = new ProactiveThinkingLoop();
  });

  describe("shouldActivate", () => {
    it("activates with social, curious, energetic mood", () => {
      const mood = createSocialMood();
      expect(loop.shouldActivate(mood)).toBe(true);
    });

    it("does not activate with low energy", () => {
      const mood = createLowEnergyMood();
      expect(loop.shouldActivate(mood)).toBe(false);
    });

    it("does not activate with calm mood", () => {
      const mood = createCalmMood();
      expect(loop.shouldActivate(mood)).toBe(false);
    });

    it("respects min interval cooldown", async () => {
      const mood = createSocialMood();
      const store = createTestStore("agent-cooldown");

      const action1 = await loop.prepareAction(mood, store, testPersonality);
      expect(action1).not.toBeNull();

      const action2 = await loop.prepareAction(mood, store, testPersonality);
      expect(action2).toBeNull();
    });

    it("activates again after cooldown (simulated)", () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = createSocialMood();

      expect(loop.shouldActivate(mood)).toBe(true);
      expect(loop.shouldActivate(mood)).toBe(true);
    });
  });

  describe("prepareAction", () => {
    it("returns null when should not activate", async () => {
      const mood = createLowEnergyMood();
      const store = createTestStore("agent-1");

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action).toBeNull();
    });

    it("returns idle_thought as default action type", async () => {
      const mood = createSocialMood();
      const store = createTestStore("agent-1");

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("idle_thought");
      expect(action!.importance).toBe(3);
      expect(action!.urgency).toBeGreaterThanOrEqual(0);
      expect(action!.prompt).toContain("Idle Thought Task");
    });

    it("returns observation when curiosity is high and memories exist", async () => {
      const mood = new AgentMood({
        curiosity: 0.9,
        sociability: 0.5,
        energy: 0.8,
        concern: 0.1,
      });
      const store = createTestStore("agent-1");

      store.insertMemory({
        agentId: "agent-1",
        type: "conversation",
        content: "User asked about the weather today.",
        importance: 5,
        embedding: [],
      });
      store.insertMemory({
        agentId: "agent-1",
        type: "conversation",
        content: "Discussed project timeline for Q3.",
        importance: 6,
        embedding: [],
      });
      store.insertMemory({
        agentId: "agent-1",
        type: "conversation",
        content: "User mentioned they like hiking.",
        importance: 4,
        embedding: [],
      });
      store.insertMemory({
        agentId: "agent-1",
        type: "conversation",
        content: "Shared a joke about programming.",
        importance: 3,
        embedding: [],
      });

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("observation");
      expect(action!.importance).toBe(5);
    });

    it("returns proactive_message when urgency is high and should message", async () => {
      const mood = new AgentMood({
        curiosity: 0.9,
        sociability: 0.9,
        energy: 0.9,
        concern: 0.8,
      });
      (mood as Record<string, unknown>).lastInteractionAt = 0;
      const store = createTestStore("agent-1");

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("proactive_message");
      expect(action!.importance).toBe(6);
      expect(action!.prompt).toContain("Proactive Message Task");
    });

    it("returns reflection after enough idle thoughts and memories", async () => {
      const mood = createSocialMood();
      const store = createTestStore("agent-1");

      for (let i = 0; i < 12; i++) {
        store.insertMemory({
          agentId: "agent-1",
          type: "conversation",
          content: `Memory entry number ${i + 1}`,
          importance: 5,
          embedding: [],
        });
      }

      const loop = new ProactiveThinkingLoop({
        maxIdleThoughtsBeforeReflection: 0,
      });

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("reflection");
    });

    it("builds prompt containing personality and mood", async () => {
      const mood = createSocialMood();
      const store = createTestStore("agent-1");

      store.insertMemory({
        agentId: "agent-1",
        type: "conversation",
        content: "User asked about AI safety.",
        importance: 7,
        embedding: [],
      });

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action).not.toBeNull();
      expect(action!.prompt).toContain("TestAgent");
      expect(action!.moodDescription.length).toBeGreaterThan(0);
    });
  });

  describe("thought type priority", () => {
    it("prioritizes reflection over proactive_message", async () => {
      const mood = new AgentMood({
        curiosity: 0.9,
        sociability: 0.9,
        energy: 0.9,
        concern: 0.9,
      });
      const store = createTestStore("agent-reflect");

      for (let i = 0; i < 15; i++) {
        store.insertMemory({
          agentId: "agent-reflect",
          type: "conversation",
          content: `Conversation ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const loop = new ProactiveThinkingLoop({
        maxIdleThoughtsBeforeReflection: 0,
        reflectionMemoryThreshold: 10,
      });

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("reflection");
    });

    it("prioritizes proactive_message over observation", async () => {
      const mood = new AgentMood({
        curiosity: 0.8,
        sociability: 0.9,
        energy: 0.9,
        concern: 0.8,
      });
      (mood as Record<string, unknown>).lastInteractionAt = 0;
      const store = createTestStore("agent-msg");

      for (let i = 0; i < 5; i++) {
        store.insertMemory({
          agentId: "agent-msg",
          type: "conversation",
          content: `Conversation ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("proactive_message");
    });
  });

  describe("recordThought", () => {
    it("stores thought in memory and tracks last content", () => {
      const store = createTestStore("agent-record");
      loop.recordThought(store, "I wonder what the user is working on today.", 5);

      expect(loop.lastThoughtContent()).toBe(
        "I wonder what the user is working on today.",
      );

      const memories = store.listMemories({ type: "thought" });
      expect(memories.length).toBe(1);
      expect(memories[0].content).toBe(
        "I wonder what the user is working on today.",
      );
      expect(memories[0].importance).toBe(5);
    });
  });

  describe("reset", () => {
    it("clears all internal state", async () => {
      const mood = createSocialMood();
      const store = createTestStore("agent-reset");

      await loop.prepareAction(mood, store, testPersonality);
      expect(loop.getLastThoughtAt()).toBeGreaterThan(0);

      loop.reset();
      expect(loop.getLastThoughtAt()).toBe(0);
      expect(loop.getIdleThoughtCount()).toBe(0);
      expect(loop.lastThoughtContent()).toBeNull();
    });
  });

  describe("idle thought counter", () => {
    it("tracks idle thought count across multiple actions", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = createSocialMood();
      const store = createTestStore("agent-idle");

      expect(loop.getIdleThoughtCount()).toBe(0);

      await loop.prepareAction(mood, store, testPersonality);
      expect(loop.getIdleThoughtCount()).toBe(1);

      await loop.prepareAction(mood, store, testPersonality);
      expect(loop.getIdleThoughtCount()).toBe(2);
    });
  });

  describe("prompt generation", () => {
    it("generates reflection prompt with instructions", async () => {
      const mood = createSocialMood();
      const store = createTestStore("agent-prompt");

      for (let i = 0; i < 12; i++) {
        store.insertMemory({
          agentId: "agent-prompt",
          type: "conversation",
          content: `Entry ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const loop = new ProactiveThinkingLoop({
        maxIdleThoughtsBeforeReflection: 0,
      });

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action!.prompt).toContain("Reflection Task");
      expect(action!.prompt).toContain("high-level insights");
    });

    it("includes personality identity in prompt", async () => {
      const mood = createSocialMood();
      const store = createTestStore("agent-identity");

      const personality = createDefaultPersonality("CuriousBot");
      const action = await loop.prepareAction(mood, store, personality);

      expect(action!.prompt).toContain("CuriousBot");
      expect(action!.prompt).toContain("Your Identity");
    });
  });

  describe("config customization", () => {
    it("accepts custom min interval", async () => {
      const custom = new ProactiveThinkingLoop({ minIntervalMs: 60_000 });
      const mood = createSocialMood();
      const store = createTestStore("agent-interval");

      const action1 = await custom.prepareAction(mood, store, testPersonality);
      expect(action1).not.toBeNull();

      const action2 = await custom.prepareAction(mood, store, testPersonality);
      expect(action2).toBeNull();
    });

    it("accepts custom proactive threshold", async () => {
      const custom = new ProactiveThinkingLoop({
        proactiveUrgencyThreshold: 0.99,
      });
      const mood = new AgentMood({
        curiosity: 0.9,
        sociability: 0.9,
        energy: 0.9,
        concern: 0.9,
      });
      const store = createTestStore("agent-threshold");

      const action = await custom.prepareAction(mood, store, testPersonality);
      expect(action!.type).not.toBe("proactive_message");
    });

    it("respects reflectionMemoryThreshold config", async () => {
      const custom = new ProactiveThinkingLoop({
        minIntervalMs: 0,
        maxIdleThoughtsBeforeReflection: 0,
        reflectionMemoryThreshold: 5,
      });
      const mood = createSocialMood();
      const store = createTestStore("agent-ref-threshold");

      for (let i = 0; i < 3; i++) {
        store.insertMemory({
          agentId: "agent-ref-threshold",
          type: "conversation",
          content: `Memory ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const action = await custom.prepareAction(mood, store, testPersonality);
      expect(action!.type).not.toBe("reflection");
    });

    it("accepts custom contextMemoryCount", async () => {
      const custom = new ProactiveThinkingLoop({
        minIntervalMs: 0,
        contextMemoryCount: 2,
      });
      const mood = createSocialMood();
      const store = createTestStore("agent-ctx-count");

      for (let i = 0; i < 10; i++) {
        store.insertMemory({
          agentId: "agent-ctx-count",
          type: "conversation",
          content: `Variable content entry ${i}`,
          importance: 3,
          embedding: [],
        });
      }

      store.insertMemory({
        agentId: "agent-ctx-count",
        type: "conversation",
        content: "UNIQUE_MARKER_ABCDEFG",
        importance: 9,
        embedding: [],
      });

      const action = await custom.prepareAction(mood, store, testPersonality);
      expect(action!.prompt).toContain("UNIQUE_MARKER_ABCDEFG");
    });
  });

  describe("edge cases and defaults", () => {
    it("DEFAULT_THINKING_CONFIG has expected values", () => {
      expect(DEFAULT_THINKING_CONFIG.minIntervalMs).toBe(5 * 60 * 1000);
      expect(DEFAULT_THINKING_CONFIG.proactiveUrgencyThreshold).toBe(0.6);
      expect(DEFAULT_THINKING_CONFIG.reflectionMemoryThreshold).toBe(10);
      expect(DEFAULT_THINKING_CONFIG.contextMemoryCount).toBe(5);
      expect(DEFAULT_THINKING_CONFIG.maxIdleThoughtsBeforeReflection).toBe(8);
    });

    it("prepareAction with empty store shows no recent memories", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = createSocialMood();
      const store = createTestStore("agent-empty");

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action!.prompt).toContain("(no recent memories)");
    });

    it("idle_thought action has urgency field", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = createSocialMood();
      const store = createTestStore("agent-urgency");

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action!.type).toBe("idle_thought");
      expect(typeof action!.urgency).toBe("number");
      expect(action!.urgency).toBeGreaterThanOrEqual(0);
      expect(action!.urgency).toBeLessThanOrEqual(1);
    });

    it("observation action has urgency field", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = new AgentMood({
        curiosity: 0.9,
        sociability: 0.5,
        energy: 0.8,
        concern: 0.1,
      });
      const store = createTestStore("agent-obs-urgency");

      for (let i = 0; i < 5; i++) {
        store.insertMemory({
          agentId: "agent-obs-urgency",
          type: "conversation",
          content: `Memory ${i}`,
          importance: 5,
          embedding: [],
        });
      }

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action!.type).toBe("observation");
      expect(typeof action!.urgency).toBe("number");
      expect(action!.urgency).toBeGreaterThanOrEqual(0);
      expect(action!.urgency).toBeLessThanOrEqual(1);
    });

    it("builds proactive_message prompt with mood and identity", async () => {
      const mood = new AgentMood({
        curiosity: 0.9,
        sociability: 0.9,
        energy: 0.9,
        concern: 0.8,
      });
      (mood as Record<string, unknown>).lastInteractionAt = 0;
      const store = createTestStore("agent-pm-prompt");

      store.insertMemory({
        agentId: "agent-pm-prompt",
        type: "conversation",
        content: "User was excited about a new project.",
        importance: 5,
        embedding: [],
      });

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action!.type).toBe("proactive_message");
      expect(action!.prompt).toContain("Proactive Message Task");
      expect(action!.prompt).toContain("TestAgent");
      expect(action!.prompt).toContain("new project");
      expect(action!.prompt).toContain("1-3 sentences");
    });

    it("builds observation prompt with curiosity-driven instructions", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = new AgentMood({
        curiosity: 0.9,
        sociability: 0.5,
        energy: 0.8,
        concern: 0.1,
      });
      const store = createTestStore("agent-obs-prompt");

      for (let i = 0; i < 5; i++) {
        store.insertMemory({
          agentId: "agent-obs-prompt",
          type: "conversation",
          content: `Context ${i}`,
          importance: 4,
          embedding: [],
        });
      }

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action!.type).toBe("observation");
      expect(action!.prompt).toContain("Observation Task");
      expect(action!.prompt).toContain("genuine curiosity-driven");
    });

    it("builds idle_thought prompt with spontaneity guidance", async () => {
      const loop = new ProactiveThinkingLoop({ minIntervalMs: 0 });
      const mood = createSocialMood();
      const store = createTestStore("agent-idle-prompt");

      const action = await loop.prepareAction(mood, store, testPersonality);
      expect(action!.type).toBe("idle_thought");
      expect(action!.prompt).toContain("Idle Thought Task");
      expect(action!.prompt).toContain("spontaneous");
      expect(action!.prompt).toContain("1-2 sentences");
    });
  });
});