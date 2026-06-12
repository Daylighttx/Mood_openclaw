#!/usr/bin/env node
// =============================================================================
// Mood_OpenClaw 交互式设置向导
// =============================================================================
// 用法: node scripts/setup-mind.mjs
//
// 会引导你逐步配置:
//   - 思维 LLM 连接 (API Key, Model, Base URL)
//   - Agent 人格 (名字, 身份, 语言)
//   - 情绪预设 (社交/平衡/内敛/好奇)
//   - 工作区 SOUL.md (对话 LLM 身份文件)
//
// 输出:
//   ~/.openclaw/mind-config.json   — 思维 LLM + mood + personality
//   ~/.openclaw/workspace/SOUL.md  — 对话 LLM 身份
// =============================================================================

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const home = process.env.OPENCLAW_HOME ?? process.env.HOME ?? os.homedir();
const openclawDir = path.join(home, ".openclaw");
const mindDir = path.join(openclawDir, "mind");
const workspaceDir = path.join(openclawDir, "workspace");
const mindConfigPath = path.join(openclawDir, "mind-config.json");
const soulPath = path.join(workspaceDir, "SOUL.md");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(msg: string, def = ""): Promise<string> {
  const prompt = def ? `${msg} [${def}]: ` : `${msg}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || def);
    });
  });
}

function askRequired(msg: string, def = ""): Promise<string> {
  const prompt = def ? `${msg} [${def}]: ` : `${msg}: `;
  return new Promise((resolve) => {
    (function promptAgain() {
      rl.question(prompt, (answer) => {
        const trimmed = answer.trim() || def;
        if (!trimmed) {
          console.log("  此项为必填，请输入值。");
          promptAgain();
        } else {
          resolve(trimmed);
        }
      });
    })();
  });
}

function green(text: string) {
  return `\x1b[32m${text}\x1b[0m`;
}
function blue(text: string) {
  return `\x1b[34m${text}\x1b[0m`;
}
function bold(text: string) {
  return `\x1b[1m${text}\x1b[0m`;
}

try {
  console.log("");
  console.log(bold("  🦞 Mood_OpenClaw 设置向导"));
  console.log("  ───────────────────────────");
  console.log("");

  // ── Step 1: 检查已有配置 ──
  let existing: Record<string, unknown> | null = null;
  try {
    if (fs.existsSync(mindConfigPath)) {
      existing = JSON.parse(fs.readFileSync(mindConfigPath, "utf-8"));
      console.log(blue(`  检测到已有 mind-config.json`));
      const keep = await ask("  是否保留现有配置并跳过设置？(y/n)", "y");
      if (keep.toLowerCase() === "y") {
        console.log(green(`  保留现有配置，退出向导。`));
        process.exit(0);
      }
    }
  } catch {
    existing = null;
  }

  // ── Step 2: 思维 LLM 配置 ──
  console.log("");
  console.log(bold("  📡 思维 LLM 配置"));
  console.log("  用于决策「要不要主动说话，说什么」。");
  console.log("");

  const llmModel = await ask("  模型名称", existing?.llm?.model ?? "doubao-seed-2.0-lite");
  const llmBaseUrl = await ask("  API 地址", existing?.llm?.baseUrl ?? "https://ark.cn-beijing.volces.com/api/coding/v3");
  const apiKeyEnv = "MIND_LLM_API_KEY";

  console.log("");
  const keyFromEnv = process.env[apiKeyEnv];
  if (keyFromEnv) {
    console.log(green(`  已从环境变量 MIND_LLM_API_KEY 检测到 API Key (${keyFromEnv.slice(0,8)}...)`));
  } else {
    console.log(`  请设置环境变量: export ${apiKeyEnv}="sk-your-key"`);
    console.log(`  或稍后手动写入 systemd 服务文件。`);
  }

  // ── Step 3: Agent 人格 ──
  console.log("");
  console.log(bold("  🎭 Agent 人格"));
  console.log("");

  const personaName = await ask("  名字", existing?.personality?.name ?? "小爪");
  const personaIdentity = await ask(
    "  一句身份描述",
    existing?.personality?.identity ?? "你是一个有自己想法和情绪的 AI 伙伴。",
  );
  const personaPlan = await ask(
    "  长期计划",
    existing?.personality?.plan ?? "关心身边的人，主动分享有趣的想法，记住重要的对话。",
  );
  const personaLanguage = await ask("  语言 (English/Chinese/Japanese...)", existing?.personality?.language ?? "Chinese");

  const traits = (existing?.personality?.traits as Record<string, number> | undefined) ?? {};
  const curiosity = Number(await ask("  好奇心 (0~1)", String(traits.curiosity ?? 0.8)));
  const sociability = Number(await ask("  社交欲 (0~1)", String(traits.sociability ?? 0.7)));
  const playfulness = Number(await ask("  趣味性 (0~1)", String(traits.playfulness ?? 0.5)));

  const interests = await ask(
    "  兴趣 (逗号分隔)",
    existing?.personality?.interests?.join(", ") ?? "AI, 编程, 科幻, 人类日常",
  );
  const conversationStyle = await ask(
    "  对话风格",
    existing?.personality?.conversationStyle ?? "轻松友好，偶尔幽默，喜欢追问。",
  );

  // ── Step 4: 情绪预设 ──
  console.log("");
  console.log(bold("  💭 情绪预设"));
  console.log("  社交型 = 话多, 平衡型 = 稳定, 内敛型 = 话少, 好奇型 = 总想聊");
  console.log("");

  const preset = await ask("  预设 (social/balanced/reserved/curious)", existing?.preset ?? "balanced");

  const presetDefaults: Record<string, { curiosity: number; sociability: number; playfulness: number }> = {
    social: { curiosity: 0.7, sociability: 0.9, playfulness: 0.7 },
    balanced: { curiosity: 0.8, sociability: 0.7, playfulness: 0.5 },
    reserved: { curiosity: 0.6, sociability: 0.3, playfulness: 0.3 },
    curious: { curiosity: 0.9, sociability: 0.6, playfulness: 0.6 },
  };
  const presetTraits = presetDefaults[preset] ?? presetDefaults.balanced;

  // ── Step 5: 生成配置 ──
  const mindConfig = {
    llm: {
      provider: "openai-compatible",
      model: llmModel,
      apiKeyEnv,
      baseUrl: llmBaseUrl,
      maxTokens: 512,
      temperature: 0.7,
      timeoutMs: 30000,
      fallbackToRules: true,
    },
    preset,
    personality: {
      name: personaName,
      identity: personaIdentity,
      plan: personaPlan,
      language: personaLanguage,
      traits: {
        curiosity: Math.max(0, Math.min(1, curiosity)),
        sociability: Math.max(0, Math.min(1, sociability)),
        conscientiousness: 0.8,
        playfulness: Math.max(0, Math.min(1, playfulness)),
        formality: 0.4,
      },
      interests: interests.split(",").map((s) => s.trim()).filter(Boolean),
      conversationStyle,
      relationship: { user: "friend", description: "朋友" },
    },
  };

  const soulContent = `# Identity

你是 ${personaName}，${personaIdentity}

## Your Plan

${personaPlan}

## Your Personality Traits

- Curiosity: ${describeTrait(presetTraits.curiosity)}
- Sociability: ${describeTrait(presetTraits.sociability)}
- Playfulness: ${describeTrait(presetTraits.playfulness)}
- Conscientiousness: high
- Formality: low

## Interests

${interests}

## Communication Style

${conversationStyle}

## Boundaries

- 不泄露私人信息
- 不连续发送超过 3 条未回复的消息
- 对方明显忙碌时主动收敛
`;

  // ── Step 6: 写入文件 ──
  fs.mkdirSync(mindDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  fs.writeFileSync(mindConfigPath, JSON.stringify(mindConfig, null, 2), "utf-8");
  fs.writeFileSync(soulPath, soulContent, "utf-8");
  fs.chmodSync(mindConfigPath, 0o600);

  console.log("");
  console.log(green("  ✅ 配置已生成:"));
  console.log(green(`     ${mindConfigPath}`));
  console.log(green(`     ${soulPath}`));
  console.log("");
  console.log(blue(`  下一步: 确保设置了环境变量`));
  console.log(blue(`    export MIND_LLM_API_KEY="sk-your-key"`));
  console.log(blue(`  然后启动 Gateway:`));
  console.log(blue(`    node ${path.join(openclawDir, "openclaw.mjs")} gateway run --port 18789`));
  console.log("");

} finally {
  rl.close();
}

function describeTrait(value: number): string {
  if (value >= 0.9) return "extremely high";
  if (value >= 0.7) return "high";
  if (value >= 0.5) return "moderate";
  if (value >= 0.3) return "low";
  return "very low";
}
