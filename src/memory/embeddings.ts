export interface EmbeddingProvider {
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

import OpenAI from "openai";
import { createSubsystemLogger } from "../logging/subsystem.js";

const embLog = createSubsystemLogger("agent-mind").child("embeddings");

export class SimpleEmbeddingProvider implements EmbeddingProvider {
  private dimensions: number;
  private cache: Map<string, number[]>;

  constructor(dimensions = 384) {
    this.dimensions = dimensions;
    this.cache = new Map();
  }

  private wordHash(word: string): number {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
    }
    hash = hash + (hash << 13);
    hash = hash ^ (hash >> 7);
    return ((Math.abs(hash) % this.dimensions) + this.dimensions) % this.dimensions;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0);
  }

  private textToVector(text: string): number[] {
    const cached = this.cache.get(text);
    if (cached) return cached;

    const words = this.tokenize(text);
    if (words.length === 0) {
      const zero: number[] = Array.from({ length: this.dimensions }, () => 0);
      this.cache.set(text, zero);
      return zero;
    }

    const vec: number[] = Array.from({ length: this.dimensions }, () => 0);
    const seen = new Set<string>();

    for (const word of words) {
      if (seen.has(word)) continue;
      seen.add(word);

      const idx = this.wordHash(word);
      vec[idx] += 1;
    }

    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] /= norm;
      }
    }

    this.cache.set(text, vec);
    return vec;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.textToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.textToVector(text));
  }
}

export class EmbeddingCache {
  private cache: Map<string, number[]>;
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
  }

  private cacheKey(provider: string, model: string, text: string): string {
    return `${provider}:${model}:${this.hashText(text)}`;
  }

  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return String(Math.abs(hash));
  }

  get(provider: string, model: string, text: string): number[] | undefined {
    return this.cache.get(this.cacheKey(provider, model, text));
  }

  set(provider: string, model: string, text: string, embedding: number[]): void {
    if (this.cache.size >= this.maxEntries) {
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }
    this.cache.set(this.cacheKey(provider, model, text), embedding);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI | null = null;
  private model: string;
  private dimensions: number;
  private cache: EmbeddingCache;

  constructor(options: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    baseUrl?: string;
  }) {
    this.model = options.model ?? "text-embedding-3-small";
    this.dimensions = options.dimensions ?? 384;
    this.cache = new EmbeddingCache(2000);
    try {
      this.client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        timeout: 15_000,
        maxRetries: 1,
      });
      embLog.info("OpenAI embedding provider initialized", {
        model: this.model,
        dimensions: this.dimensions,
      });
    } catch (err) {
      embLog.error("OpenAI embedding provider init failed", { error: String(err) });
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedBatch([text]).then((results) => results[0] ?? []);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      embLog.warn("OpenAI client not available, using fallback");
      const fallback = new SimpleEmbeddingProvider(this.dimensions);
      return fallback.embedBatch(texts);
    }

    const uncached: { text: string; idx: number }[] = [];
    const results: (number[] | null)[] = texts.map((text, idx) => {
      const cached = this.cache.get("openai", this.model, text);
      if (cached) return cached;
      uncached.push({ text, idx });
      return null;
    });

    if (uncached.length === 0) return results as number[][];

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: uncached.map((u) => u.text),
        dimensions: this.dimensions,
      });

      for (const item of response.data) {
        const idx = uncached[item.index]?.idx;
        if (idx === undefined) continue;
        const embedding = item.embedding;
        this.cache.set("openai", this.model, texts[idx], embedding);
        results[idx] = embedding;
      }
    } catch (err) {
      embLog.error("OpenAI embedding batch failed, using fallback", { error: String(err), batchSize: uncached.length });
      const fallback = new SimpleEmbeddingProvider(this.dimensions);
      const fallbackResults = await fallback.embedBatch(uncached.map((u) => u.text));
      for (let i = 0; i < fallbackResults.length; i++) {
        results[uncached[i].idx] = fallbackResults[i];
      }
    }

    return results.map((r) => r ?? []);
  }
}