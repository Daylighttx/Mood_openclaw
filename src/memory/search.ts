import type { SemanticMemory } from "./types.js";
import type { SemanticMemoryStore } from "./store.js";
import type { EmbeddingProvider } from "./embeddings.js";

export interface MemorySearchOptions {
  query: string;
  limit?: number;
  type?: SemanticMemory["type"];
  minScore?: number;
  participantFilter?: string[];
}

export interface MemorySearchResult {
  memory: SemanticMemory;
  relevanceScore: number;
  recencyScore: number;
  importanceScore: number;
  score: number;
}

export class MemorySearcher {
  private store: SemanticMemoryStore;
  private embedder: EmbeddingProvider;

  constructor(store: SemanticMemoryStore, embedder: EmbeddingProvider) {
    this.store = store;
    this.embedder = embedder;
  }

  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const queryEmbedding = await this.embedder.embedQuery(options.query);
    const results = this.store.searchMemories(queryEmbedding, {
      limit: options.limit ?? 5,
      type: options.type,
      minScore: options.minScore ?? 0,
    });

    let filtered = results.map((r) => ({
      memory: r.memory,
      relevanceScore: r.relevanceScore,
      recencyScore: r.recencyScore,
      importanceScore: r.importanceScore,
      score: r.score,
    }));

    if (options.participantFilter && options.participantFilter.length > 0) {
      filtered = filtered
        .map((result) => {
          const memoryParticipants = result.memory.participants ?? [];
          const overlap = options.participantFilter!.filter((p) =>
            memoryParticipants.includes(p),
          ).length;
          const participantBonus = overlap > 0 ? 0.15 : 0;
          return {
            ...result,
            score: result.score + participantBonus,
          };
        })
        .sort((a, b) => b.score - a.score);
    }

    return filtered;
  }

  async searchByTopic(topic: string, options?: { limit?: number; minScore?: number }): Promise<MemorySearchResult[]> {
    return this.search({
      query: topic,
      limit: options?.limit ?? 3,
      minScore: options?.minScore,
    });
  }

  async searchAboutPerson(
    personName: string,
    options?: { limit?: number },
  ): Promise<MemorySearchResult[]> {
    return this.search({
      query: `What do I know about ${personName}?`,
      limit: options?.limit ?? 3,
      participantFilter: [personName],
    });
  }
}

export function formatMemoriesForPrompt(results: MemorySearchResult[]): string {
  if (results.length === 0) return "";

  return results
    .map(
      (r, i) =>
        `${i + 1}. [importance: ${r.memory.importance}/9] ${r.memory.content}`,
    )
    .join("\n");
}