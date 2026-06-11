import * as fs from "node:fs";
import * as path from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface PersonaImportOptions {
  chatFile: string;
  targetName: string;
  userName: string;
  relationship?: string;
  outputPath?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface PersonaImportResult {
  personality: {
    name: string;
    identity: string;
    conversationStyle: string;
    language: string;
    relationship: {
      user: string;
      description: string;
    };
    traits: {
      curiosity: number;
      sociability: number;
      playfulness: number;
      formality: number;
      conscientiousness: number;
    };
    interests: string[];
    quirks: string[];
    boundaries: string[];
  };
  analysis: {
    summary: string;
    relationshipDynamic: string;
    memorablePhrases: string[];
  };
}

function readChatFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");

  const cleaned = raw
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  if (cleaned.length > 60000) {
    const lines = cleaned.split("\n");
    const sampled: string[] = [];
    const step = Math.max(1, Math.floor(lines.length / 400));
    for (let i = 0; i < lines.length; i += step) {
      sampled.push(lines[i]);
    }
    return sampled.join("\n").slice(0, 30000);
  }

  return cleaned;
}

function buildAnalysisPrompt(
  rawChat: string,
  targetName: string,
  userName: string,
  relationship?: string,
): string {
  return `你是心理学和语言学专家。以下是一段聊天记录，其中可能包含时间戳、消息ID、JSON结构标签等技术字段。请忽略这些技术字段，只关注人类对话的内容本身。

你需要分析的目标人物是 "${targetName}"。对话的另一个人是 "${userName}"。
${relationship ? `\n用户描述的关系：${relationship}\n` : ""}

请从聊天记录中提取 "${targetName}" 的说话特征，严格输出以下JSON格式（不要markdown代码块，只输出纯JSON）：

{
  "personality": {
    "name": "${targetName}的名字",
    "identity": "用第一人称描述自己的身份和性格，语气要跟聊天记录里一致",
    "conversationStyle": "说话风格描述（如活泼、温柔、直爽、话少、爱笑等）",
    "language": "Chinese",
    "relationship": {
      "user": "${userName}",
      "description": "用第一人称描述我和${userName}的关系，自然一点，像聊天时无意透露的感觉"
    },
    "traits": {
      "sociability": 0.0,
      "curiosity": 0.0,
      "playfulness": 0.0,
      "formality": 0.0,
      "conscientiousness": 0.5
    },
    "interests": ["经常聊的话题1", "话题2", "话题3"],
    "quirks": ["口头禅或特殊习惯1", "习惯2"],
    "boundaries": ["基于聊天记录推断的不该触碰的话题"]
  },
  "analysis": {
    "summary": "一段整体的性格总结",
    "relationshipDynamic": "从聊天记录看出的互动模式",
    "memorablePhrases": ["让人印象深刻的1-3句话"]
  }
}

数值说明：
- sociability: 0=完全被动 1=总是主动发起话题
- curiosity: 0=从不提问 1=非常爱问问题
- playfulness: 0=很严肃 1=非常幽默爱开玩笑
- formality: 0=非常随意 1=非常正式
- conscientiousness: 0=粗心随意 1=非常认真负责

聊天记录：
---
${rawChat}
---`;
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

async function callLLM(
  prompt: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string> {
  const bodyStr = JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2048,
    temperature: 0.3,
  });

  const raw = await nodeRequest(
    `${baseUrl}/chat/completions`,
    apiKey,
    bodyStr,
    60_000,
  );

  const data = JSON.parse(raw) as Record<string, unknown>;
  const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
  const msg = choice?.message as Record<string, unknown> | undefined;
  const content = typeof msg?.content === "string" ? msg.content.trim() : "";

  const thinkClose = content.lastIndexOf("</think>");
  const text = thinkClose >= 0 ? content.substring(thinkClose + 8).trim() : content;

  const jsonStr = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0].trim();

  return jsonStr;
}

function loadMindConfig(): Record<string, unknown> | null {
  try {
    const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
    const cfgPath = path.join(base, ".openclaw", "mind-config.json");
    if (!fs.existsSync(cfgPath)) return null;
    return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {
    return null;
  }
}

export async function runPersonaImport(opts: PersonaImportOptions): Promise<PersonaImportResult> {
  const cfg = loadMindConfig();
  const llm = (cfg?.llm as Record<string, unknown> | undefined) ?? {};

  const apiKey = opts.apiKey
    ?? process.env.MIND_LLM_API_KEY
    ?? (llm.apiKeyEnv ? process.env[String(llm.apiKeyEnv)] : undefined);

  if (!apiKey) {
    throw new Error(
      "No API key found. Set MIND_LLM_API_KEY env var or provide --api-key flag.",
    );
  }

  const baseUrl = opts.baseUrl
    ?? String(llm.baseUrl ?? "https://api.openai.com/v1");

  const model = opts.model ?? String(llm.model ?? "doubao-seed-2.0-lite");

  const sanitizedKey = apiKey.trim().replace(/[\r\n\t]/g, "");

  const rawChat = readChatFile(opts.chatFile);

  const prompt = buildAnalysisPrompt(
    rawChat,
    opts.targetName,
    opts.userName,
    opts.relationship,
  );

  process.stderr.write(`Analyzing "${opts.targetName}" from ${opts.chatFile}...\n`);
  process.stderr.write(`Using model: ${model}\n`);
  process.stderr.write(`Chat data size: ${rawChat.length} chars\n`);
  process.stderr.write("Calling LLM...\n");

  const response = await callLLM(prompt, sanitizedKey, baseUrl, model);

  process.stderr.write("LLM response received. Parsing...\n");

  let result: PersonaImportResult;
  try {
    result = JSON.parse(response) as PersonaImportResult;
  } catch {
    process.stderr.write("Raw response: " + response.slice(0, 500) + "\n");
    throw new Error("Failed to parse LLM response as JSON. Check raw output above.");
  }

  if (opts.outputPath) {
    const dir = path.dirname(opts.outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(opts.outputPath, JSON.stringify(result, null, 2), "utf-8");
    process.stderr.write(`Written to ${opts.outputPath}\n`);
  }

  return result;
}
