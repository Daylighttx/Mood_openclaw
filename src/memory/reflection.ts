import type { SemanticMemoryStore } from "./store.js";
import type { ImportanceScorer } from "./importance.js";
import type { ReflectionResult } from "./types.js";
import type { MindLLMProvider } from "./llm-provider.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const refLog = createSubsystemLogger("agent-mind").child("reflection");

export interface ReflectionConfig {
  importanceThreshold: number;
  maxMemoriesForReflection: number;
}

const DEFAULT_CONFIG: ReflectionConfig = {
  importanceThreshold: 100,
  maxMemoriesForReflection: 100,
};

export interface ReflectionGenerator {
  generateReflections(
    memories: Array<{ content: string; importance: number; createdAt?: number }>,
  ): Promise<ReflectionResult>;
}

export function createTemplateReflectionGenerator(): ReflectionGenerator {
  return {
    async generateReflections(memories) {
      const totalImportance = memories.reduce((sum, m) => sum + m.importance, 0);
      const avgImportance =
        memories.length > 0 ? totalImportance / memories.length : 0;

      const topics = extractCommonTopics(memories.map((m) => m.content));

      const insights: string[] = [];

      if (totalImportance > 100) {
        insights.push(
          `The total importance of recent memories suggests significant events have occurred (cumulative importance: ${totalImportance.toFixed(1)}).`,
        );
      }

      if (topics.length > 0) {
        const topTopics = topics.slice(0, 5).join(", ");
        insights.push(
          `Common themes in recent interactions include: ${topTopics}. This may indicate areas of focus for the user.`,
        );
      }

      if (memories.length >= 20) {
        insights.push(
          `There have been ${memories.length} recent interactions, suggesting a high level of engagement.`,
        );
      }

      if (insights.length === 0) {
        insights.push(
          `Regular interactions continue. No significant patterns detected yet.`,
        );
      }

      const importance = Math.min(9, Math.round(avgImportance + 1));

      return {
        memories: [],
        insights,
        importance,
      };
    },
  };
}

export function createLLMReflectionGenerator(provider: MindLLMProvider): ReflectionGenerator {
  return {
    async generateReflections(memories) {
      if (!provider.isAvailable()) {
        refLog.info("LLM unavailable, falling back to template reflection");
        return createTemplateReflectionGenerator().generateReflections(memories);
      }

      const memoryLines = memories.slice(0, 30).map((m, i) => {
        const ts = m.createdAt
          ? new Date(m.createdAt).toLocaleString("zh-CN")
          : "recent";
        return `${i + 1}. [${ts}] ${m.content} (importance: ${m.importance})`;
      });

      const prompt = `Statements about the agent's recent experiences:
${memoryLines.join("\n")}

What 3 high-level insights can you infer from the above statements?
Only infer from the given statements. Do not fabricate information.
Respond in the same language as the statements (Chinese if Chinese, English if English).
Format each insight as a separate line starting with "- ".`;

      try {
        const response = await provider.complete(prompt, {
          maxTokens: 512,
          temperature: 0.5,
        });

        const insights = response
          .split("\n")
          .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
          .filter((line) => line.length > 10)
          .slice(0, 5);

        if (insights.length === 0) {
          refLog.warn("LLM reflection returned no valid insights, falling back");
          return createTemplateReflectionGenerator().generateReflections(memories);
        }

        const totalImportance = memories.reduce((sum, m) => sum + m.importance, 0);
        const avgImportance =
          memories.length > 0 ? totalImportance / memories.length : 0;
        const importance = Math.min(9, Math.round(avgImportance + 1));

        refLog.info("LLM reflection generated", {
          insightCount: insights.length,
          avgImportance,
        });

        return { memories: [], insights, importance };
      } catch (err) {
        refLog.error("LLM reflection failed, falling back to template", {
          error: String(err),
        });
        return createTemplateReflectionGenerator().generateReflections(memories);
      }
    },
  };
}

function extractCommonTopics(contents: string[]): string[] {
  const allWords = contents
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 5);

  const stopWords = new Set([
    "really", "always", "never", "something", "probably", "actually", "because",
    "should", "would", "could", "maybe", "people", "things", "about", "their",
    "there", "which", "going", "think", "other", "after", "first", "still",
  ]);

  const wordFreq = new Map<string, number>();
  for (const word of allWords) {
    if (stopWords.has(word)) continue;
    wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
  }

  return [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

export class ReflectionPipeline {
  private store: SemanticMemoryStore;
  private generator: ReflectionGenerator;
  private importanceScorer: ImportanceScorer;
  private config: ReflectionConfig;
  private agentId: string;

  constructor(
    store: SemanticMemoryStore,
    generator: ReflectionGenerator,
    importanceScorer: ImportanceScorer,
    agentId: string,
    config?: Partial<ReflectionConfig>,
  ) {
    this.store = store;
    this.generator = generator;
    this.importanceScorer = importanceScorer;
    this.agentId = agentId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async shouldReflect(): Promise<boolean> {
    const state = this.store.getReflectionState();
    const currentImportance = this.store.getCumulativeImportance();
    const newImportance = currentImportance - state.cumulativeImportance;
    if (newImportance >= this.config.importanceThreshold) return true;
    return false;
  }

  async reflect(): Promise<ReflectionResult | null> {
    const shouldRun = await this.shouldReflect();
    if (!shouldRun) return null;

    const recentMemories = this.store.listMemories({
      limit: this.config.maxMemoriesForReflection,
    });

    if (recentMemories.length === 0) return null;

    const memoryInputs = recentMemories.map((m) => ({
      content: m.content,
      importance: m.importance,
      createdAt: m.createdAt,
    }));

    const result = await this.generator.generateReflections(memoryInputs);

    const currentImportance = this.store.getCumulativeImportance();
    this.store.updateReflectionState(currentImportance);

    for (const insight of result.insights) {
      const importance = await this.importanceScorer.scoreImportance({
        content: insight,
        type: "reflection",
      });

      this.store.insertMemory({
        agentId: this.agentId,
        type: "reflection",
        content: insight,
        importance,
        embedding: [],
        keywords: ["reflection"],
        metadata: {
          generatedAt: Date.now(),
          sourceMemoryCount: recentMemories.length,
        },
      });
    }

    return result;
  }

  async forceReflect(): Promise<ReflectionResult> {
    const recentMemories = this.store.listMemories({
      limit: this.config.maxMemoriesForReflection,
    });

    const memoryInputs = recentMemories.map((m) => ({
      content: m.content,
      importance: m.importance,
      createdAt: m.createdAt,
    }));

    const result = await this.generator.generateReflections(memoryInputs);

    const currentImportance = this.store.getCumulativeImportance();
    this.store.updateReflectionState(currentImportance);

    for (const insight of result.insights) {
      const importance = await this.importanceScorer.scoreImportance({
        content: insight,
        type: "reflection",
      });

      this.store.insertMemory({
        agentId: this.agentId,
        type: "reflection",
        content: insight,
        importance,
        embedding: [],
        keywords: ["reflection", "forced"],
        metadata: {
          generatedAt: Date.now(),
          sourceMemoryCount: recentMemories.length,
        },
      });
    }

    return result;
  }
}
