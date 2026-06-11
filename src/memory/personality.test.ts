import { describe, expect, it } from "vitest";
import {
  createDefaultPersonality,
  buildPersonalityPrompt,
  validateTraits,
  DEFAULT_TRAITS,
} from "../agents/personality.js";
import type { PersonalityTraits } from "../agents/personality.js";

describe("AgentPersonality", () => {
  it("creates default personality", () => {
    const persona = createDefaultPersonality("TestBot");
    expect(persona.name).toBe("TestBot");
    expect(persona.traits.curiosity).toBe(0.7);
    expect(persona.traits.sociability).toBe(0.6);
    expect(persona.interests).toContain("technology");
  });

  it("builds personality prompt", () => {
    const persona = createDefaultPersonality("Helper");
    const prompt = buildPersonalityPrompt(persona);

    expect(prompt).toContain("Your Identity");
    expect(prompt).toContain("Helper");
    expect(prompt).toContain("Your Plan");
    expect(prompt).toContain("Personality Traits");
    expect(prompt).toContain("Curiosity: high");
    expect(prompt).toContain("Interests");
    expect(prompt).toContain("Communication Style");
  });

  it("includes quirks and boundaries when present", () => {
    const persona = {
      ...createDefaultPersonality("BoundaryBot"),
      quirks: ["uses puns constantly", "collects facts about cheese"],
      boundaries: ["discuss politics", "share personal data"],
    };
    const prompt = buildPersonalityPrompt(persona);

    expect(prompt).toContain("Quirks");
    expect(prompt).toContain("uses puns constantly");
    expect(prompt).toContain("collects facts about cheese");
    expect(prompt).toContain("Boundaries");
    expect(prompt).toContain("share personal data");
  });

  it("does not include optional sections when empty", () => {
    const persona = createDefaultPersonality("Simple");
    persona.interests = [];
    const prompt = buildPersonalityPrompt(persona);

    expect(prompt).not.toContain("## Your Interests");
    expect(prompt).not.toContain("## Quirks");
    expect(prompt).not.toContain("## Boundaries");
  });

  it("validateTraits clamps out of range values", () => {
    const bad: PersonalityTraits = {
      curiosity: 2.5,
      sociability: -1,
      conscientiousness: 0.5,
      playfulness: 1.5,
      formality: -0.3,
    };
    const clamped = validateTraits(bad);

    expect(clamped.curiosity).toBe(1);
    expect(clamped.sociability).toBe(0);
    expect(clamped.conscientiousness).toBe(0.5);
    expect(clamped.playfulness).toBe(1);
    expect(clamped.formality).toBe(0);
  });

  it("DEFAULT_TRAITS are all in valid range", () => {
    const validated = validateTraits(DEFAULT_TRAITS);
    for (const key of Object.keys(validated) as (keyof PersonalityTraits)[]) {
      expect(validated[key]).toBeGreaterThanOrEqual(0);
      expect(validated[key]).toBeLessThanOrEqual(1);
    }
  });

  it("buildPersonalityPrompt describes all trait levels", () => {
    const persona = {
      ...createDefaultPersonality("TraitBot"),
      traits: {
        curiosity: 0.95,
        sociability: 0.75,
        conscientiousness: 0.55,
        playfulness: 0.35,
        formality: 0.15,
      },
    };

    const prompt = buildPersonalityPrompt(persona);
    expect(prompt).toContain("Curiosity: extremely high");
    expect(prompt).toContain("Sociability: high");
    expect(prompt).toContain("Conscientiousness: moderate");
    expect(prompt).toContain("Playfulness: low");
    expect(prompt).toContain("Formality: very low");
  });
});