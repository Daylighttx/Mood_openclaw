import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { SemanticMemoryStore } from "./store.js";
import { SimpleEmbeddingProvider, EmbeddingCache } from "./embeddings.js";
import { createRuleBasedScorer, createMockScorer, ImportanceEvaluator, type ImportanceScorer } from "./importance.js";
import { MemorySearcher, formatMemoriesForPrompt } from "./search.js";
import { ConversationMemoryPipeline } from "./conversation-memory.js";
import { ReflectionPipeline, createTemplateReflectionGenerator } from "./reflection.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-test-"));
  return path.join(dir, "memory.db");
}

describe("SemanticMemoryStore", () => {
  it("creates a store and inserts a memory", () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });

    const mem = store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "User talked about their favorite color being blue.",
      importance: 7,
      embedding: [0.1, 0.2, 0.3],
      participants: ["user"],
    });

    expect(mem.id).toBeTruthy();
    expect(mem.type).toBe("conversation");
    expect(mem.importance).toBe(7);
    expect(mem.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(mem.participants).toEqual(["user"]);

    const retrieved = store.getMemory(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("User talked about their favorite color being blue.");

    store.close();
  });

  it("lists memories by type", () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Conversation about weather.",
      importance: 4,
      embedding: [0.1, 0.2],
    });

    store.insertMemory({
      agentId: "test-agent",
      type: "reflection",
      content: "User seems to love sunny days.",
      importance: 6,
      embedding: [0.3, 0.4],
    });

    const conversations = store.listMemories({ type: "conversation" });
    expect(conversations.length).toBe(1);
    expect(conversations[0].type).toBe("conversation");

    const all = store.listMemories();
    expect(all.length).toBe(2);

    store.close();
  });

  it("searches memories by vector similarity", () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "User loves dogs.",
      importance: 8,
      embedding: [1, 0, 0],
    });

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "User talked about space exploration.",
      importance: 5,
      embedding: [0, 1, 0],
    });

    const results = store.searchMemories([1, 0, 0], { limit: 2 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memory.content).toBe("User loves dogs.");
    expect(results[0].relevanceScore).toBeGreaterThan(0);

    store.close();
  });

  it("tracks cumulative importance for reflection", () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Important meeting discussed.",
      importance: 9,
      embedding: [0.1, 0.2],
    });

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Casual chat.",
      importance: 3,
      embedding: [0.3, 0.4],
    });

    const cumulative = store.getCumulativeImportance();
    expect(cumulative).toBe(12);

    store.updateReflectionState(12);
    const state = store.getReflectionState();
    expect(state.cumulativeImportance).toBe(12);

    store.close();
  });

  it("handles deletion", () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });

    const mem = store.insertMemory({
      agentId: "test-agent",
      type: "thought",
      content: "A passing thought.",
      importance: 2,
      embedding: [0.5, 0.5],
    });

    expect(store.memoryCount()).toBe(1);

    const deleted = store.deleteMemory(mem.id);
    expect(deleted).toBe(true);
    expect(store.memoryCount()).toBe(0);
    expect(store.getMemory(mem.id)).toBeNull();

    store.close();
  });
});

describe("EmbeddingProvider", () => {
  it("generates consistent embeddings", async () => {
    const provider = new SimpleEmbeddingProvider(128);

    const emb1 = await provider.embedQuery("hello world");
    const emb2 = await provider.embedQuery("hello world");
    const emb3 = await provider.embedQuery("something different");

    expect(emb1.length).toBe(128);
    expect(emb1).toEqual(emb2);
    expect(emb1).not.toEqual(emb3);
  });

  it("embedBatch works", async () => {
    const provider = new SimpleEmbeddingProvider(64);

    const results = await provider.embedBatch(["text a", "text b", "text c"]);
    expect(results.length).toBe(3);
    expect(results[0].length).toBe(64);
  });
});

describe("EmbeddingCache", () => {
  it("caches and retrieves embeddings", () => {
    const cache = new EmbeddingCache(100);

    cache.set("test-provider", "test-model", "hello", [0.1, 0.2, 0.3]);
    const cached = cache.get("test-provider", "test-model", "hello");

    expect(cached).toEqual([0.1, 0.2, 0.3]);
    expect(cache.size()).toBe(1);

    const miss = cache.get("test-provider", "test-model", "unknown");
    expect(miss).toBeUndefined();
  });

  it("evicts old entries when full", () => {
    const cache = new EmbeddingCache(2);

    cache.set("p", "m", "a", [1]);
    cache.set("p", "m", "b", [2]);
    cache.set("p", "m", "c", [3]);

    expect(cache.size()).toBeLessThanOrEqual(2);
  });
});

describe("ImportanceEvaluator", () => {
  it("evaluates importance using rule-based scorer", async () => {
    const scorer = createRuleBasedScorer();
    const evaluator = new ImportanceEvaluator(scorer);

    const normal = await evaluator.evaluate({
      content: "We talked about the weather.",
      type: "conversation",
    });

    const important = await evaluator.evaluate({
      content: "This is an important urgent deadline that we must never forget.",
      type: "conversation",
    });

    expect(normal).toBeGreaterThanOrEqual(0);
    expect(normal).toBeLessThanOrEqual(9);
    expect(important).toBeGreaterThan(normal);
  });

  it("mock scorer returns fixed value", async () => {
    const scorer = createMockScorer(5);
    const evaluator = new ImportanceEvaluator(scorer);

    const result = await evaluator.evaluate({
      content: "anything",
      type: "conversation",
    });

    expect(result).toBe(5);
  });

  it("caches evaluated scores for same content", async () => {
    let callCount = 0;
    const scorer: ImportanceScorer = {
      async scoreImportance() {
        callCount++;
        return 8;
      },
    };
    const evaluator = new ImportanceEvaluator(scorer);

    const content = "This is an important urgent deadline that we must never forget.";

    const result1 = await evaluator.evaluate({ content, type: "conversation" });
    const result2 = await evaluator.evaluate({ content, type: "conversation" });

    expect(result1).toBe(8);
    expect(result2).toBe(8);
    expect(callCount).toBe(1);
  });

  it("clearCache resets cached scores", async () => {
    let callCount = 0;
    const scorer: ImportanceScorer = {
      async scoreImportance() {
        callCount++;
        return 7;
      },
    };
    const evaluator = new ImportanceEvaluator(scorer);

    const content = "Some moderately interesting content about plans.";

    await evaluator.evaluate({ content, type: "conversation" });
    expect(callCount).toBe(1);

    await evaluator.evaluate({ content, type: "conversation" });
    expect(callCount).toBe(1);

    evaluator.clearCache();

    await evaluator.evaluate({ content, type: "conversation" });
    expect(callCount).toBe(2);
  });
});

describe("MemorySearcher", () => {
  it("searches and ranks memories", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const searcher = new MemorySearcher(store, embedder);

    const emb1 = await embedder.embedQuery("User loves dogs and has a golden retriever");
    const emb2 = await embedder.embedQuery("User enjoys watching space documentaries");
    const emb3 = await embedder.embedQuery("User's favorite food is pizza");

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "User loves dogs and has a golden retriever named Max.",
      importance: 8,
      embedding: emb1,
      participants: ["user"],
    });

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "User enjoys watching space documentaries.",
      importance: 6,
      embedding: emb2,
      participants: ["user"],
    });

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "User's favorite food is pizza.",
      importance: 3,
      embedding: emb3,
      participants: ["user"],
    });

    const results = await searcher.search({
      query: "Tell me about the user's pets and dogs",
      limit: 3,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memory.content).toContain("dogs");

    store.close();
  });

  it("search with participantFilter boosts matching participants", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const searcher = new MemorySearcher(store, embedder);

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Talked to Alice about project deadlines.",
      importance: 8,
      embedding: [],
      participants: ["Alice"],
    });
    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Talked to Bob about the weather.",
      importance: 8,
      embedding: [],
      participants: ["Bob"],
    });

    const results = await searcher.search({
      query: "talking to people",
      limit: 5,
      participantFilter: ["Alice"],
    });

    expect(results.length).toBe(2);
    expect(results[0].memory.participants).toContain("Alice");

    store.close();
  });

  it("search with type filter returns only matching types", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const searcher = new MemorySearcher(store, embedder);

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "A normal chat about various topics.",
      importance: 5,
      embedding: [],
    });
    store.insertMemory({
      agentId: "test-agent",
      type: "reflection",
      content: "Deep insight about the user's personality.",
      importance: 5,
      embedding: [],
    });

    const conversationResults = await searcher.search({
      query: "topics personality",
      type: "conversation",
      limit: 5,
    });

    expect(conversationResults.length).toBe(1);
    expect(conversationResults[0].memory.type).toBe("conversation");

    const reflectionResults = await searcher.search({
      query: "topics personality",
      type: "reflection",
      limit: 5,
    });

    expect(reflectionResults.length).toBe(1);
    expect(reflectionResults[0].memory.type).toBe("reflection");

    store.close();
  });

  it("search with minScore filters low relevance results", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const searcher = new MemorySearcher(store, embedder);

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Python programming tutorial for beginners.",
      importance: 5,
      embedding: [],
    });

    const allResults = await searcher.search({
      query: "python programming",
      limit: 5,
    });

    const filteredResults = await searcher.search({
      query: "python programming",
      limit: 5,
      minScore: 0.99,
    });

    expect(filteredResults.length).toBeLessThanOrEqual(allResults.length);

    store.close();
  });

  it("searchByTopic delegates to search", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const searcher = new MemorySearcher(store, embedder);

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "I love hiking in the mountains on weekends.",
      importance: 5,
      embedding: [],
    });

    const results = await searcher.searchByTopic("hiking");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.content).toContain("hiking");

    store.close();
  });

  it("searchAboutPerson searches with person filter", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const searcher = new MemorySearcher(store, embedder);

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Charlie mentioned he wants to learn guitar.",
      importance: 5,
      embedding: [],
      participants: ["Charlie"],
    });
    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Discussed movies with Dave.",
      importance: 5,
      embedding: [],
      participants: ["Dave"],
    });

    const results = await searcher.searchAboutPerson("Charlie");
    expect(results.length).toBeGreaterThan(0);

    store.close();
  });

  it("formatMemoriesForPrompt formats non-empty results", () => {
    const results = [
      {
        memory: {
          id: "mem-1",
          agentId: "test",
          type: "conversation" as const,
          content: "User talked about dogs.",
          importance: 8,
          embedding: [],
          participants: ["user"],
          timestamp: Date.now(),
        },
        relevanceScore: 0.9,
        recencyScore: 0.5,
        importanceScore: 0.8,
        score: 0.73,
      },
    ];

    const formatted = formatMemoriesForPrompt(results);
    expect(formatted).toContain("[importance: 8/9]");
    expect(formatted).toContain("User talked about dogs.");
    expect(formatted).toContain("1.");
  });

  it("formatMemoriesForPrompt returns empty string for empty results", () => {
    const formatted = formatMemoriesForPrompt([]);
    expect(formatted).toBe("");
  });
});

describe("ConversationMemoryPipeline", () => {
  it("creates memories from conversations", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const scorer = createRuleBasedScorer();

    const pipeline = new ConversationMemoryPipeline(store, embedder, scorer);

    const ids = await pipeline.rememberConversation({
      agentId: "test-agent",
      participants: ["user", "assistant"],
      messages: [
        { role: "user", content: "I'm planning a trip to Japan next month." },
        { role: "assistant", content: "That sounds exciting! What cities are you visiting?" },
        { role: "user", content: "Tokyo and Kyoto. I want to see the cherry blossoms." },
        { role: "assistant", content: "Great choices! The cherry blossoms will be beautiful in spring." },
        { role: "user", content: "I also want to try authentic ramen and visit some temples." },
        { role: "assistant", content: "I can help you find the best ramen shops in Tokyo." },
      ],
      startedAt: Date.now() - 60000,
      endedAt: Date.now(),
    });

    expect(ids.length).toBeGreaterThan(0);

    const memory = store.getMemory(ids[0]);
    expect(memory).not.toBeNull();
    expect(memory!.type).toBe("conversation");
    expect(memory!.participants).toContain("user");
    expect(memory!.importance).toBeGreaterThan(0);

    store.close();
  });

  it("handles empty messages gracefully", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const scorer = createRuleBasedScorer();

    const pipeline = new ConversationMemoryPipeline(store, embedder, scorer);

    const ids = await pipeline.rememberConversation({
      agentId: "test-agent",
      participants: ["user"],
      messages: [],
      startedAt: Date.now() - 10000,
      endedAt: Date.now(),
    });

    expect(Array.isArray(ids)).toBe(true);

    store.close();
  });

  it("creates memory for single-message conversation", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(64);
    const scorer = createRuleBasedScorer();

    const pipeline = new ConversationMemoryPipeline(store, embedder, scorer);

    const ids = await pipeline.rememberConversation({
      agentId: "test-agent",
      participants: ["user"],
      messages: [
        { role: "user", content: "Hello!" },
      ],
      startedAt: Date.now() - 10000,
      endedAt: Date.now(),
    });

    expect(ids.length).toBe(1);
    const memory = store.getMemory(ids[0]);
    expect(memory!.content).toContain("Hello!");

    store.close();
  });
});

describe("ReflectionPipeline", () => {
  it("generates reflections when importance threshold is met", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const generator = createTemplateReflectionGenerator();
    const scorer = createMockScorer(5);

    const pipeline = new ReflectionPipeline(
      store,
      generator,
      scorer,
      "test-agent",
      { importanceThreshold: 10 },
    );

    for (let i = 0; i < 5; i++) {
      store.insertMemory({
        agentId: "test-agent",
        type: "conversation",
        content: `Important conversation ${i} about project deadlines and future plans`,
        importance: 8,
        embedding: [],
      });
    }

    const should = await pipeline.shouldReflect();
    expect(should).toBe(true);

    const result = await pipeline.reflect();
    expect(result).not.toBeNull();
    expect(result!.insights.length).toBeGreaterThan(0);

    const memories = store.listMemories({ type: "reflection" });
    expect(memories.length).toBeGreaterThan(0);

    store.close();
  });

  it("does not reflect when threshold not met", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const generator = createTemplateReflectionGenerator();
    const scorer = createMockScorer(5);

    const pipeline = new ReflectionPipeline(
      store,
      generator,
      scorer,
      "test-agent",
      { importanceThreshold: 100 },
    );

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Just a quick hello.",
      importance: 2,
      embedding: [],
    });

    const should = await pipeline.shouldReflect();
    expect(should).toBe(false);

    const result = await pipeline.reflect();
    expect(result).toBeNull();

    store.close();
  });

  it("forceReflect always generates reflections", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const generator = createTemplateReflectionGenerator();
    const scorer = createMockScorer(5);

    const pipeline = new ReflectionPipeline(
      store,
      generator,
      scorer,
      "test-agent",
    );

    store.insertMemory({
      agentId: "test-agent",
      type: "conversation",
      content: "Quick chat.",
      importance: 1,
      embedding: [],
    });

    const result = await pipeline.forceReflect();
    expect(result).not.toBeNull();
    expect(result.insights.length).toBeGreaterThan(0);

    store.close();
  });
});

describe("Full Memory Pipeline Integration", () => {
  it("conversation → memory → search → reflection pipeline", async () => {
    const dbPath = tmpDbPath();
    const store = new SemanticMemoryStore({ dbPath, agentId: "test-agent" });
    const embedder = new SimpleEmbeddingProvider(128);
    const scorer = createRuleBasedScorer();
    const searcher = new MemorySearcher(store, embedder);
    const conversationPipeline = new ConversationMemoryPipeline(store, embedder, scorer);
    const generator = createTemplateReflectionGenerator();
    const reflectionPipeline = new ReflectionPipeline(
      store,
      generator,
      scorer,
      "test-agent",
      { importanceThreshold: 15 },
    );

    await conversationPipeline.rememberConversation({
      agentId: "test-agent",
      participants: ["user"],
      messages: [
        { role: "user", content: "My dog Max is sick. I'm really worried about him." },
        { role: "assistant", content: "I'm sorry to hear that. What symptoms is he showing?" },
        { role: "user", content: "He's not eating and seems very tired. The vet appointment is tomorrow." },
        { role: "assistant", content: "I hope the vet can help. Let me note this down." },
      ],
      startedAt: Date.now() - 120000,
      endedAt: Date.now() - 60000,
    });

    await conversationPipeline.rememberConversation({
      agentId: "test-agent",
      participants: ["user"],
      messages: [
        { role: "user", content: "I got a promotion at work today!" },
        { role: "assistant", content: "Congratulations! That's amazing news!" },
        { role: "user", content: "I've been working toward this for 3 years." },
        { role: "assistant", content: "That's a huge achievement. You should celebrate!" },
      ],
      startedAt: Date.now() - 30000,
      endedAt: Date.now(),
    });

    expect(store.memoryCount()).toBe(2);

    const petResults = await searcher.search({
      query: "What's wrong with the user's dog?",
      limit: 3,
    });
    expect(petResults.length).toBeGreaterThan(0);
    expect(petResults[0].memory.content.toLowerCase()).toMatch(/dog|sick|vet|max/);

    const workResults = await searcher.search({
      query: "promotion congratulations celebrate work",
      limit: 3,
    });
    expect(workResults.length).toBeGreaterThan(0);
    expect(workResults[0].memory.content.toLowerCase()).toMatch(/promotion|work|congratulations/);

    const cumulative = store.getCumulativeImportance();
    expect(cumulative).toBeGreaterThan(0);

    const reflectionResult = await reflectionPipeline.forceReflect();
    expect(reflectionResult.insights.length).toBeGreaterThan(0);
    expect(reflectionResult.importance).toBeGreaterThan(0);

    const reflectionMemories = store.listMemories({ type: "reflection" });
    expect(reflectionMemories.length).toBeGreaterThan(0);

    store.close();
  });
});