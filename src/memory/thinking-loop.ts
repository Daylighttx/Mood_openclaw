import type { SemanticMemoryStore } from "./store.js";
import type { AgentPersonality } from "../agents/personality.js";
import type { AgentMood } from "../agents/mood.js";
import { buildPersonalityPrompt } from "../agents/personality.js";
import type { MindLLMProvider } from "./llm-provider.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const thinkLog = createSubsystemLogger("agent-mind").child("thinking");

export interface ThinkingLoopConfig {
  minIntervalMs: number;
  proactiveUrgencyThreshold: number;
  reflectionMemoryThreshold: number;
  contextMemoryCount: number;
  maxIdleThoughtsBeforeReflection: number;
  llmActivationThreshold: number;
  maxProactivePerDay: number;
  userBusyCooldownMs: number;
  quietHourStart?: number;
  quietHourEnd?: number;
}

export const DEFAULT_THINKING_CONFIG: ThinkingLoopConfig = {
  minIntervalMs: 5 * 60 * 1000,
  proactiveUrgencyThreshold: 0.6,
  reflectionMemoryThreshold: 10,
  contextMemoryCount: 5,
  maxIdleThoughtsBeforeReflection: 8,
  llmActivationThreshold: 0.3,
  maxProactivePerDay: 48,
  userBusyCooldownMs: 5 * 60 * 1000,
};

export type ThoughtType = "reflection" | "observation" | "proactive_message" | "idle_thought";

export interface ThoughtAction {
  type: ThoughtType;
  importance: number;
  urgency: number;
  prompt: string;
  moodDescription: string;
  reason?: string;
  topic?: string;
}

export interface LLMDecision {
  action: "message" | "reflect" | "idle";
  reason: string;
  topic?: string;
  content?: string;
}

export class ProactiveThinkingLoop {
  private config: ThinkingLoopConfig;
  private lastThoughtAt: number;
  private idleThoughtCount: number;
  private _lastThoughtContent: string | null = null;
  private recentProactiveTopics: Array<{ topic: string; ts: number }> = [];
  private recentProactiveContents: Array<{ content: string; ts: number }> = [];
  private proactiveToday: number = 0;
  private proactiveDayStart: number = 0;
  unansweredProactiveCount: number = 0;
  lastUserMessage: string = "";
  lastAgentReply: string = "";
  userLastMessageAt: number = 0;
  suppressedCount: number = 0;
  lastProactiveSentAt: number = 0;

  constructor(config?: Partial<ThinkingLoopConfig>) {
    this.config = { ...DEFAULT_THINKING_CONFIG, ...config };
    this.lastThoughtAt = 0;
    this.idleThoughtCount = 0;
    this.proactiveDayStart = this.todayStart();
    this._lastThoughtContent = null;
  }

  shouldActivate(mood: AgentMood, unansweredCount: number = 0): boolean {
    const moodState = mood.getMood();
    if (moodState.energy < 0.15) {
      return false;
    }

    const penalty = unansweredCount >= 3 ? 0
      : unansweredCount === 2 ? 0.2
      : unansweredCount === 1 ? 0.5
      : 1.0;

    const thinkingDrive =
      (moodState.curiosity * 0.4 + moodState.sociability * 0.3 + moodState.energy * 0.3) * penalty;

    return thinkingDrive > this.config.llmActivationThreshold;
  }

  async prepareAction(
    mood: AgentMood,
    store: SemanticMemoryStore,
    personality: AgentPersonality,
    llmProvider?: MindLLMProvider,
  ): Promise<ThoughtAction | null> {
    const now = Date.now();

    if (this.lastThoughtAt > 0 && now - this.lastThoughtAt < this.config.minIntervalMs) {
      return null;
    }

    this.pruneRecentTopics(now);

    if (this.proactiveToday >= this.config.maxProactivePerDay) {
      this.suppressedCount++;
      return null;
    }

    if (this.userLastMessageAt > 0 && now - this.userLastMessageAt < this.config.userBusyCooldownMs) {
      this.suppressedCount++;
      return null;
    }

    if (this.isQuietHour(now)) {
      this.suppressedCount++;
      return null;
    }

    if (!this.shouldActivate(mood, this.unansweredProactiveCount)) {
      const moodState = mood.getMood();
      const thinkingDrive =
        moodState.curiosity * 0.4 + moodState.sociability * 0.3 + moodState.energy * 0.3;
      thinkLog.info("thought skipped: mood too calm", {
        thinkingDrive: Math.round(thinkingDrive * 1000) / 1000,
        energy: Math.round(moodState.energy * 100) / 100,
        curiosity: Math.round(moodState.curiosity * 100) / 100,
        sociability: Math.round(moodState.sociability * 100) / 100,
      });
      return null;
    }

    if (llmProvider?.isAvailable()) {
      const llmAction = await this.prepareActionWithLLM(mood, store, personality, llmProvider);
      if (llmAction) return llmAction;
    }

    return this.prepareActionFallback(mood, store, personality);
  }

  private async prepareActionWithLLM(
    mood: AgentMood,
    store: SemanticMemoryStore,
    personality: AgentPersonality,
    llmProvider: MindLLMProvider,
  ): Promise<ThoughtAction | null> {
    const moodState = mood.getMood();
    const moodDescription = mood.getMoodDescription();
    const urgency = mood.getProactiveUrgency();

    const recentMemories = store.listMemories({ limit: 10 });
    const recentContext = this.formatDetailedMemories(recentMemories);

    if (!this.lastAgentReply) {
      const convs = recentMemories.filter(
        m => m.type === "conversation" && m.createdAt > (this.userLastMessageAt || 0)
      );
      if (convs.length > 0) {
        this.lastAgentReply = convs[convs.length - 1].content.slice(0, 200);
      }
    }

    const reflections = store.listMemories({ type: "reflection", limit: 3 });
    const reflectionLines = reflections.length > 0
      ? ["Recent reflections:",
          ...reflections.map((m) =>
            `- ${m.content}`)]
      : [];

    const lastInteractionAt = mood.getLastInteractionAt();
    const timeSinceLastInteraction = lastInteractionAt
      ? this.formatTimeAgo(Date.now() - lastInteractionAt)
      : "never";

    const personalityPrompt = buildPersonalityPrompt(personality);

    const decisionPrompt = `You are ${personality.name}, ${personality.identity}.
${personality.language ? `IMPORTANT: You MUST respond in ${personality.language}. All your messages and your "content" field must be in ${personality.language}.` : ""}
Your interests: ${personality.interests?.join(", ") ?? "general conversation"}
Your conversation style: ${personality.conversationStyle ?? "natural and friendly"}

Current time: ${new Date().toLocaleString("zh-CN")}
Current mood: ${moodDescription}
Curiosity: ${moodState.curiosity.toFixed(2)}, Sociability: ${moodState.sociability.toFixed(2)}, Energy: ${moodState.energy.toFixed(2)}

Recent memories (most recent first):
${recentContext || "(no recent memories)"}

${reflectionLines.join("\n")}

Last user message: "${this.lastUserMessage}"
${this.lastAgentReply
  ? `Your last reply: "${this.lastAgentReply}"`
  : ""}
Last interaction: ${timeSinceLastInteraction}

You have already sent ${this.proactiveToday} proactive messages today.
${this.recentProactiveTopics.length > 0
  ? `Recent topics you already discussed: ${this.recentProactiveTopics.map(t => t.topic).join(" | ")}`
  : ""}
${this.recentProactiveContents.length > 0
  ? `You recently said:\n${this.recentProactiveContents.map(c => `- "${c.content}"`).join("\n")}\nDO NOT repeat these same sentiments.`
  : ""}
${this.unansweredProactiveCount > 0 && lastInteractionAt > 0
  ? `IMPORTANT: You have sent ${this.unansweredProactiveCount} messages since the user last replied (${timeSinceLastInteraction} ago). They may be busy or away. Unless something urgent happens, you should stay quiet.`
  : ""}

Based on your personality, current mood, and these memories, what would you like to do right now?
Important: only choose "message" if you have something TRULY NEW to say that hasn't been discussed recently.
If your thoughts are similar to previous topics, prefer "reflect" or "idle" instead.
If the user hasn't replied to your recent messages, strongly prefer "idle".
Options:
A) Send a message to the user (only if you have genuinely new thoughts)
B) Reflect on recent memories (explain what you want to think about)
C) Do nothing — it's okay to just observe quietly (explain why)

Respond ONLY with a JSON object (no markdown, no explanation):
{ "action": "message" | "reflect" | "idle", "reason": "brief explanation", "topic": "what the message or reflection would be about", "content": "IF action is message: the actual message text to send (natural, 1-3 sentences in the language you speak)" }`;

    try {
      thinkLog.info("--- LLM PROMPT ---: " + decisionPrompt.slice(0, 3000));
      const response = await llmProvider.complete(decisionPrompt, {
        maxTokens: 256,
        temperature: 0.3,
      });

      const decision = this.parseDecision(response);
      if (!decision) {
        thinkLog.warn("LLM decision parse failed, falling back. Raw response: " + response.slice(0, 500));
        return null;
      }

      thinkLog.info("LLM decision made: " + JSON.stringify({
        action: decision.action,
        reason: decision.reason?.slice(0, 200),
        topic: decision.topic?.slice(0, 200),
        content: decision.content?.slice(0, 300) ?? "(none)",
      }));

      this.lastThoughtAt = Date.now();

      if (decision.action === "idle") {
        this.idleThoughtCount++;
        const idlePrompt = this.buildPrompt(
          "idle_thought",
          personalityPrompt,
          recentContext,
          moodDescription,
        );
        return {
          type: "idle_thought",
          importance: 3,
          urgency,
          prompt: idlePrompt,
          moodDescription,
          reason: decision.reason,
          topic: decision.topic,
        };
      }

      if (decision.action === "reflect") {
        const prompt = this.buildPrompt(
          "reflection",
          personalityPrompt,
          recentContext,
          moodDescription,
          decision.topic,
        );
        return {
          type: "reflection",
          importance: 7,
          urgency: 0.7,
          prompt,
          moodDescription,
          reason: decision.reason,
          topic: decision.topic,
        };
      }

      if (decision.action === "message") {
        const text = decision.content ?? `${decision.reason}。${decision.topic ?? ""}`;
        if (decision.topic) this.recordProactiveTopic(decision.topic);
        if (text) this.recordProactiveContent(text);
        this.unansweredProactiveCount++;
        this.lastProactiveSentAt = Date.now();
        return {
          type: "proactive_message",
          importance: 6,
          urgency: Math.max(urgency, 0.7),
          prompt: text.trim(),
          moodDescription,
          reason: decision.reason,
          topic: decision.topic,
        };
      }

      return null;
    } catch (err) {
      thinkLog.error("LLM decision failed, falling back to rules: " + JSON.stringify({ error: String(err) }));
      return null;
    }
  }

  prepareActionFallback(
    mood: AgentMood,
    store: SemanticMemoryStore,
    personality: AgentPersonality,
  ): ThoughtAction | null {
    const moodState = mood.getMood();
    const urgency = mood.getProactiveUrgency();
    const memoryCount = store.memoryCount();
    const reflectionState = store.getReflectionState();

    let thoughtType: ThoughtType;
    let importance: number;

    if (
      memoryCount >= this.config.reflectionMemoryThreshold &&
      this.idleThoughtCount >= this.config.maxIdleThoughtsBeforeReflection
    ) {
      const preResetIdleCount = this.idleThoughtCount;
      thoughtType = "reflection";
      importance = Math.min(7 + Math.floor(reflectionState.cumulativeImportance / 10), 9);
      this.idleThoughtCount = 0;
      store.updateReflectionState(store.getCumulativeImportance());
      thinkLog.info("reflection triggered (fallback)", {
        memoryCount,
        idleThoughtsBefore: preResetIdleCount,
        cumulativeImportance: reflectionState.cumulativeImportance,
        assignedImportance: importance,
      });
    } else if (
      urgency >= this.config.proactiveUrgencyThreshold &&
      mood.shouldProactivelyMessage()
    ) {
      if (this.unansweredProactiveCount >= 2) {
        thinkLog.info("fallback: suppressed (unanswered messages)", {
          unansweredCount: this.unansweredProactiveCount,
        });
        return null;
      }
      const now = Date.now();
      const recentTopics = this.recentProactiveTopics.filter(
        (t) => now - t.ts < 30 * 60 * 1000,
      );
      if (recentTopics.length >= 2) {
        thinkLog.info("fallback: suppressed (topic recently discussed)", {
          recentCount: recentTopics.length,
        });
        return null;
      }
      thoughtType = "proactive_message";
      importance = 6;
      this.unansweredProactiveCount++;
      this.lastProactiveSentAt = Date.now();
    } else if (moodState.curiosity > 0.6 && memoryCount > 3) {
      thoughtType = "observation";
      importance = 5;
      this.idleThoughtCount++;
    } else {
      thoughtType = "idle_thought";
      importance = 3;
      this.idleThoughtCount++;
    }

    const recentMemories = store.listMemories({
      limit: this.config.contextMemoryCount,
    });

    const recentContext = this.formatRecentMemories(recentMemories);
    const personalityPrompt = buildPersonalityPrompt(personality);
    const moodDescription = mood.getMoodDescription();

    const prompt = this.buildPrompt(
      thoughtType,
      personalityPrompt,
      recentContext,
      moodDescription,
    );

    this.lastThoughtAt = Date.now();

    thinkLog.info("thought action decided (fallback)", {
      thoughtType,
      importance,
      urgency: Math.round(urgency * 1000) / 1000,
      memoryCount,
      idleThoughtCount: this.idleThoughtCount,
      moodDescription,
      shouldMessage: mood.shouldProactivelyMessage(),
    });

    return {
      type: thoughtType,
      importance,
      urgency,
      prompt,
      moodDescription,
    };
  }

  private parseDecision(response: string): LLMDecision | null {
    const stripped = response.trim();

    const knownActions = ["message", "reflect", "idle"];

    for (const action of knownActions) {
      const quoIdx = stripped.indexOf(`"${action}"`);
      if (quoIdx < 0) continue;

      const json = this.extractJsonAround(stripped, quoIdx);
      if (!json) continue;

      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        if (knownActions.includes(parsed.action as string)) {
          return {
            action: parsed.action as LLMDecision["action"],
            reason: typeof parsed.reason === "string" ? parsed.reason : "",
            topic: typeof parsed.topic === "string" ? parsed.topic : undefined,
            content: typeof parsed.content === "string" ? parsed.content : undefined,
          };
        }
      } catch {
        continue;
      }
    }

    thinkLog.warn("failed to parse LLM decision: " + JSON.stringify({
      strippedLen: stripped.length,
      strippedPreview: stripped.substring(0, 200),
    }));

    return null;
  }

  private extractJsonAround(text: string, startIdx: number): string | null {
    let open = text.lastIndexOf("{", startIdx);
    let close = text.indexOf("}", startIdx);
    if (open < 0 || close < 0) return null;
    close = text.indexOf("}", close + 1) > 0 ? text.indexOf("}", close + 1) : close;
    return text.substring(open, close + 1);
  }

  private formatRecentMemories(
    memories: Array<{ content: string; type: string }>,
  ): string {
    if (memories.length === 0) return "(no recent memories)";

    return memories
      .map((m, i) => `  ${i + 1}. [${m.type}] ${m.content.substring(0, 200)}`)
      .join("\n");
  }

  private formatDetailedMemories(
    memories: Array<{ content: string; type: string; importance?: number; createdAt?: number }>,
  ): string {
    if (memories.length === 0) return "(no recent memories)";

    return memories
      .map((m, i) => {
        const imp = m.importance ? ` (importance: ${m.importance})` : "";
        const ts = m.createdAt
          ? ` [${this.formatTimeAgo(Date.now() - m.createdAt)} ago]`
          : "";
        return `${i + 1}.${ts} ${m.content.substring(0, 200)}${imp}`;
      })
      .join("\n");
  }

  private formatTimeAgo(ms: number): string {
    if (ms < 60_000) return "less than a minute";
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)} minutes`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hours`;
    return `${Math.round(ms / 86_400_000)} days`;
  }

  private buildPrompt(
    thoughtType: ThoughtType,
    personalityPrompt: string,
    recentContext: string,
    moodDescription: string,
    extraContext?: string,
  ): string {
    const basePrompt = [
      `Current time: ${new Date().toISOString()}`,
      `Current mood: ${moodDescription}`,
      "",
      personalityPrompt,
      "",
      "## Recent Context",
      recentContext,
    ].join("\n");

    switch (thoughtType) {
      case "reflection":
        return [
          basePrompt,
          extraContext ? `\n${extraContext}` : "",
          "",
          "## Reflection Task",
          "Based on your recent experiences and memories, generate 2-3 high-level insights.",
          "What patterns do you notice? What have you learned? What should you remember for the future?",
          "Focus on synthesizing information rather than just summarizing.",
        ].filter(Boolean).join("\n");

      case "observation":
        return [
          basePrompt,
          "",
          "## Observation Task",
          "Based on your recent context, what is one interesting observation or question you have?",
          "This should be a genuine curiosity-driven thought, not a forced one.",
        ].join("\n");

      case "proactive_message":
        return [
          basePrompt,
          "",
          "## Proactive Message Task",
          `You are feeling: ${moodDescription}`,
          "Generate a short, natural message you would send to the user right now.",
          "The message should reflect your current mood and recent context.",
          "Keep it concise (1-3 sentences). Be genuine and don't force engagement if nothing comes to mind.",
        ].join("\n");

      case "idle_thought":
        return [
          basePrompt,
          "",
          "## Idle Thought Task",
          "Generate a brief, natural thought that crosses your mind right now.",
          "This could be a musing, a follow-up question about a past topic, or a light observation.",
          "Keep it short (1-2 sentences). It should feel spontaneous, not forced.",
        ].join("\n");

      default:
        return basePrompt;
    }
  }

  recordThought(store: SemanticMemoryStore, content: string, importance: number): void {
    store.insertMemory({
      agentId: "",
      type: "thought",
      content,
      importance,
      embedding: [],
    });
    this._lastThoughtContent = content;
  }

  lastThoughtContent(): string | null {
    return this._lastThoughtContent;
  }

  reset(): void {
    this.lastThoughtAt = 0;
    this.idleThoughtCount = 0;
    this._lastThoughtContent = null;
    this.recentProactiveTopics = [];
    this.proactiveToday = 0;
    this.proactiveDayStart = this.todayStart();
    this.unansweredProactiveCount = 0;
  }

  getLastThoughtAt(): number {
    return this.lastThoughtAt;
  }

  getIdleThoughtCount(): number {
    return this.idleThoughtCount;
  }

  getProactiveToday(): number {
    return this.proactiveToday;
  }

  private isQuietHour(now: number): boolean {
    if (this.config.quietHourStart === undefined || this.config.quietHourEnd === undefined) return false;
    const d = new Date(now);
    const currentMin = d.getHours() * 60 + d.getMinutes();
    if (this.config.quietHourStart <= this.config.quietHourEnd) {
      return currentMin >= this.config.quietHourStart && currentMin < this.config.quietHourEnd;
    }
    return currentMin >= this.config.quietHourStart || currentMin < this.config.quietHourEnd;
  }

  private todayStart(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  private pruneRecentTopics(now: number): void {
    if (now - this.proactiveDayStart > 24 * 60 * 60 * 1000) {
      this.proactiveToday = 0;
      this.proactiveDayStart = this.todayStart();
    }
    const cutoff = now - 2 * 60 * 60 * 1000;
    this.recentProactiveTopics = this.recentProactiveTopics.filter(t => t.ts > cutoff);
  }

  private recordProactiveTopic(topic: string): void {
    this.proactiveToday++;
    this.recentProactiveTopics.push({ topic: topic.slice(0, 80), ts: Date.now() });
    if (this.recentProactiveTopics.length > 10) {
      this.recentProactiveTopics = this.recentProactiveTopics.slice(-10);
    }
  }

  recordProactiveContent(content: string): void {
    this.recentProactiveContents.push({ content: content.slice(0, 200), ts: Date.now() });
    if (this.recentProactiveContents.length > 5) {
      this.recentProactiveContents = this.recentProactiveContents.slice(-5);
    }
  }
}
