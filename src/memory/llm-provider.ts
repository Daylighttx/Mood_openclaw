import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createSubsystemLogger } from "../logging/subsystem.js";

const llmLog = createSubsystemLogger("agent-mind").child("llm");

export interface MindLLMConfig {
  provider: "openai" | "deepseek" | "openai-compatible";
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxTokensPerMinute?: number;
  fallbackToRules?: boolean;
}

export interface MindLLMProvider {
  complete(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string>;
  completeJSON<T>(prompt: string, schemaHint?: string): Promise<T>;
  isAvailable(): boolean;
}

function stripThinkTags(text: string): string {
  const closeIdx = text.lastIndexOf("</think>");
  if (closeIdx >= 0) {
    return text.substring(closeIdx + 8).trim();
  }
  return text;
}

function nodeRequest(
  urlStr: string,
  apiKey: string,
  bodyStr: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? httpsRequest : httpRequest;

    const req = mod(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Content-Length": String(Buffer.byteLength(bodyStr)),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out."));
    });

    req.write(bodyStr);
    req.end();
  });
}

class NativeHttpMindLLMProvider implements MindLLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private config: MindLLMConfig;

  constructor(config: MindLLMConfig) {
    this.config = config;
    this.apiKey = (process.env[config.apiKeyEnv] ?? "").trim().replace(/[\r\n\t]/g, "");
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

    if (!this.apiKey) {
      llmLog.warn("MindLLM: API key not found in env", { env: config.apiKeyEnv });
    } else {
      llmLog.info("MindLLM: initialized (node:http)", {
        provider: config.provider,
        model: config.model,
        baseUrl: this.baseUrl,
        timeoutMs: config.timeoutMs ?? 30_000,
      });
    }
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 512;
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const timeoutMs = this.config.timeoutMs ?? 30_000;

    const bodyStr = JSON.stringify({
      model: this.config.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
    });

    const raw = await nodeRequest(
      `${this.baseUrl}/chat/completions`,
      this.apiKey,
      bodyStr,
      timeoutMs,
    );

    const data = JSON.parse(raw) as Record<string, unknown>;
    const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
    const msg = choice?.message as Record<string, unknown> | undefined;
    const content = typeof msg?.content === "string" ? msg.content : "";
    return stripThinkTags(content.trim());
  }

  async completeJSON<T>(prompt: string, schemaHint?: string): Promise<T> {
    const systemMsg = schemaHint
      ? `You must respond with valid JSON matching this schema: ${schemaHint}. Respond ONLY with the JSON object after your thinking. No markdown, no explanation outside the JSON.`
      : "You must respond with valid JSON. Respond ONLY with the JSON object. No markdown, no explanation.";

    const combinedPrompt = `${systemMsg}\n\n${prompt}`;
    const timeoutMs = this.config.timeoutMs ?? 30_000;

    const bodyStr = JSON.stringify({
      model: this.config.model,
      messages: [{ role: "user", content: combinedPrompt }],
      max_tokens: this.config.maxTokens ?? 512,
      temperature: this.config.temperature ?? 0.3,
    });

    const raw = await nodeRequest(
      `${this.baseUrl}/chat/completions`,
      this.apiKey,
      bodyStr,
      timeoutMs,
    );

    const data = JSON.parse(raw) as Record<string, unknown>;
    const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
    const msg = choice?.message as Record<string, unknown> | undefined;
    const text = typeof msg?.content === "string" ? stripThinkTags(msg.content.trim()) : "";

    let jsonStr = text
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();

    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0].trim();

    return JSON.parse(jsonStr) as T;
  }
}

class NoOpMindLLMProvider implements MindLLMProvider {
  isAvailable(): boolean {
    return false;
  }

  async complete(): Promise<string> {
    throw new Error("MindLLM: no provider configured");
  }

  async completeJSON<T>(): Promise<T> {
    throw new Error("MindLLM: no provider configured");
  }
}

export function createMindLLMProvider(config: MindLLMConfig | null | undefined): MindLLMProvider {
  if (!config) {
    return new NoOpMindLLMProvider();
  }
  return new NativeHttpMindLLMProvider(config);
}

export function resolveMindLLMConfig(
  raw: Record<string, unknown> | null,
): MindLLMConfig | null {
  if (!raw || !raw.llm) return null;
  const llm = raw.llm as Record<string, unknown>;
  if (!llm.model || !llm.apiKeyEnv) {
    llmLog.warn("MindLLM: config missing required fields (model, apiKeyEnv)", { llm });
    return null;
  }
  return {
    provider: (llm.provider as MindLLMConfig["provider"]) ?? "openai-compatible",
    model: String(llm.model),
    apiKeyEnv: String(llm.apiKeyEnv),
    baseUrl: llm.baseUrl ? String(llm.baseUrl) : undefined,
    maxTokens: typeof llm.maxTokens === "number" ? llm.maxTokens : undefined,
    temperature: typeof llm.temperature === "number" ? llm.temperature : undefined,
    timeoutMs: typeof llm.timeoutMs === "number" ? llm.timeoutMs : undefined,
    maxTokensPerMinute: typeof llm.maxTokensPerMinute === "number" ? llm.maxTokensPerMinute : undefined,
    fallbackToRules: llm.fallbackToRules !== false,
  };
}
