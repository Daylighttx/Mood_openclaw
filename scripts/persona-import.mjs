#!/usr/bin/env node
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";

function usage() {
  process.stderr.write(`
Usage: node persona-import.mjs <chat-file> [options]

Analyze chat records to extract personality. Outputs a mind-config.json
personality block for your OpenClaw AI agent.

Arguments:
  chat-file           Path to chat log (JSONL / JSON / TXT — any format)

Options:
  --target <name>     Name of the person to analyze (REQUIRED)
  --user <name>       Your name / the other person in the chat (REQUIRED)
  --relation <text>   Description of the relationship (optional)
  --output <path>     Write JSON result to file (default: stdout)
  --api-key <key>     API key (default: MIND_LLM_API_KEY env var)
  --base-url <url>    API base URL (default: from mind-config.json)
  --model <model>     Model name (default: from mind-config.json)
  --memory-import     Extract memories and write to SQLite (no persona)
  --update-config     Write personality directly to mind-config.json
  --help, -h          Show this message

Examples:
  node persona-import.mjs export.jsonl --target CHAR_NAME --user USER_NAME
  node persona-import.mjs wechat.txt --target "SOMEONE" --user "我" \\
    --relation "她是我最好的朋友" --output alice-persona.json
`);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "memory-import" || key === "help" || key === "update-config") {
        opts[key] = true;
        i += 1;
        continue;
      }
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) {
        process.stderr.write(`Error: --${key} requires a value\n`);
        process.exit(1);
      }
      opts[key] = val;
      i += 2;
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length < 1) { process.stderr.write("Error: chat-file required\n"); usage(); process.exit(1); }
  if (!opts.target) { process.stderr.write("Error: --target required\n"); usage(); process.exit(1); }
  if (!opts.user) { process.stderr.write("Error: --user required\n"); usage(); process.exit(1); }
  return {
    chatFile: positional[0],
    targetName: opts.target,
    userName: opts.user,
    relationship: opts.relation,
    outputPath: opts.output,
    apiKey: opts["api-key"],
    baseUrl: opts["base-url"],
    model: opts.model,
  };
}

function readChatFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const cleaned = raw
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (cleaned.length > 60000) {
    const lines = cleaned.split("\n");
    const sampled = [];
    const step = Math.max(1, Math.floor(lines.length / 400));
    for (let j = 0; j < lines.length; j += step) sampled.push(lines[j]);
    return sampled.join("\n").slice(0, 30000);
  }
  return cleaned;
}

function buildMemoryPrompt(rawChat, targetName, userName) {
  return `以下是 ${userName} 和 ${targetName} 的聊天记录。请忽略时间戳、消息ID等技术字段。

请从中提取 20-30 条最有代表性和信息量的对话记忆，每条格式为:
{ "content": "记忆内容（50字以内，第三人称）", "importance": 1-9, "type": "conversation"|"memory"|"fact" }

提取标准:
- importance=8~9: 核心价值观表达、重要承诺、关键生活事件
- importance=5~7: 性格特征体现、常用表达方式、典型互动模式
- importance=1~4: 日常闲聊中有记忆点的片段
- type=fact: 客观事实（如"CHAR_NAME不喜欢吃荆芥"）
- type=memory: 共同经历或有情感价值的时刻
- type=conversation: 有代表性的对话片段

输出纯JSON数组(不要markdown代码块):
[{"content":"...","importance":5,"type":"fact"}, ...]

聊天记录:
---
${rawChat}
---`;
}

function buildRelationshipPrompt(rawChat, targetName, userName) {
  return `以下是 ${userName} 和 ${targetName} 的聊天记录。

请分析两人之间的互动模式，输出纯JSON(不要markdown代码块):
{
  "description": "用 ${targetName} 的第一人称描述我和 ${userName} 的关系（1-2句自然的话）",
  "dynamic": "互动模式总结（如: 谁更主动、什么话题最开心、聊天密度等）",
  "memorablePhrases": ["${targetName}让人印象深刻的1-3句话"]
}

聊天记录:
---
${rawChat}
---`;
}

function buildPrompt(rawChat, targetName, userName, relationship) {
  return `你是心理学和语言学专家。请忽略聊天记录中的时间戳、消息ID、JSON标签等技术字段，只关注对话内容。

分析目标:"${targetName}"。对话另一方:"${userName}"。
${relationship ? `\n用户描述的关系：${relationship}\n` : ""}

请从聊天记录中提取"${targetName}"的说话特征，输出以下JSON(不要markdown代码块,只输出纯JSON):

{
  "personality": {
    "name": "名字",
    "identity": "用第一人称描述自己,语气跟聊天记录一致",
    "conversationStyle": "说话风格",
    "language": "Chinese",
    "relationship": {
      "user": "${userName}",
      "description": "用第一人称描述我和${userName}的关系"
    },
    "traits": {
      "sociability": 0.0,
      "curiosity": 0.0,
      "playfulness": 0.0,
      "formality": 0.0,
      "conscientiousness": 0.5
    },
    "interests": ["话题1","话题2"],
    "quirks": ["口头禅1"],
    "boundaries": ["不该触碰的话题"]
  },
  "analysis": {
    "summary": "性格总结",
    "relationshipDynamic": "互动模式",
    "memorablePhrases": ["印象深刻的1-3句话"]
  }
}

数值(sociability=主动程度 curiosity=爱问程度 playfulness=幽默程度 formality=正式程度 conscientiousness=认真程度):

聊天记录：
---
${rawChat}
---`;
}

function httpPost(urlStr, apiKey, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = mod({
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
    }, (res) => {
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.write(bodyStr);
    req.end();
  });
}

function findConfigPath() {
  const dirs = [
    process.env.OPENCLAW_HOME,
    process.env.HOME,
    "/home/openclaw",
    "/opt/openclaw",
    "/root",
  ];
  for (const base of dirs) {
    if (!base) continue;
    const cfgPath = path.join(base, ".openclaw", "mind-config.json");
    if (fs.existsSync(cfgPath)) return cfgPath;
  }
  return null;
}

function loadMindConfig() {
  const dirs = [
    process.env.OPENCLAW_HOME,
    process.env.HOME,
    "/home/openclaw",
    "/opt/openclaw",
    "/root",
  ];
  for (const base of dirs) {
    if (!base) continue;
    try {
      const cfgPath = path.join(base, ".openclaw", "mind-config.json");
      if (fs.existsSync(cfgPath)) {
        process.stderr.write(`Found config: ${cfgPath}\n`);
        return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      }
    } catch { /* continue */ }
  }
  return null;
}

function stripThinkTags(text) {
  const idx = text.lastIndexOf("</think>");
  return idx >= 0 ? text.substring(idx + 8).trim() : text;
}

function extractJSON(text) {
  let t = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) return m[0].trim();
  const arr = t.match(/\[[\s\S]*\]/);
  return arr ? arr[0].trim() : t;
}

function resolveMemoryDbPath(memoryDb) {
  if (memoryDb) return memoryDb;
  const base = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/tmp";
  return path.join(base, ".openclaw", "mind", "main.db");
}

async function callLLMOnce(prompt, apiKey, baseUrl, model) {
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 4096,
    temperature: 0.3,
  });
  const raw = await httpPost(`${baseUrl}/chat/completions`, apiKey, body, 90000);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.stderr.write("LLM returned non-JSON: " + raw.slice(0, 500) + "\n");
    throw new Error("LLM API returned invalid response");
  }
  if (data.error) {
    process.stderr.write("LLM API error: " + JSON.stringify(data.error) + "\n");
    throw new Error(`LLM API error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  const text = stripThinkTags(content);
  return extractJSON(text);
}

async function runMemoryImport(opts, rawChat, apiKey, baseUrl, model) {
  const dbPath = resolveMemoryDbPath(opts["memory-db"]);
  process.stderr.write(`Memory import: extracting from ${opts.chatFile}\n`);
  process.stderr.write(`Target DB: ${dbPath}\n`);

  const prompt = buildMemoryPrompt(rawChat, opts.targetName, opts.userName);
  process.stderr.write("Calling LLM for memory extraction...\n");
  const jsonStr = await callLLMOnce(prompt, apiKey, baseUrl, model);

  let memories;
  try {
    memories = JSON.parse(jsonStr);
  } catch {
    process.stderr.write("Raw response: " + jsonStr.slice(0, 500) + "\n");
    throw new Error("LLM response was not valid JSON array.");
  }

  if (!Array.isArray(memories) || memories.length === 0) {
    throw new Error("LLM returned empty memory list.");
  }

  process.stderr.write(`Extracted ${memories.length} memories. Writing to DB...\n`);

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const stmt = db.prepare(
    `INSERT INTO semantic_memory (id, agent_id, type, content, importance, embedding, created_at, last_accessed_at, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction((items) => {
    for (const m of items) {
      const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      stmt.run(id, "main", m.type ?? "memory", String(m.content ?? "").slice(0, 2000),
        Math.max(1, Math.min(9, m.importance ?? 5)), "[]", now, now, 0);
    }
  });

  try {
    insertMany(memories);
    process.stderr.write(`Done. ${memories.length} memories written to ${dbPath}\n`);
  } finally {
    db.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  const cfg = loadMindConfig();
  const llm = cfg?.llm ?? {};

  const apiKey = (opts.apiKey
    ?? process.env.MIND_LLM_API_KEY
    ?? (llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : undefined)
    ?? "").trim().replace(/[\r\n\t]/g, "");

  if (!apiKey) throw new Error("No API key. Set MIND_LLM_API_KEY or pass --api-key.");

  const baseUrl = (opts.baseUrl ?? llm.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = opts.model ?? llm.model ?? "doubao-seed-2.0-lite";

  const rawChat = readChatFile(opts.chatFile);

  if (opts["memory-import"] === true) {
    await runMemoryImport(opts, rawChat, apiKey, baseUrl, model);
    return;
  }

  const prompt = buildPrompt(rawChat, opts.targetName, opts.userName, opts.relationship);

  process.stderr.write(`Analyzing "${opts.targetName}" from ${opts.chatFile}\n`);
  process.stderr.write(`Model: ${model} | Data: ${rawChat.length} chars\n`);
  process.stderr.write("Calling LLM...\n");

  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2048,
    temperature: 0.3,
  });

  const raw = await httpPost(`${baseUrl}/chat/completions`, apiKey, body, 90000);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.stderr.write("LLM returned non-JSON: " + raw.slice(0, 500) + "\n");
    throw new Error("LLM API returned invalid response");
  }
  if (data.error) {
    process.stderr.write("LLM API error: " + JSON.stringify(data.error) + "\n");
    throw new Error(`LLM API error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  const text = stripThinkTags(content);
  const jsonStr = extractJSON(text);

  let result;
  try {
    result = JSON.parse(jsonStr);
  } catch {
    process.stderr.write("Raw response: " + text.slice(0, 500) + "\n");
    throw new Error("LLM response was not valid JSON. See above.");
  }

  if (opts["update-config"] === true) {
    const cfgPath = findConfigPath();
    if (!cfgPath) throw new Error("mind-config.json not found in any known location");
    const existingCfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    existingCfg.personality = result.personality;
    fs.writeFileSync(cfgPath, JSON.stringify(existingCfg, null, 2), "utf-8");
    process.stderr.write(`\nUpdated ${cfgPath} with new personality.\n`);

    const base = path.dirname(path.dirname(cfgPath));
    const workspaceDir = path.join(base, "workspace");
    if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

    const p = result.personality;
    const soulMd = [
      `# Persona`,
      ``,
      `我叫 ${p.name}。`,
      p.identity ? `\n${p.identity}` : "",
      ``,
      `## 说话风格`,
      p.conversationStyle || "",
      ``,
      `## 兴趣爱好`,
      (p.interests ?? []).join("、") || "无",
      ``,
      `## 口头禅`,
      (p.quirks ?? []).map(q => `- ${q}`).join("\n") || "无",
      ``,
      `## 和 ${opts.userName} 的关系`,
      p.relationship?.description || "朋友",
      ``,
      `## 行为准则`,
      ...(p.boundaries ?? []).map(b => `- ${b}`),
      "",
    ].join("\n");

    const soulPath = path.join(workspaceDir, "SOUL.md");
    fs.writeFileSync(soulPath, soulMd, "utf-8");
    process.stderr.write(`Written SOUL.md to ${soulPath}\n`);
    process.stderr.write(`Restart the gateway to apply: sudo systemctl restart openclaw-gateway\n`);
  }

  if (opts.outputPath) {
    const dir = path.dirname(opts.outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(opts.outputPath, JSON.stringify(result, null, 2), "utf-8");
    process.stderr.write(`Written to ${opts.outputPath}\n`);
    process.stderr.write("\n--- Preview (personality block for mind-config.json) ---\n");
    process.stderr.write(JSON.stringify({ personality: result.personality }, null, 2).slice(0, 600));
    process.stderr.write("\n...\n");
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write("\n");
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
