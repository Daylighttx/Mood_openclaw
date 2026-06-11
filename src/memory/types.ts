export interface SemanticMemory {
  id: string;
  agentId: string;
  type: "conversation" | "reflection" | "thought";
  content: string;
  importance: number;
  embedding: number[];
  participants?: string[];
  keywords?: string[];
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  memory: SemanticMemory;
  score: number;
  relevanceScore: number;
  recencyScore: number;
  importanceScore: number;
}

export interface ReflectionResult {
  memories: SemanticMemory[];
  insights: string[];
  importance: number;
}

export interface ConversationSummary {
  agentId: string;
  participants: string[];
  summary: string;
  keywords: string[];
  importance: number;
  messageCount: number;
  startedAt: number;
  endedAt: number;
}