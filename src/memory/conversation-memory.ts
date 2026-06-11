import type { SemanticMemoryStore } from "./store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { ImportanceScorer } from "./importance.js";
import type { ConversationSummary } from "./types.js";

export interface ConversationMemoryInput {
  agentId: string;
  participants: string[];
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  startedAt: number;
  endedAt: number;
}

function generateSummary(input: ConversationMemoryInput): ConversationSummary {
  const messageCount = input.messages.length;
  const allText = input.messages.map((m) => m.content).join(" ");

  let summary = "";
  if (messageCount <= 3) {
    summary = input.messages.map((m) => `${m.role}: ${m.content}`).join(" | ");
  } else {
    const first = input.messages.slice(0, 2);
    const last = input.messages.slice(-2);
    summary = [
      ...first.map((m) => `${m.role}: ${m.content}`),
      `...(${messageCount - 4} more messages)...`,
      ...last.map((m) => `${m.role}: ${m.content}`),
    ].join(" | ");
  }

  const words = allText.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const wordFreq = new Map<string, number>();
  for (const word of words) {
    wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
  }
  const keywords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  return {
    agentId: input.agentId,
    participants: input.participants,
    summary: summary.substring(0, 2000),
    keywords,
    importance: 5,
    messageCount,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
}

export class ConversationMemoryPipeline {
  private store: SemanticMemoryStore;
  private embedder: EmbeddingProvider;
  private importanceScorer: ImportanceScorer;

  constructor(
    store: SemanticMemoryStore,
    embedder: EmbeddingProvider,
    importanceScorer: ImportanceScorer,
  ) {
    this.store = store;
    this.embedder = embedder;
    this.importanceScorer = importanceScorer;
  }

  async rememberConversation(input: ConversationMemoryInput): Promise<string[]> {
    const summary = generateSummary(input);

    const importance = await this.importanceScorer.scoreImportance({
      content: summary.summary,
      type: "conversation",
      participants: summary.participants,
    });

    const embedding = await this.embedder.embedQuery(summary.summary);

    const memory = this.store.insertMemory({
      agentId: input.agentId,
      type: "conversation",
      content: summary.summary,
      importance,
      embedding,
      participants: summary.participants,
      keywords: summary.keywords,
      metadata: {
        messageCount: summary.messageCount,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
      },
    });

    return [memory.id];
  }

  async rememberReflection(insight: string, importance: number, embedding: number[]): Promise<string> {
    const memory = this.store.insertMemory({
      agentId: this.store["agentId"] ? (this.store as unknown as { agentId: string }).agentId : "default",
      type: "reflection",
      content: insight,
      importance,
      embedding,
    });

    return memory.id;
  }
}