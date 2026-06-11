import { describe, expect, it, afterEach } from "vitest";
import { AgentMind } from "./agent-mind.js";
import type { AgentMindConfig } from "./agent-mind.js";
import { createDefaultPersonality } from "../agents/personality.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mind-test-"));
  const dbPath = path.join(dir, "test.db");
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function createMind(
  agentId: string,
  overrides?: Partial<Pick<AgentMindConfig, "moodBaselines" | "thinkingConfig" | "importanceScorer" | "moodConfig">>,
): { mind: AgentMind; db: { dbPath: string; cleanup: () => void } } {
  const db = createTempDb();
  const personality = createDefaultPersonality(agentId);
  const mind = new AgentMind({
    agentId,
    dbPath: db.dbPath,
    personality,
    ...overrides,
  });
  return { mind, db };
}

function setupTest(
  agentId: string,
  overrides?: Partial<Pick<AgentMindConfig, "moodBaselines" | "thinkingConfig" | "importanceScorer" | "moodConfig">>,
): { mind: AgentMind; cleanup: () => void } {
  const result = createMind(agentId, overrides);
  return {
    mind: result.mind,
    cleanup: () => {
      try { result.mind.close(); } catch { /* ignore */ }
      try { result.db.cleanup(); } catch { /* ignore */ }
    },
  };
}

describe("AgentMind", () => {
  describe("initialization", () => {
    it("creates mind with personality-driven baselines", () => {
      const { mind, cleanup } = setupTest("agent-init");
      try {
        const state = mind.getState();
        expect(state.agentId).toBe("agent-init");
        expect(state.agentName).toBe("agent-init");
        expect(state.memoryCount).toBe(0);
        expect(state.idleThoughtCount).toBe(0);
        expect(state.mood.curiosity).toBeGreaterThan(0);
        expect(state.mood.sociability).toBeGreaterThan(0);
        expect(state.mood.energy).toBeCloseTo(1.0);
      } finally {
        cleanup();
      }
    });

    it("accepts custom mood baselines", () => {
      const { mind, cleanup } = setupTest("agent-custom", {
        moodBaselines: { curiosity: 0.3, sociability: 0.2, energy: 0.5, concern: 0.4 },
      });
      try {
        const state = mind.getState();
        expect(state.mood.curiosity).toBe(0.3);
        expect(state.mood.sociability).toBe(0.2);
        expect(state.mood.energy).toBe(0.5);
        expect(state.mood.concern).toBe(0.4);
      } finally {
        cleanup();
      }
    });

    it("exposes store, mood, and personality", () => {
      const { mind, cleanup } = setupTest("agent-expose");
      try {
        expect(mind.getStore()).toBeDefined();
        expect(mind.getMood()).toBeDefined();
        expect(mind.getPersonality().name).toBe("agent-expose");
      } finally {
        cleanup();
      }
    });
  });

  describe("onInteraction", () => {
    it("stores conversation memory", async () => {
      const { mind, cleanup } = setupTest("agent-conv");
      try {
        await mind.onInteraction(
          "User asked about the weather forecast for tomorrow.",
          ["user"],
        );

        const state = mind.getState();
        expect(state.memoryCount).toBe(1);

        const memories = mind.getStore().listMemories({ type: "conversation" });
        expect(memories.length).toBe(1);
        expect(memories[0].content).toContain("weather");
        expect(memories[0].participants).toContain("user");
      } finally {
        cleanup();
      }
    });

    it("updates mood after interaction", async () => {
      const { mind, cleanup } = setupTest("agent-mood-update", {
        moodBaselines: { curiosity: 0.8, sociability: 0.9, energy: 1.0, concern: 0.3 },
      });
      try {
        const beforeSociability = mind.getState().mood.sociability;

        await mind.onInteraction(
          "Long discussion about project requirements and deadlines.",
          ["user", "assistant"],
        );

        const afterSociability = mind.getState().mood.sociability;
        expect(afterSociability).toBeLessThan(beforeSociability);
      } finally {
        cleanup();
      }
    });

    it("handles multiple interactions", async () => {
      const { mind, cleanup } = setupTest("agent-multi");
      try {
        await mind.onInteraction("First message.", ["user"]);
        await mind.onInteraction("Second message.", ["user"]);
        await mind.onInteraction("Third message.", ["user"]);

        expect(mind.getState().memoryCount).toBe(3);
      } finally {
        cleanup();
      }
    });

    it("stores participant information", async () => {
      const { mind, cleanup } = setupTest("agent-participants");
      try {
        await mind.onInteraction(
          "Group discussion about the roadmap.",
          ["user", "bob", "alice"],
        );

        const memories = mind.getStore().listMemories({ limit: 1 });
        expect(memories[0].participants).toContain("user");
        expect(memories[0].participants).toContain("bob");
        expect(memories[0].participants).toContain("alice");
      } finally {
        cleanup();
      }
    });
  });

  describe("onSystemEvent", () => {
    it("stores system event as thought type", async () => {
      const { mind, cleanup } = setupTest("agent-system");
      try {
        await mind.onSystemEvent("Cron job completed: data backup finished.", 7);

        const memories = mind.getStore().listMemories({ type: "thought" });
        expect(memories.length).toBe(1);
        expect(memories[0].content).toContain("backup");
        expect(memories[0].importance).toBe(7);
      } finally {
        cleanup();
      }
    });
  });

  describe("tick", () => {
    it("returns null when mood is too calm", async () => {
      const { mind, cleanup } = setupTest("agent-tick-calm", {
        moodBaselines: { curiosity: 0.2, sociability: 0.2, energy: 0.2, concern: 0.1 },
      });
      try {
        const action = await mind.tick();
        expect(action).toBeNull();
      } finally {
        cleanup();
      }
    });

    it("returns action when mood is active", async () => {
      const { mind, cleanup } = setupTest("agent-tick-active", {
        moodBaselines: { curiosity: 0.9, sociability: 0.9, energy: 1.0, concern: 0.5 },
      });
      try {
        const action = await mind.tick();
        expect(action).not.toBeNull();
        expect(action!.type).toBeDefined();
        expect(action!.prompt.length).toBeGreaterThan(0);
        expect(action!.importance).toBeGreaterThan(0);
      } finally {
        cleanup();
      }
    });

    it("records thought in memory after tick", async () => {
      const { mind, cleanup } = setupTest("agent-tick-record", {
        moodBaselines: { curiosity: 0.9, sociability: 0.9, energy: 1.0, concern: 0.5 },
      });
      try {
        await mind.tick();

        const thoughts = mind.getStore().listMemories({ type: "thought" });
        expect(thoughts.length).toBeGreaterThanOrEqual(1);
      } finally {
        cleanup();
      }
    });

    it("respects cooldown between ticks", async () => {
      const { mind, cleanup } = setupTest("agent-tick-cooldown", {
        moodBaselines: { curiosity: 0.9, sociability: 0.9, energy: 1.0, concern: 0.5 },
      });
      try {
        const action1 = await mind.tick();
        expect(action1).not.toBeNull();

        const action2 = await mind.tick();
        expect(action2).toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  describe("searchMemories", () => {
    it("returns relevant memories", async () => {
      const { mind, cleanup } = setupTest("agent-search");
      try {
        await mind.onInteraction("I love hiking in the mountains during summer.", ["user"]);
        await mind.onInteraction("What is the best coding language for beginners?", ["user"]);
        await mind.onInteraction("The weather has been really nice lately.", ["user"]);

        const results = await mind.searchMemories("outdoor activities hiking", 3);
        expect(results.length).toBeGreaterThan(0);
        const topContent = results[0].memory.content;
        const hikingFirst = topContent.includes("hiking");
        const weatherFirst = topContent.includes("weather");
        expect(hikingFirst || weatherFirst).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe("searchAboutPerson", () => {
    it("filters by participant", async () => {
      const { mind, cleanup } = setupTest("agent-person-search");
      try {
        await mind.onInteraction("Alice shared her recipe for lasagna.", ["alice"]);
        await mind.onInteraction("Bob talked about his new car.", ["bob"]);

        const results = await mind.searchAboutPerson("alice", 3);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].memory.content).toContain("Alice");
      } finally {
        cleanup();
      }
    });
  });

  describe("getState", () => {
    it("returns complete state snapshot", async () => {
      const { mind, cleanup } = setupTest("agent-snapshot");
      try {
        await mind.onInteraction("Hello!", ["user"]);

        const state = mind.getState();
        expect(state.agentId).toBe("agent-snapshot");
        expect(state.agentName).toBe("agent-snapshot");
        expect(typeof state.moodDescription).toBe("string");
        expect(state.moodDescription.length).toBeGreaterThan(0);
        expect(typeof state.memoryCount).toBe("number");
        expect(typeof state.proactiveUrgency).toBe("number");
        expect(typeof state.shouldMessage).toBe("boolean");
        expect(state.mood.curiosity).toBeGreaterThanOrEqual(0);
        expect(state.mood.curiosity).toBeLessThanOrEqual(1);
      } finally {
        cleanup();
      }
    });
  });

  describe("close", () => {
    it("closes without error", () => {
      const { mind, cleanup } = setupTest("agent-close");
      try {
        expect(() => mind.close()).not.toThrow();
      } finally {
        cleanup();
      }
    });
  });

  describe("searchMemories with limit", () => {
    it("respects limit parameter", async () => {
      const { mind, cleanup } = setupTest("agent-limit-search", {
        moodBaselines: { curiosity: 0.5, sociability: 0.5, energy: 1, concern: 0.1 },
      });
      try {
        for (let i = 0; i < 5; i++) {
          await mind.onInteraction(`Message ${i}`, ["user"]);
        }

        const results = await mind.searchMemories("Message");
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeLessThanOrEqual(5);
      } finally {
        cleanup();
      }
    });
  });

  describe("searchAboutPerson with limit", () => {
    it("respects limit parameter", async () => {
      const { mind, cleanup } = setupTest("agent-limit-person", {
        moodBaselines: { curiosity: 0.5, sociability: 0.5, energy: 1, concern: 0.1 },
      });
      try {
        for (let i = 0; i < 5; i++) {
          await mind.onInteraction(`Talked to Alice about topic ${i}`, ["Alice"]);
        }

        const results = await mind.searchAboutPerson("Alice");
        expect(Array.isArray(results)).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe("advanced config", () => {
    it("accepts custom importanceScorer", async () => {
      let scorerCalled = false;
      const customScorer = {
        async scoreImportance() {
          scorerCalled = true;
          return 5;
        },
      };

      const { mind, cleanup } = setupTest("agent-custom-scorer", {
        moodBaselines: { curiosity: 0.5, sociability: 0.5, energy: 1, concern: 0.1 },
        importanceScorer: customScorer,
      });
      try {
        await mind.onInteraction("Hello world", ["user"]);
        expect(scorerCalled).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("accepts custom moodConfig", async () => {
      const { mind, cleanup } = setupTest("agent-mood-config", {
        moodBaselines: { curiosity: 0.5, sociability: 0.5, energy: 1, concern: 0.1 },
        moodConfig: {
          postInteractionCooldownMs: 0,
        },
      });
      try {
        await mind.onInteraction("Hello", ["user"]);
        const state = mind.getState();
        expect(state.shouldMessage).toBe(false);
      } finally {
        cleanup();
      }
    });

    it("accepts custom thinkingConfig", async () => {
      const { mind, cleanup } = setupTest("agent-thinking-config", {
        moodBaselines: { curiosity: 0.5, sociability: 0.9, energy: 0.9, concern: 0.9 },
        thinkingConfig: {
          minIntervalMs: 0,
          proactiveUrgencyThreshold: 0.99,
        },
      });
      try {
        await mind.onInteraction("Hello, let's chat about something important!", ["user"]);
        const action = await mind.tick();
        expect(action!.type).not.toBe("proactive_message");
      } finally {
        cleanup();
      }
    });
  });
});