import type { MindLLMProvider } from "./llm-provider.js";
import type { AgentPersonality } from "../agents/personality.js";
import type { SemanticMemoryStore } from "./store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import path from "node:path";
import fs from "node:fs";

const planLog = createSubsystemLogger("agent-mind").child("plan");

export interface AgentPlan {
  dailyGoals: string[];
  longTermGoals: string[];
  updatedAt: number;
  generatedBy: "llm" | "default";
}

const DEFAULT_PLAN: AgentPlan = {
  dailyGoals: [],
  longTermGoals: [
    "记住用户的重要信息和偏好",
    "在合适的时机主动关心用户",
    "从对话中学习，提供更好的陪伴",
  ],
  updatedAt: Date.now(),
  generatedBy: "default",
};

export class Planner {
  private agentId: string;
  private personality: AgentPersonality;
  private planPath: string;
  private plan: AgentPlan;

  constructor(agentId: string, personality: AgentPersonality) {
    this.agentId = agentId;
    this.personality = personality;
    const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
    const dir = path.join(base, ".openclaw", "mind");
    this.planPath = path.join(dir, `${agentId}-plan.json`);
    this.plan = this.loadPlan() ?? { ...DEFAULT_PLAN };
  }

  getPlan(): AgentPlan {
    return { ...this.plan };
  }

  needsDailyUpdate(): boolean {
    const now = Date.now();
    const planDate = new Date(this.plan.updatedAt);
    const today = new Date(now);
    return (
      planDate.getDate() !== today.getDate() ||
      planDate.getMonth() !== today.getMonth() ||
      planDate.getFullYear() !== today.getFullYear()
    );
  }

  async updateDailyGoals(
    store: SemanticMemoryStore,
    llmProvider?: MindLLMProvider,
  ): Promise<void> {
    if (!llmProvider?.isAvailable()) {
      this.plan.dailyGoals = [
        `作为${this.personality.name}，今天也要好好陪伴用户`,
        "关注用户的最新动态",
      ];
      this.plan.updatedAt = Date.now();
      this.plan.generatedBy = "default";
      this.savePlan();
      return;
    }

    const recentMemories = store.listMemories({ limit: 10 });
    const reflections = store.listMemories({ type: "reflection", limit: 3 });

    const memoryLines = recentMemories.map((m, i) =>
      `${i + 1}. ${m.content.substring(0, 150)}`
    );

    const reflectionLines = reflections.map((r) =>
      `- ${r.content}`
    );

    const prompt = `You are ${this.personality.name}, ${this.personality.identity}.
Your interests: ${this.personality.interests?.join(", ") ?? "helping the user"}
Your long-term goals: ${this.plan.longTermGoals.join(", ")}

Recent memories:
${memoryLines.join("\n") || "(none)"}

Recent reflections:
${reflectionLines.join("\n") || "(none)"}

Based on the above, generate 2-3 daily goals for today. These should be specific, actionable things the agent should focus on when interacting with the user.

Respond ONLY with a JSON array of strings:
["goal 1", "goal 2", "goal 3"]`;

    try {
      const response = await llmProvider.complete(prompt, { maxTokens: 256, temperature: 0.5 });
      const goals = this.parseGoalsFromResponse(response);
      if (goals.length > 0) {
        this.plan.dailyGoals = goals;
        this.plan.updatedAt = Date.now();
        this.plan.generatedBy = "llm";
        this.savePlan();
        planLog.info("daily goals updated via LLM", { goalCount: goals.length });
      }
    } catch (err) {
      planLog.error("LLM daily plan update failed", { error: String(err) });
    }
  }

  async updateLongTermGoals(
    store: SemanticMemoryStore,
    llmProvider?: MindLLMProvider,
  ): Promise<void> {
    if (!llmProvider?.isAvailable()) return;

    const reflections = store.listMemories({ type: "reflection", limit: 5 });
    if (reflections.length === 0) return;

    const reflectionLines = reflections.map((r) => `- ${r.content}`);

    const prompt = `You are ${this.personality.name}, ${this.personality.identity}.
Current long-term goals:
${this.plan.longTermGoals.map((g) => `- ${g}`).join("\n")}

Recent high-level insights about the user:
${reflectionLines.join("\n")}

Based on these insights, should any long-term goals be added or adjusted?
Respond ONLY with a JSON object:
{ "goals": ["updated goal 1", "updated goal 2", ...] }
Keep a maximum of 5 goals. If nothing needs to change, return the current goals.`;

    try {
      const response = await llmProvider.completeJSON<{ goals: string[] }>(prompt, '{ "goals": ["string"] }');
      if (response.goals && response.goals.length > 0) {
        this.plan.longTermGoals = response.goals.slice(0, 5);
        this.plan.updatedAt = Date.now();
        this.plan.generatedBy = "llm";
        this.savePlan();
        planLog.info("long-term goals updated via LLM", { goalCount: response.goals.length });
      }
    } catch (err) {
      planLog.error("LLM long-term plan update failed", { error: String(err) });
    }
  }

  onImportantEvent(_importance: number): void {
    // significant events (>7) may trigger plan review in tick()
  }

  formatPlanForPrompt(): string {
    const lines: string[] = [];
    if (this.plan.dailyGoals.length > 0) {
      lines.push("Today's goals:");
      for (const goal of this.plan.dailyGoals) {
        lines.push(`- ${goal}`);
      }
      lines.push("");
    }
    if (this.plan.longTermGoals.length > 0) {
      lines.push("Long-term goals:");
      for (const goal of this.plan.longTermGoals) {
        lines.push(`- ${goal}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  private parseGoalsFromResponse(response: string): string[] {
    try {
      const parsed = JSON.parse(response);
      if (Array.isArray(parsed)) return parsed.filter((g): g is string => typeof g === "string" && g.length > 3);
    } catch {
      // try extracting from formatted text
    }
    return response
      .split("\n")
      .map((line) => line.replace(/^[\d.\-*\s]+/, "").trim())
      .filter((line) => line.length > 5)
      .slice(0, 3);
  }

  private loadPlan(): AgentPlan | null {
    try {
      if (!fs.existsSync(this.planPath)) return null;
      const data = JSON.parse(fs.readFileSync(this.planPath, "utf-8"));
      if (data.dailyGoals && data.longTermGoals) return data as AgentPlan;
      return null;
    } catch {
      return null;
    }
  }

  private savePlan(): void {
    try {
      const dir = path.dirname(this.planPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.planPath, JSON.stringify(this.plan, null, 2), "utf-8");
    } catch {
      // best-effort
    }
  }
}
