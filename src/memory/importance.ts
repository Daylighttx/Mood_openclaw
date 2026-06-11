import type { MindLLMProvider } from "./llm-provider.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const impLog = createSubsystemLogger("agent-mind").child("importance");

const SHORT_CONTENT_THRESHOLD = 10;

export interface ImportanceScorer {
  scoreImportance(params: {
    content: string;
    type: "conversation" | "reflection" | "thought";
    participants?: string[];
  }): Promise<number>;
}

export function createRuleBasedScorer(): ImportanceScorer {
  return {
    async scoreImportance(params) {
      const { content, type, participants } = params;
      let score = 5;

      if (type === "reflection") {
        score += 2;
      }

      if (participants && participants.length > 0) {
        score += Math.min(participants.length * 0.5, 2);
      }

      const keyPhrases: Array<{ phrase: string; weight: number }> = [
  { phrase: "remember", weight: 1 },
  { phrase: "important", weight: 2 },
  { phrase: "urgent", weight: 3 },
  { phrase: "promise", weight: 2 },
  { phrase: "deadline", weight: 2.5 },
  { phrase: "secret", weight: 2 },
  { phrase: "love", weight: 1.5 },
  { phrase: "hate", weight: 1.5 },
  { phrase: "never forget", weight: 2.5 },
  { phrase: "always", weight: 1 },
  { phrase: "change", weight: 1.5 },
  { phrase: "goal", weight: 1.5 },
  { phrase: "plan", weight: 1 },
  { phrase: "question", weight: 0.5 },
  { phrase: "记住", weight: 1 },
  { phrase: "重要", weight: 2 },
  { phrase: "紧急", weight: 3 },
  { phrase: "承诺", weight: 2 },
  { phrase: "截止", weight: 2.5 },
  { phrase: "秘密", weight: 2 },
  { phrase: "爱", weight: 1.5 },
  { phrase: "讨厌", weight: 1.5 },
  { phrase: "永远", weight: 1 },
  { phrase: "改变", weight: 1.5 },
  { phrase: "目标", weight: 1.5 },
  { phrase: "计划", weight: 1 },
  { phrase: "问题", weight: 0.5 },
  { phrase: "紧张", weight: 1.5 },
  { phrase: "开心", weight: 1 },
  { phrase: "担心", weight: 1.5 },
  { phrase: "汇报", weight: 1.5 },
  { phrase: "升职", weight: 2 },
  { phrase: "压力", weight: 2 },
];

      const lowerContent = content.toLowerCase();
      for (const { phrase, weight } of keyPhrases) {
        if (lowerContent.includes(phrase)) {
          score += weight;
        }
      }

      const length = content.length;
      if (length > 500) score += 0.5;
      if (length > 1000) score += 0.5;

      return Math.max(0, Math.min(9, Math.round(score)));
    },
  };
}

export function createLLMScorer(provider: MindLLMProvider): ImportanceScorer {
  const ruleScorer = createRuleBasedScorer();

  return {
    async scoreImportance(params) {
      if (!provider.isAvailable()) {
        return ruleScorer.scoreImportance(params);
      }

      if (params.content.trim().length <= SHORT_CONTENT_THRESHOLD) {
        return ruleScorer.scoreImportance(params);
      }

      const prompt = `On the scale of 1 to 9, where 1 is purely mundane (e.g. routine greeting, checking time) and 9 is extremely poignant (e.g. a breakup, major life decision), rate the likely poignancy of the following piece of memory.

Type: ${params.type}
${params.participants?.length ? `Participants: ${params.participants.join(", ")}` : ""}
Memory: "${params.content}"

Rating:`;

      try {
        const response = await provider.complete(prompt, {
          maxTokens: 16,
          temperature: 0.1,
        });

        const digits = response.replace(/[^0-9]/g, "");
        if (digits.length > 0) {
          const score = parseInt(digits[0], 10);
          if (score >= 1 && score <= 9) {
            return score;
          }
        }

        impLog.warn("LLM importance score parse failed, falling back: " + JSON.stringify({
          responsePreview: response.slice(0, 200),
          responseLen: response.length,
        }));
        return ruleScorer.scoreImportance(params);
      } catch (err) {
        impLog.error("LLM importance scoring failed, falling back", {
          error: String(err),
        });
        return ruleScorer.scoreImportance(params);
      }
    },
  };
}

export function createMockScorer(fixedScore = 5): ImportanceScorer {
  return {
    async scoreImportance() {
      return fixedScore;
    },
  };
}

export class ImportanceEvaluator {
  private scorer: ImportanceScorer;
  private cache: Map<string, number>;

  constructor(scorer: ImportanceScorer) {
    this.scorer = scorer;
    this.cache = new Map();
  }

  private cacheKey(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return String(Math.abs(hash));
  }

  async evaluate(params: {
    content: string;
    type: "conversation" | "reflection" | "thought";
    participants?: string[];
  }): Promise<number> {
    const key = this.cacheKey(params.content);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const score = await this.scorer.scoreImportance(params);
    this.cache.set(key, score);
    return score;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
