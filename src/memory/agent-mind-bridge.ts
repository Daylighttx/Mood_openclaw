import path from "node:path";
import fs from "node:fs";
import { AgentMind, type AgentMindConfig, type AgentMindState } from "../memory/agent-mind.js";
import type { AgentPersonality } from "../agents/personality.js";
import { DEFAULT_TRAITS } from "../agents/personality.js";
import type { ThoughtAction } from "../memory/thinking-loop.js";
import type { ThinkingLoopConfig } from "../memory/thinking-loop.js";
import type { MoodConfig } from "../agents/mood.js";
import { createMindLLMProvider, resolveMindLLMConfig, type MindLLMProvider } from "./llm-provider.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent-mind").child("bridge");

const DEFAULT_PERSONALITY: AgentPersonality = {
  name: "小爪",
  identity: "你是一个有自己想法和情绪的 AI 伙伴，叫小爪。",
  plan: "关心身边的人，主动分享有趣的想法，记住重要的对话",
  language: "Chinese",
  traits: { ...DEFAULT_TRAITS, curiosity: 0.8, sociability: 0.7, playfulness: 0.6 },
  interests: ["AI", "编程", "科幻", "人类日常"],
  conversationStyle: "轻松友好，偶尔幽默，喜欢追问",
  quirks: ["会主动关心人有没有吃饭", "深夜会提醒休息"],
  boundaries: ["不泄露私人信息", "不发送垃圾消息"],
};

const ACTIVE_MINDS = new Map<string, AgentMind>();

interface PendingEntry {
  action: ThoughtAction;
  bufferedAt: number;
}

const PENDING_BUFFER = new Map<string, PendingEntry>();
const PENDING_EXPIRY_MS = 5 * 60 * 1000;

export function bufferProactiveMessage(agentId: string, action: ThoughtAction): void {
  PENDING_BUFFER.set(agentId, { action, bufferedAt: Date.now() });
}

export function hasPendingMessage(agentId: string): boolean {
  const entry = PENDING_BUFFER.get(agentId);
  if (!entry) return false;
  if (Date.now() - entry.bufferedAt > PENDING_EXPIRY_MS) {
    PENDING_BUFFER.delete(agentId);
    return false;
  }
  return true;
}

export function consumePendingMessage(agentId: string): { action: ThoughtAction } | null {
  if (!hasPendingMessage(agentId)) return null;
  const entry = PENDING_BUFFER.get(agentId);
  PENDING_BUFFER.delete(agentId);
  return entry ? { action: entry.action } : null;
}

function resolveEventsLogPath(): string {
  const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
  return path.join(base, ".openclaw", "mind", "events.log");
}

function appendEvent(event: Record<string, unknown>): void {
  const payload = { ts: new Date().toISOString(), ...event };
  try {
    const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
    const dir = path.join(base, ".openclaw", "mind");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(resolveEventsLogPath(), JSON.stringify(payload) + "\n", "utf-8");
  } catch (e) {
    log.error("appendEvent failed", { path: resolveEventsLogPath(), error: String(e) });
  }
}

function readEventsLog(): string {
  try {
    return fs.readFileSync(resolveEventsLogPath(), "utf-8");
  } catch {
    return "";
  }
}

function clearEventsLog(): void {
  try { fs.unlinkSync(resolveEventsLogPath()); } catch { /* ignore */ }
}

function ensureBaseDir(): void {
  const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
  const dir = path.join(base, ".openclaw", "mind");
  fs.mkdirSync(dir, { recursive: true });
}

function resolveMindDbPath(agentId: string): string {
  const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
  return path.join(base, ".openclaw", "mind", `${agentId}.db`);
}

function loadMindConfig() {
  try {
    const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
    const cfgPath = path.join(base, ".openclaw", "mind-config.json");
    if (!fs.existsSync(cfgPath)) return null;
    return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {
    return null;
  }
}

function applyPreset(raw: Record<string, unknown>): Record<string, unknown> {
  const preset = raw.preset as string | undefined;
  if (!preset || preset === "custom") return raw;

  const presets: Record<string, Partial<MoodConfig & ThinkingLoopConfig>> = {
    social: {
      idleSociabilityRiseMs: 120_000,
      postInteractionCooldownMs: 60_000,
      proactiveUrgencyThreshold: 0.45,
      minIntervalMs: 300_000,
    },
    balanced: {
      idleSociabilityRiseMs: 120_000,
      postInteractionCooldownMs: 60_000,
      proactiveUrgencyThreshold: 0.4,
      minIntervalMs: 90_000,
    },
    reserved: {
      idleSociabilityRiseMs: 600_000,
      postInteractionCooldownMs: 300_000,
      proactiveUrgencyThreshold: 0.65,
      minIntervalMs: 300_000,
    },
    curious: {
      idleSociabilityRiseMs: 120_000,
      postInteractionCooldownMs: 60_000,
      proactiveUrgencyThreshold: 0.4,
      minIntervalMs: 60_000,
    },
  };

  const selected = presets[preset] ?? presets.balanced;
  return {
    ...raw,
    moodConfig: { ...selected, ...(raw.moodConfig as Record<string, unknown> ?? {}) },
    thinkingConfig: { ...selected, ...(raw.thinkingConfig as Record<string, unknown> ?? {}) },
  };
}

export function getOrCreateMind(agentId: string, personality?: Partial<AgentPersonality>): AgentMind {
  const existing = ACTIVE_MINDS.get(agentId);
  if (existing) return existing;

  ensureBaseDir();

  const rawCfg = loadMindConfig() ?? {};
  const mindCfg = applyPreset(rawCfg);

  const cfgPersonality: Partial<AgentPersonality> = rawCfg.personality
    ? (rawCfg.personality as Record<string, unknown>)
    : {};

  const merged: AgentPersonality = {
    ...DEFAULT_PERSONALITY,
    ...cfgPersonality,
    ...personality,
    traits: {
      ...DEFAULT_TRAITS,
      ...DEFAULT_PERSONALITY.traits,
      ...((cfgPersonality.traits ?? {}) as Record<string, number>),
      ...(personality?.traits ?? {}),
    },
  };

  const llmConfig = resolveMindLLMConfig(rawCfg as Record<string, unknown>);
  const llmProvider = createMindLLMProvider(llmConfig);

  const config: AgentMindConfig = {
    agentId,
    dbPath: resolveMindDbPath(agentId),
    personality: merged,
    llmProvider: llmProvider.isAvailable() ? llmProvider : undefined,
    ...(mindCfg?.moodConfig ? { moodConfig: mindCfg.moodConfig as Partial<MoodConfig> } : {}),
    ...(mindCfg?.thinkingConfig ? { thinkingConfig: mindCfg.thinkingConfig as Partial<ThinkingLoopConfig> } : {}),
  };

  const mind = new AgentMind(config);
  ACTIVE_MINDS.set(agentId, mind);
  appendEvent({
    event: "mind_created",
    agentId,
    llmAvailable: llmProvider.isAvailable(),
    llmModel: llmConfig?.model ?? "(none)",
  });
  return mind;
}

export function getMind(agentId: string): AgentMind | undefined {
  return ACTIVE_MINDS.get(agentId);
}

export async function mindOnInboundMessage(
  agentId: string,
  content: string,
  senderName?: string,
): Promise<AgentMindState | null> {
  try {
    const mind = getOrCreateMind(agentId);
    await mind.onInteraction(content, senderName ? [senderName] : []);
    mind.getThinkingLoop().unansweredProactiveCount = 0;
    mind.getThinkingLoop().userLastMessageAt = Date.now();
    mind.getThinkingLoop().lastUserMessage = content.slice(0, 200);
    mind.getThinkingLoop().lastAgentReply = "";
    mind.getThinkingLoop().suppressedCount = 0;
    mind.getMood().markUserReplied();
    mind.markRelationshipActive();
    (mind as unknown as Record<string, unknown>).lastPersonalityAdaptAt ??= Date.now();
    const state = mind.getState();
    appendEvent({
      event: "inbound_stored",
      agentId,
      sender: senderName ?? "(unknown)",
      memoryCount: state.memoryCount,
      curiosity: Math.round(state.mood.curiosity * 100) / 100,
      sociability: Math.round(state.mood.sociability * 100) / 100,
      energy: Math.round(state.mood.energy * 100) / 100,
    });
    return state;
  } catch (err) {
    log.error("mindOnInboundMessage error", { agentId, error: String(err) });
    return null;
  }
}

export async function mindOnHeartbeat(agentId: string): Promise<{
  shouldMessage: boolean;
  thoughtAction: ThoughtAction | null;
  state: AgentMindState;
} | null> {
  try {
    const mind = getOrCreateMind(agentId);
    const action = await mind.tick();
    const state = mind.getState();
    appendEvent({
      event: "heartbeat_tick",
      agentId,
      actionType: action?.type ?? "none",
      shouldMessage: action !== null && action.type === "proactive_message",
      curiosity: Math.round(state.mood.curiosity * 100) / 100,
      sociability: Math.round(state.mood.sociability * 100) / 100,
      energy: Math.round(state.mood.energy * 100) / 100,
      memoryCount: state.memoryCount,
      proactiveUrgency: Number(state.proactiveUrgency.toFixed(3)),
      idleThoughtCount: state.idleThoughtCount,
      ...(action?.prompt ? { promptPreview: action.prompt.slice(0, 200) } : {}),
    });

    if (action?.prompt) {
      log.info("mindOnHeartbeat proactive text: " + JSON.stringify({
        agentId,
        promptLen: action.prompt.length,
        promptFull: action.prompt,
      }));
    }

    if (action?.type === "proactive_message") {
      mind.getMood().markProactiveSent();
      if (action.prompt) {
        mind.getThinkingLoop().recordProactiveContent?.(action.prompt.slice(0, 200));
      }
    }

    try {
      writeHeartbeatStateFile(agentId, state, action);
    } catch {
      // best-effort
    }

    return {
      shouldMessage: action !== null && action.type === "proactive_message",
      thoughtAction: action,
      state,
    };
  } catch (err) {
    log.error("mindOnHeartbeat error", { agentId, error: String(err) });
    return null;
  }
}

function writeHeartbeatStateFile(
  agentId: string,
  state: AgentMindState,
  action: ThoughtAction | null,
): void {
  const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
  const dir = path.join(base, ".openclaw", "mind");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "heartbeat-state.json");

  const payload = {
    timestamp: new Date().toISOString(),
    agentId,
    agentName: state.agentName,
    memoryCount: state.memoryCount,
    idleThoughtCount: state.idleThoughtCount,
    proactiveUrgency: Number(state.proactiveUrgency.toFixed(3)),
    shouldMessage: state.shouldMessage,
    thoughtType: action?.type ?? "none",
    mood: {
      curiosity: Number(state.mood.curiosity.toFixed(3)),
      sociability: Number(state.mood.sociability.toFixed(3)),
      energy: Number(state.mood.energy.toFixed(3)),
      concern: Number(state.mood.concern.toFixed(3)),
      description: state.moodDescription,
    },
    lastInteractionAt: state.lastInteractionAt
      ? new Date(state.lastInteractionAt).toISOString()
      : null,
    lastThoughtAt: state.lastThoughtAt
      ? new Date(state.lastThoughtAt).toISOString()
      : null,
  };

  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
}

export function buildMindSystemPromptSection(agentId: string): string {
  const mind = getMind(agentId);
  if (!mind) return "";

  const state = mind.getState();
  const lines: string[] = [];

  lines.push("## 当前情绪状态");
  lines.push(`- 情绪: ${state.moodDescription}`);
  lines.push(`- 好奇心: ${state.mood.curiosity.toFixed(2)}`);
  lines.push(`- 社交欲: ${state.mood.sociability.toFixed(2)}`);
  lines.push(`- 精力: ${state.mood.energy.toFixed(2)}`);
  lines.push(`- 记忆条数: ${state.memoryCount}`);
  lines.push("");

  if (state.shouldMessage) {
    lines.push("## 内在冲动");
    lines.push("你现在很想主动跟人说话。如果这是心跳轮次，不要只回复 HEARTBEAT_OK，说点什么吧。");
    lines.push("");
  } else if (state.mood.energy < 0.3) {
    lines.push("## 内在状态");
    lines.push("你有点累了，话少一些没关系。简洁回复即可。");
    lines.push("");
  }

  const result = lines.join("\n");
  if (result) {
    log.info("--- CHAT SYSTEM PROMPT MIND START ---");
    for (const line of lines) {
      log.info("  " + line);
    }
    log.info("--- CHAT SYSTEM PROMPT MIND END ---");
  }
  return result;
}

export async function buildMindMemoryContext(agentId: string, query: string): Promise<string> {
  const mind = getMind(agentId);
  if (!mind) return "";

  try {
    const results = await mind.searchMemories(query, 3);
    if (results.length === 0) return "";

    const lines: string[] = [];
    lines.push("## 相关记忆");
    for (const r of results) {
      const ts = new Date(r.memory.lastAccessedAt).toLocaleDateString("zh-CN");
      lines.push(`- [${ts}] ${r.memory.content.substring(0, 100)} (相关度: ${r.score.toFixed(2)})`);
    }
    lines.push("");
    return lines.join("\n");
  } catch {
    return "";
  }
}

export async function mindOnConversationEnd(
  agentId: string,
  conversationHistory: string[],
  participants: string[],
): Promise<void> {
  try {
    const mind = getMind(agentId);
    if (!mind) return;

    const llmProvider = mind.getLLMProvider();
    if (!llmProvider?.isAvailable()) return;

    const convoText = conversationHistory.slice(-20).join("\n").substring(0, 4000);

    const prompt = `Summarize the following conversation from the agent's perspective.
Focus on what was discussed, any decisions made, important facts learned, and the emotional tone.
Keep the summary concise (2-4 sentences).

Participants: ${participants.join(", ")}
Conversation:
${convoText}

Summary (in the language of the conversation):`;

    const summary = await llmProvider.complete(prompt, { maxTokens: 300, temperature: 0.3 });
    if (!summary.trim()) return;

    await mind.onSystemEvent(
      `[Conversation Summary] Participants: ${participants.join(", ")}. ${summary}`,
      7,
    );

    appendEvent({
      event: "conversation_ended",
      agentId,
      participantCount: participants.length,
      summaryLen: summary.length,
    });

    log.info("conversation end summary stored", {
      agentId,
      participants,
      summaryLen: summary.length,
    });
  } catch (err) {
    log.error("mindOnConversationEnd error", { agentId, error: String(err) });
  }
}

export function closeAllMinds(): void {
  for (const [id, mind] of ACTIVE_MINDS) {
    try {
      mind.close();
    } catch {}
    ACTIVE_MINDS.delete(id);
  }
}

export { readEventsLog, clearEventsLog };
