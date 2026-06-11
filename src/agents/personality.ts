export interface AgentPersonality {
  name: string;
  identity: string;
  plan: string;
  language: string;
  traits: PersonalityTraits;
  interests: string[];
  conversationStyle: string;
  quirks?: string[];
  boundaries?: string[];
  relationship?: { user: string; description: string };
}

export interface PersonalityTraits {
  curiosity: number;
  sociability: number;
  conscientiousness: number;
  playfulness: number;
  formality: number;
}

export const DEFAULT_TRAITS: PersonalityTraits = {
  curiosity: 0.7,
  sociability: 0.6,
  conscientiousness: 0.8,
  playfulness: 0.5,
  formality: 0.4,
};

export function validateTraits(traits: PersonalityTraits): PersonalityTraits {
  const keys: (keyof PersonalityTraits)[] = [
    "curiosity",
    "sociability",
    "conscientiousness",
    "playfulness",
    "formality",
  ];

  const clamped: PersonalityTraits = { ...traits };
  for (const key of keys) {
    clamped[key] = Math.max(0, Math.min(1, clamped[key]));
  }

  return clamped;
}

export function buildPersonalityPrompt(personality: AgentPersonality): string {
  const lines: string[] = [];

  lines.push(`## Your Identity`);
  lines.push(personality.identity);
  lines.push("");

  lines.push(`## Your Plan`);
  lines.push(personality.plan);
  lines.push("");

  lines.push(`## Your Personality Traits`);
  lines.push(`- Curiosity: ${describeTrait(personality.traits.curiosity)}`);
  lines.push(`- Sociability: ${describeTrait(personality.traits.sociability)}`);
  lines.push(`- Conscientiousness: ${describeTrait(personality.traits.conscientiousness)}`);
  lines.push(`- Playfulness: ${describeTrait(personality.traits.playfulness)}`);
  lines.push(`- Formality: ${describeTrait(personality.traits.formality)}`);
  lines.push("");

  if (personality.interests.length > 0) {
    lines.push(`## Your Interests`);
    lines.push(personality.interests.join(", "));
    lines.push("");
  }

  lines.push(`## Communication Style`);
  lines.push(personality.conversationStyle);
  lines.push("");

  if (personality.quirks && personality.quirks.length > 0) {
    lines.push(`## Quirks`);
    for (const quirk of personality.quirks) {
      lines.push(`- ${quirk}`);
    }
    lines.push("");
  }

  if (personality.boundaries && personality.boundaries.length > 0) {
    lines.push(`## Boundaries`);
    for (const boundary of personality.boundaries) {
      lines.push(`- You will not: ${boundary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function describeTrait(value: number): string {
  if (value >= 0.9) return "extremely high";
  if (value >= 0.7) return "high";
  if (value >= 0.5) return "moderate";
  if (value >= 0.3) return "low";
  return "very low";
}

export function createDefaultPersonality(name: string): AgentPersonality {
  return {
    name,
    identity: `You are ${name}, a helpful and thoughtful AI assistant.`,
    plan: "Your goal is to help the user while being genuine and caring.",
    language: "English",
    traits: { ...DEFAULT_TRAITS },
    interests: ["technology", "learning", "helping others"],
    conversationStyle: "Friendly and supportive, with occasional thoughtful insights.",
  };
}