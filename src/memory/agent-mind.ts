import type { SemanticMemory, SemanticMemory as MemoryRecord } from "./types.js";
import { SemanticMemoryStore } from "./store.js";
import { SimpleEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { MemorySearcher, type MemorySearchResult } from "./search.js";
import { createRuleBasedScorer, createLLMScorer, type ImportanceScorer } from "./importance.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MindLLMProvider } from "./llm-provider.js";
import type { AgentPersonality } from "../agents/personality.js";
import { Planner, type AgentPlan } from "./planner.js";
import {
  AgentMood,
  DEFAULT_MOOD_CONFIG,
  type MoodState,
  type MoodBaselines,
  type MoodConfig,
} from "../agents/mood.js";
import {
  ProactiveThinkingLoop,
  DEFAULT_THINKING_CONFIG,
  type ThinkingLoopConfig,
  type ThoughtAction,
} from "./thinking-loop.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const amLog = createSubsystemLogger("agent-mind").child("core");

export interface AgentMindConfig {
  agentId: string;
  dbPath: string;
  personality: AgentPersonality;
  moodBaselines?: Partial<MoodBaselines>;
  thinkingConfig?: Partial<ThinkingLoopConfig>;
  importanceScorer?: ImportanceScorer;
  moodConfig?: Partial<MoodConfig>;
  llmProvider?: MindLLMProvider;
  embedder?: EmbeddingProvider;
}

export interface AgentMindState {
  agentId: string;
  agentName: string;
  mood: MoodState;
  moodDescription: string;
  memoryCount: number;
  lastInteractionAt: number;
  lastThoughtAt: number;
  idleThoughtCount: number;
  proactiveUrgency: number;
  shouldMessage: boolean;
}

export class AgentMind {
  private store: SemanticMemoryStore;
  private mood: AgentMood;
  private personality: AgentPersonality;
  private thinkingLoop: ProactiveThinkingLoop;

  getThinkingLoop(): ProactiveThinkingLoop {
    return this.thinkingLoop;
  }
  private embedder: SimpleEmbeddingProvider;
  private searcher: MemorySearcher;
  private scorer: ImportanceScorer;
  private llmProvider: MindLLMProvider | undefined;
  private planner: Planner;
  private agentId: string;
  private lastRelationshipRefreshAt: number = 0;
  private conversationCountAtLastRefresh: number = 0;
  private lastPersonalityAdaptAt: number = 0;
  private lastVacuumAt: number = 0;
  private lastLongTermGoalsUpdate: number = 0;
  /** File path for persisting mood state across restarts. */
  private moodStatePath: string;
  /** Serializes tick() and inbound state resets to prevent stale counter writes. */
  private _tickGate: Promise<void> = Promise.resolve();

  /** Resolve for the current tick gate. Only set while tick() holds the gate. */
  private _releaseTickGate: (() => void) | null = null;

  constructor(config: AgentMindConfig) {
    this.agentId = config.agentId;
    this.personality = config.personality;
    this.llmProvider = config.llmProvider;
    this.planner = new Planner(config.agentId, config.personality);

    this.store = new SemanticMemoryStore({
      dbPath: config.dbPath,
      agentId: config.agentId,
    });

    this.scorer = config.importanceScorer
      ?? (this.llmProvider?.isAvailable()
        ? createLLMScorer(this.llmProvider)
        : createRuleBasedScorer());

    this.embedder = config.embedder ?? new SimpleEmbeddingProvider();

    this.searcher = new MemorySearcher(this.store, this.embedder);

    const baselines: MoodBaselines = {
      curiosity: config.moodBaselines?.curiosity ?? config.personality.traits.curiosity,
      sociability: config.moodBaselines?.sociability ?? config.personality.traits.sociability,
      energy: config.moodBaselines?.energy ?? 1.0,
      concern: config.moodBaselines?.concern ?? 0.1,
    };

    this.mood = new AgentMood(baselines, config.moodConfig);

    // Restore mood from previous run so the agent doesn't "forget" after restart.
    const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
    const mindDir = path.join(base, ".openclaw", "mind");
    this.moodStatePath = path.join(mindDir, `${config.agentId}-mood.json`);
    try {
      fs.mkdirSync(mindDir, { recursive: true });
      if (fs.existsSync(this.moodStatePath)) {
        const saved = fs.readFileSync(this.moodStatePath, "utf-8");
        this.mood = AgentMood.deserialize(saved);
        amLog.info("mood restored from previous run", { agentId: this.agentId });
      }
    } catch (err) {
      amLog.warn("mood restore failed, using fresh mood", { agentId: this.agentId, error: String(err) });
    }

    this.thinkingLoop = new ProactiveThinkingLoop(config.thinkingConfig);
  }

  getStore(): SemanticMemoryStore {
    return this.store;
  }

  getMood(): AgentMood {
    return this.mood;
  }

  getPersonality(): AgentPersonality {
    return this.personality;
  }

  getLLMProvider(): MindLLMProvider | undefined {
    return this.llmProvider;
  }

  /** Wait for any in-flight tick() to finish before resetting state.
   *  Call from the inbound-message path to avoid racing with heartbeat ticks. */
  async awaitTickGate(): Promise<void> {
    await this._tickGate;
  }

  getPlanner(): Planner {
    return this.planner;
  }

  async onInteraction(content: string, participants: string[]): Promise<void> {
    const embedding = await this.embedder.embedQuery(content);

    const importance = await this.scorer.scoreImportance({
      content,
      type: "conversation",
      participants,
    });

    this.store.insertMemory({
      agentId: this.agentId,
      type: "conversation",
      content: content.substring(0, 2000),
      importance,
      embedding,
      participants,
      keywords: this.extractKeywords(content),
    });

    this.mood.onInteraction();

    this.mood.onImportantEvent(importance);
  }

  async onSystemEvent(content: string, importance: number): Promise<void> {
    const embedding = await this.embedder.embedQuery(content);

    this.store.insertMemory({
      agentId: this.agentId,
      type: "thought",
      content: content.substring(0, 2000),
      importance,
      embedding,
      keywords: ["system", "event"],
    });

    this.mood.onImportantEvent(importance);
  }

  async tick(): Promise<ThoughtAction | null> {
    // Serialize with any previous tick and block inbound resets during LLM call.
    await this._tickGate;
    this._tickGate = new Promise<void>((r) => { this._releaseTickGate = r; });
    try {
    const now = Date.now();

    // Daily maintenance: prune stale low-importance memories to prevent unbounded DB growth.
    if (now - this.lastVacuumAt > 24 * 60 * 60 * 1000) {
      try {
        const removed = this.store.vacuumStale(500, 7);
        if (removed > 0) {
          amLog.info("vacuum: removed stale memories", { agentId: this.agentId, removed });
        }
      } catch (err) {
        amLog.warn("vacuum failed", { agentId: this.agentId, error: String(err) });
      }
      this.lastVacuumAt = now;
    }

    if (this.planner.needsDailyUpdate()) {
      this.planner.updateDailyGoals(this.store, this.llmProvider).catch(
        (err) => { amLog.warn("daily goals update failed", { agentId: this.agentId, error: String(err) }); },
      );
      if (this.llmProvider && now - this.lastLongTermGoalsUpdate > 24 * 60 * 60 * 1000) {
        this.planner.updateLongTermGoals(this.store, this.llmProvider).catch(
          (err) => { amLog.warn("long-term goals update failed", { agentId: this.agentId, error: String(err) }); },
        );
        this.lastLongTermGoalsUpdate = now;
      }
    }

    if (this.llmProvider && this.shouldRefreshRelationship()) {
      this.refreshRelationship(this.llmProvider).catch(
        (err) => { amLog.warn("relationship refresh failed", { agentId: this.agentId, error: String(err) }); },
      );
    }

    if (this.llmProvider && this.shouldAdaptPersonality()) {
      this.adaptPersonality(this.llmProvider).catch(
        (err) => { amLog.warn("personality adapt failed", { agentId: this.agentId, error: String(err) }); },
      );
    }

    const action = await this.thinkingLoop.prepareAction(
      this.mood,
      this.store,
      this.personality,
      this.llmProvider,
    );

    if (!action) {
      if (this.thinkingLoop.suppressedCount > 0) {
        const count = this.thinkingLoop.suppressedCount;
        this.thinkingLoop.suppressedCount = 0;
        this.mood.onSuppressed(count);
        amLog.info("tick: suppressed by external rules, mood dampened", {
          agentId: this.agentId,
          consecutiveSuppressions: count,
        });
      }
      amLog.info("tick: no action", {
        agentId: this.agentId,
        memoryCount: this.store.memoryCount(),
        idleThoughtCount: this.thinkingLoop.getIdleThoughtCount(),
      });
      return null;
    }

    this.thinkingLoop.suppressedCount = 0;

    const thoughtContent = `[${action.type}] ${action.prompt.substring(0, 150)}`;
    let thoughtEmbedding: number[] | undefined;
    try {
      thoughtEmbedding = await this.embedder.embedQuery(thoughtContent);
    } catch {
      // best-effort: embedding may fail if API is unavailable
    }
    this.thinkingLoop.recordThought(
      this.store,
      this.agentId,
      thoughtContent,
      action.importance,
      thoughtEmbedding,
    );

    amLog.info("tick: action produced", {
      agentId: this.agentId,
      type: action.type,
      importance: action.importance,
      urgency: Math.round(action.urgency * 1000) / 1000,
    });

    return action;
    } finally {
      this.saveMoodState();
      this._releaseTickGate?.();
      this._releaseTickGate = null;
    }
  }

  /** Persist mood to disk so it survives process restarts. */
  saveMoodState(): void {
    try {
      fs.writeFileSync(this.moodStatePath, this.mood.serialize(), "utf-8");
    } catch {
      // best-effort
    }
  }

  async searchMemories(
    query: string,
    limit?: number,
  ): Promise<MemorySearchResult[]> {
    return this.searcher.search({
      query,
      limit: limit ?? 5,
    });
  }

  async searchAboutPerson(
    personName: string,
    limit?: number,
  ): Promise<MemorySearchResult[]> {
    return this.searcher.searchAboutPerson(personName, { limit });
  }

  shouldRefreshRelationship(): boolean {
    if (!this.llmProvider?.isAvailable()) return false;
    if (this.lastRelationshipRefreshAt === 0) {
      return false;
    }
    const hoursSinceRefresh = (Date.now() - this.lastRelationshipRefreshAt) / 3_600_000;
    const convSinceRefresh = this.store.memoryCount() - this.conversationCountAtLastRefresh;
    return hoursSinceRefresh >= 6 || convSinceRefresh >= 8;
  }

  async refreshRelationship(llmProvider: MindLLMProvider): Promise<boolean> {
    const recentMemories = this.store.listMemories({ limit: 15 });
    if (recentMemories.length < 3) return false;

    const currentDesc = this.personality.relationship?.description ?? "朋友";
    const convLines = recentMemories.map((m, i) => `${i + 1}. ${m.content}`).join("\n");

    const prompt = `你是 ${this.personality.name}，${this.personality.identity}。

你和对话对象的关系目前是："${currentDesc}"

最近你们之间的这些对话:
${convLines}

基于这些最近的对话，你觉得你们的关系有变化吗？
如果没有明显变化，回答 "unchanged"。
如果发生了变化，用 1-2 句中文自然描述你们现在的关系（第一人称，像聊天时无意间透露的感觉）。

只回答 JSON（不要 markdown）：
{ "changed": true或false, "description": "如果changed为true，给出新的关系描述；否则为空字符串" }`;

    try {
      const result = await llmProvider.completeJSON<{ changed: boolean; description: string }>(prompt);
      if (result.changed && result.description && result.description.length > 3) {
        this.personality.relationship = {
          ...(this.personality.relationship ?? { user: "", description: "" }),
          description: result.description,
        };
        this.lastRelationshipRefreshAt = Date.now();
        this.conversationCountAtLastRefresh = this.store.memoryCount();
        amLog.info("relationship refreshed", {
          agentId: this.agentId,
          previous: currentDesc,
          updated: result.description,
        });
        return true;
      }
    } catch (err) {
      amLog.warn("relationship refresh failed", { error: String(err) });
    }
    return false;
  }

  markRelationshipActive(): void {
    if (this.lastRelationshipRefreshAt === 0) {
      this.lastRelationshipRefreshAt = Date.now();
      this.conversationCountAtLastRefresh = this.store.memoryCount();
    }
  }

  /** 标记人格自适应时钟已启动，避免首次 inbound 后立即触发 adaptPersonality。 */
  markPersonalityActive(): void {
    if (this.lastPersonalityAdaptAt === 0) {
      this.lastPersonalityAdaptAt = Date.now();
    }
  }

  shouldAdaptPersonality(): boolean {
    if (!this.llmProvider?.isAvailable()) return false;
    if (this.lastPersonalityAdaptAt === 0) {
      return false;
    }
    const hoursSince = (Date.now() - this.lastPersonalityAdaptAt) / 3_600_000;
    return hoursSince >= 12;
  }

  async adaptPersonality(llmProvider: MindLLMProvider): Promise<boolean> {
    const cfg = this.mood.getConfig?.() ?? {};
    const state = this.getState();
    const recentMems = this.store.listMemories({ limit: 15 });

    const params = {
      sCurveMultiplier: cfg.sCurveMultiplier ?? 0.08,
      sCurvePeakMinutes: cfg.sCurvePeakMinutes ?? 30,
      neglectCuriosityPenalty: cfg.neglectCuriosityPenalty ?? 0.3,
      nightSocCap: cfg.nightSocCap ?? 0.5,
    };

    const prompt = `你是 ${this.personality.name}。回顾最近的互动，决定是否需要调整 4 个性格参数。

可调参数（当前值 → 调整方向和含义）:
- sCurveMultiplier: ${params.sCurveMultiplier} (0.03~0.15) — 越高→粘人, 越低→独立
- sCurvePeakMinutes: ${params.sCurvePeakMinutes} (10~90) — 越大→慢热, 越小→急性子
- neglectCuriosityPenalty: ${params.neglectCuriosityPenalty} (0.05~0.6) — 越高→敏感型, 越低→钝感型
- nightSocCap: ${params.nightSocCap} (0.2~0.8) — 越低→规律作息, 越高→夜猫子

近期互动（最近 10 条）:
${recentMems.slice(0, 10).map((m, i) => `${i + 1}. ${m.content}`).join("\n")}

当前情绪: ${state.moodDescription} | 今日主动消息: ${this.thinkingLoop.getProactiveToday()}

规则: 只改有明显需求的参数，每批不超过 2 个，单次调幅 ±20%（代码会硬限制在 ±30%）。犹豫就选 changed=false。
只输出 JSON（不要 markdown）:
{ "changed": true或false, "changes": { "sCurveMultiplier": 数字, ... }, "reason": "1-2句中文说明为什么调整" }`;

    try {
      const result = await llmProvider.completeJSON<{
        changed: boolean;
        changes: Record<string, number>;
        reason: string;
      }>(prompt);

      if (result.changed && result.changes && Object.keys(result.changes).length > 0) {
        const allowed = ["sCurveMultiplier", "sCurvePeakMinutes", "neglectCuriosityPenalty", "nightSocCap"];
        const applied: Record<string, number> = {};
        for (const [key, val] of Object.entries(result.changes)) {
          if (allowed.includes(key) && typeof val === "number") {
            const original = params[key as keyof typeof params] ?? 0;
            const bounded = Math.max(original * 0.7, Math.min(original * 1.3, val));
            applied[key] = Math.round(bounded * 1000) / 1000;
          }
        }

        if (Object.keys(applied).length === 0) return false;

        this.mood.applyConfigDelta(applied);
        this.savePersonalityConfig(applied);
        this.lastPersonalityAdaptAt = Date.now();

        amLog.info("personality adapted", {
          agentId: this.agentId,
          changes: applied,
          reason: result.reason,
        });
        return true;
      }
    } catch (err) {
      amLog.warn("personality adapt failed", { error: String(err) });
    }
    return false;
  }

  private savePersonalityConfig(changes: Record<string, number>): void {
    try {
      const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
      const cfgPath = path.join(base, ".openclaw", "mind-config.json");
      if (fs.existsSync(cfgPath)) {
        const existing = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        existing.moodConfig = { ...(existing.moodConfig ?? {}), ...changes };
        fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), "utf-8");
      }
    } catch { /* best effort */ }
  }

  getState(): AgentMindState {
    const moodState = this.mood.getMood();

    return {
      agentId: this.agentId,
      agentName: this.personality.name,
      mood: moodState,
      moodDescription: this.mood.getMoodDescription(),
      memoryCount: this.store.memoryCount(),
      lastInteractionAt: this.mood.getLastInteractionAt(),
      lastThoughtAt: this.thinkingLoop.getLastThoughtAt(),
      idleThoughtCount: this.thinkingLoop.getIdleThoughtCount(),
      proactiveUrgency: this.mood.getProactiveUrgency(),
      shouldMessage: this.mood.shouldProactivelyMessage(),
    };
  }

  private extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4);

    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  close(): void {
    this.store.close();
  }
}