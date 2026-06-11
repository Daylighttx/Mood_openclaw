import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { SemanticMemory } from "./types.js";

export interface MemoryStoreOptions {
  dbPath: string;
  agentId: string;
  decayHalfLifeMs?: number;
}

export class SemanticMemoryStore {
  private db: DatabaseSync;
  private agentId: string;
  private decayHalfLifeMs: number;

  constructor(options: MemoryStoreOptions) {
    this.db = new DatabaseSync(options.dbPath);
    this.agentId = options.agentId;
    this.decayHalfLifeMs = options.decayHalfLifeMs ?? 30 * 24 * 60 * 60 * 1000;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('conversation', 'reflection', 'thought')),
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 5.0,
        embedding TEXT NOT NULL DEFAULT '[]',
        participants TEXT,
        keywords TEXT,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON semantic_memories(agent_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_type ON semantic_memories(agent_id, type)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON semantic_memories(agent_id, importance DESC)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memory_reflections (
        agent_id TEXT NOT NULL,
        last_reflection_at INTEGER NOT NULL,
        cumulative_importance REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id)
      )
    `);
  }

  private rowToMemory(row: Record<string, unknown>): SemanticMemory {
    const embeddingRaw = String(row.embedding ?? "[]");
    let embedding: number[] = [];
    try {
      embedding = JSON.parse(embeddingRaw) as number[];
    } catch {
      embedding = [];
    }

    const participantsRaw = String(row.participants ?? "");
    let participants: string[] | undefined;
    try {
      if (participantsRaw) participants = JSON.parse(participantsRaw) as string[];
    } catch {
      participants = undefined;
    }

    const keywordsRaw = String(row.keywords ?? "");
    let keywords: string[] | undefined;
    try {
      if (keywordsRaw) keywords = JSON.parse(keywordsRaw) as string[];
    } catch {
      keywords = undefined;
    }

    const metadataRaw = String(row.metadata ?? "");
    let metadata: Record<string, unknown> | undefined;
    try {
      if (metadataRaw) metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }

    return {
      id: String(row.id),
      agentId: String(row.agent_id),
      type: row.type as SemanticMemory["type"],
      content: String(row.content),
      importance: Number(row.importance),
      embedding,
      participants,
      keywords,
      createdAt: Number(row.created_at),
      lastAccessedAt: Number(row.last_accessed_at),
      accessCount: Number(row.access_count),
      metadata,
    };
  }

  insertMemory(memory: Omit<SemanticMemory, "id" | "createdAt" | "lastAccessedAt" | "accessCount">): SemanticMemory {
    const id = randomUUID();
    const now = Date.now();
    const embeddingJson = JSON.stringify(memory.embedding);
    const participantsJson = memory.participants ? JSON.stringify(memory.participants) : null;
    const keywordsJson = memory.keywords ? JSON.stringify(memory.keywords) : null;
    const metadataJson = memory.metadata ? JSON.stringify(memory.metadata) : null;

    this.db
      .prepare(
        `INSERT INTO semantic_memories (id, agent_id, type, content, importance, embedding, participants, keywords, created_at, last_accessed_at, access_count, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.agentId,
        memory.type,
        memory.content,
        memory.importance,
        embeddingJson,
        participantsJson,
        keywordsJson,
        now,
        now,
        0,
        metadataJson,
      );

    return {
      ...memory,
      id,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };
  }

  getMemory(id: string): SemanticMemory | null {
    const row = this.db
      .prepare("SELECT * FROM semantic_memories WHERE id = ? AND agent_id = ?")
      .get(id, this.agentId) as Record<string, unknown> | undefined;

    if (!row) return null;

    this.db
      .prepare(
        "UPDATE semantic_memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
      )
      .run(Date.now(), id);

    return this.rowToMemory(row);
  }

  listMemories(options?: {
    type?: SemanticMemory["type"];
    limit?: number;
    offset?: number;
  }): SemanticMemory[] {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let query = "SELECT * FROM semantic_memories WHERE agent_id = ?";
    const params: unknown[] = [this.agentId];

    if (options?.type) {
      query += " AND type = ?";
      params.push(options.type);
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    const rows = (stmt.all as (...args: unknown[]) => unknown[])(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    const len = Math.min(a.length, b.length);

    for (let i = 0; i < len; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private temporalDecay(createdAt: number, now: number): number {
    const ageMs = now - createdAt;
    return Math.exp(-Math.log(2) * (ageMs / this.decayHalfLifeMs));
  }

  searchMemories(
    queryEmbedding: number[],
    options?: {
      limit?: number;
      type?: SemanticMemory["type"];
      minScore?: number;
    },
  ): Array<{ memory: SemanticMemory; relevanceScore: number; recencyScore: number; importanceScore: number; score: number }> {
    const limit = options?.limit ?? 5;
    const minScore = options?.minScore ?? 0;
    const now = Date.now();

    const memories = this.listMemories({ type: options?.type, limit: 500 });

    const scored = memories.map((memory) => {
      const relevanceScore = this.cosineSimilarity(queryEmbedding, memory.embedding);
      const recencyScore = this.temporalDecay(memory.createdAt, now);
      const importanceScore = Math.min(memory.importance / 10, 1);

      const score = relevanceScore * 0.6 + recencyScore * 0.25 + importanceScore * 0.15;

      return {
        memory,
        relevanceScore,
        recencyScore,
        importanceScore,
        score,
      };
    });

    return scored
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getCumulativeImportance(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(importance), 0) as total FROM semantic_memories WHERE agent_id = ?")
      .get(this.agentId) as Record<string, unknown> | undefined;
    return row ? Number(row.total) : 0;
  }

  getReflectionState(): { lastReflectionAt: number; cumulativeImportance: number } {
    const row = this.db
      .prepare("SELECT * FROM semantic_memory_reflections WHERE agent_id = ?")
      .get(this.agentId) as Record<string, unknown> | undefined;

    if (!row) {
      return { lastReflectionAt: 0, cumulativeImportance: 0 };
    }

    return {
      lastReflectionAt: Number(row.last_reflection_at),
      cumulativeImportance: Number(row.cumulative_importance),
    };
  }

  updateReflectionState(cumulativeImportance: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO semantic_memory_reflections (agent_id, last_reflection_at, cumulative_importance)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET last_reflection_at = ?, cumulative_importance = ?`,
      )
      .run(this.agentId, now, cumulativeImportance, now, cumulativeImportance);
  }

  deleteMemory(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM semantic_memories WHERE id = ? AND agent_id = ?")
      .run(id, this.agentId);
    return result.changes > 0;
  }

  memoryCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM semantic_memories WHERE agent_id = ?")
      .get(this.agentId) as Record<string, unknown> | undefined;
    return row ? Number(row.count) : 0;
  }

  close(): void {
    this.db.close();
  }
}