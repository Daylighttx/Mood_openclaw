import type { SemanticMemory, SemanticMemory as MemoryRecord } from "./types.js";
import { SemanticMemoryStore } from "./store.js";
import { SimpleEmbeddingProvider } from "./embeddings.js";
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

    this.embedder = new SimpleEmbeddingProvider();

    this.searcher = new MemorySearcher(this.store, this.embedder);

    const baselines: MoodBaselines = {
      curiosity: config.moodBaselines?.curiosity ?? config.personality.traits.curiosity,
      sociability: config.moodBaselines?.sociability ?? config.personality.traits.sociability,
      energy: config.moodBaselines?.energy ?? 1.0,
      concern: config.moodBaselines?.concern ?? 0.1,
    };

    this.mood = new AgentMood(baselines, config.moodConfig);

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
    if (this.planner.needsDailyUpdate()) {
      this.planner.updateDailyGoals(this.store, this.llmProvider).catch(() => {});
    }

    if (this.llmProvider && this.shouldRefreshRelationship()) {
      this.refreshRelationship(this.llmProvider).catch(() => {});
    }

    if (this.llmProvider && this.shouldAdaptPersonality()) {
      this.adaptPersonality(this.llmProvider).catch(() => {});
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

    this.thinkingLoop.recordThought(
      this.store,
      `[${action.type}] ${action.prompt.substring(0, 150)}`,
      action.importance,
    );

    amLog.info("tick: action produced", {
      agentId: this.agentId,
      type: action.type,
      importance: action.importance,
      urgency: Math.round(action.urgency * 1000) / 1000,
    });

    return action;
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

    const prompt = `你是 ${this.personality.name}。你在回顾自己最近的行为模式，决定是否需要调整自己的性格参数。

## 你的情绪系统工作原理

你有 4 个情绪维度（0到1之间）:
- sociability（社交欲）：想不想跟人说话
- curiosity（好奇心）：对新信息感不感兴趣
- energy（精力）：累不累
- concern（担忧）：有没有挂念对方

### 规则 1: S曲线社交欲
闲置越久，社交欲先涨后跌。峰值在 sCurvePeakMinutes 分钟，涨幅由 sCurveMultiplier 控制。
- sCurveMultiplier 高 → 闲置后很快想说话 → 表现为"粘人"
- sCurveMultiplier 低 → 闲置后慢悠悠 → 表现为"独立"
- 当前值: ${params.sCurveMultiplier}（默认0.08，范围0.03~0.15）

### 规则 2: S曲线峰值时机
- sCurvePeakMinutes 大 → 需要等待更久才最想说话
- sCurvePeakMinutes 小 → 很快就达到社交欲望高峰
- 当前值: ${params.sCurvePeakMinutes}（默认30分钟，范围10~90）

### 规则 3: 被冷落惩罚
当你主动发了消息但对方1小时没回，好奇心会额外衰减。
- neglectCuriosityPenalty 高 → 被冷落时很快失去兴趣 → "敏感型"
- neglectCuriosityPenalty 低 → 被冷落也不太在意 → "钝感型"
- 当前值: ${params.neglectCuriosityPenalty}（默认0.3，范围0.05~0.6）

### 规则 4: 深夜社交帽
凌晨0-6点社交欲被压在 nightSocCap 以下。
- nightSocCap 低 → 深夜几乎不说话 → "规律作息"
- nightSocCap 高 → 深夜也能保持社交欲 → "夜猫子"
- 当前值: ${params.nightSocCap}（默认0.5，范围0.2~0.8）

### 其他重要规则（不可调，仅供参考）
- 每次互动后，社交欲×0.85（暂时满足），好奇心×0.95（短暂降低）
- 闲置超过30分钟，好奇心开始缓慢下降（"没人聊就无聊"）
- 闲置超过2小时，担忧开始上升（"ta怎么不理我了"）
- 精力白天稳定，深夜恢复（凌晨0-6点恢复速度2倍）
- 极度担忧(>0.8)时强制降低社交欲，模拟"焦虑时不想社交"
- 对方没回复超过3次 → 永远不再主动发消息

## 近期互动
${recentMems.slice(0, 10).map((m, i) => `${i + 1}. ${m.content}`).join("\n")}

当前情绪: ${state.moodDescription}
今日主动消息数: ${this.thinkingLoop.getProactiveToday()}

## 决策要求

1. 每个参数调整不超过当前值的 ±20%（系统会自动限制在±30%以内）
2. 只在有明确理由时调整，否则 changed=false
3. 考虑长期趋势而非单次事件
4. 同一批调整不要超过2个参数

只输出 JSON（不要markdown）:
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