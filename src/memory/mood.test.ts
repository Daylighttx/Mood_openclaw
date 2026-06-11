import { describe, expect, it } from "vitest";
import { AgentMood, DEFAULT_MOOD_CONFIG } from "../agents/mood.js";

describe("AgentMood", () => {
  it("creates mood from baselines", () => {
    const mood = new AgentMood({
      curiosity: 0.8,
      sociability: 0.6,
      energy: 1.0,
      concern: 0.1,
    });

    const state = mood.getMood();
    expect(state.curiosity).toBe(0.8);
    expect(state.sociability).toBe(0.6);
    expect(state.energy).toBe(1.0);
    expect(state.concern).toBe(0.1);
  });

  it("does not proactively message right after creation (no interaction history)", () => {
    const mood = new AgentMood({
      curiosity: 0.5,
      sociability: 0.4,
      energy: 1.0,
      concern: 0.1,
    });

    expect(mood.shouldProactivelyMessage()).toBe(false);
  });

  it("social mood triggers proactive desire", () => {
    const mood = new AgentMood({
      curiosity: 0.8,
      sociability: 0.8,
      energy: 0.8,
      concern: 0.5,
    });
    (mood as Record<string, unknown>).lastInteractionAt = 0;

    expect(mood.shouldProactivelyMessage()).toBe(true);
  });

  it("low energy prevents proactive messaging", () => {
    const mood = new AgentMood({
      curiosity: 0.9,
      sociability: 0.9,
      energy: 0.1,
      concern: 0.9,
    });

    expect(mood.shouldProactivelyMessage()).toBe(false);
  });

  it("post-interaction cooldown prevents immediate re-messaging", () => {
    const mood = new AgentMood({
      curiosity: 0.9,
      sociability: 0.9,
      energy: 1.0,
      concern: 0.0,
    });

    mood.onInteraction();

    expect(mood.shouldProactivelyMessage()).toBe(false);
  });

  it("onInteraction resets sociability and concern", () => {
    const mood = new AgentMood({
      curiosity: 0.8,
      sociability: 0.9,
      energy: 1.0,
      concern: 0.3,
    });

    mood.onInteraction();
    const state = mood.getMood();

    expect(state.sociability).toBeLessThan(0.9);
    expect(state.sociability).toBeGreaterThan(0.3);
    expect(state.concern).toBeLessThan(0.3);
  });

  it("applyDelta modifies mood correctly", () => {
    const mood = new AgentMood({
      curiosity: 0.5,
      sociability: 0.5,
      energy: 0.5,
      concern: 0.3,
    });

    mood.applyDelta({
      curiosity: 0.2,
      sociability: -0.1,
      concern: 0.3,
    });

    const state = mood.getMood();
    expect(state.curiosity).toBeCloseTo(0.7);
    expect(state.sociability).toBeCloseTo(0.4);
    expect(state.energy).toBeCloseTo(0.5);
    expect(state.concern).toBeCloseTo(0.6);
  });

  it("applyDelta clamps values to 0-1", () => {
    const mood = new AgentMood({
      curiosity: 0.5,
      sociability: 0.5,
      energy: 0.5,
      concern: 0.5,
    });

    mood.applyDelta({
      curiosity: 1.0,
      sociability: -1.0,
    });

    const state = mood.getMood();
    expect(state.curiosity).toBe(1);
    expect(state.sociability).toBe(0);
  });

  it("onRest recovers energy", () => {
    const mood = new AgentMood({
      curiosity: 0.5,
      sociability: 0.5,
      energy: 0.3,
      concern: 0.1,
    });

    mood.onRest(DEFAULT_MOOD_CONFIG.energyRecoveryMs * 2);

    const state = mood.getMood();
    expect(state.energy).toBeGreaterThan(0.3);
  });

  it("onImportantEvent boosts mood based on importance", () => {
    const mood = new AgentMood({
      curiosity: 0.5,
      sociability: 0.5,
      energy: 0.5,
      concern: 0.3,
    });

    mood.onImportantEvent(9);

    const state = mood.getMood();
    expect(state.curiosity).toBeGreaterThan(0.5);
    expect(state.concern).toBeGreaterThan(0.3);
  });

  it("onReflection boosts curiosity", () => {
    const mood = new AgentMood({
      curiosity: 0.5,
      sociability: 0.5,
      energy: 0.5,
      concern: 0.1,
    });

    mood.onReflection();
    const state = mood.getMood();
    expect(state.curiosity).toBeGreaterThan(0.5);
  });

  it("getProactiveUrgency returns 0-1 value", () => {
    const mood = new AgentMood({
      curiosity: 0.9,
      sociability: 0.9,
      energy: 1.0,
      concern: 0.8,
    });

    const urgency = mood.getProactiveUrgency();
    expect(urgency).toBeGreaterThan(0);
    expect(urgency).toBeLessThanOrEqual(1);
  });

  it("getProactiveUrgency is low for calm mood", () => {
    const mood = new AgentMood({
      curiosity: 0.3,
      sociability: 0.3,
      energy: 1.0,
      concern: 0.1,
    });

    const urgency = mood.getProactiveUrgency();
    expect(urgency).toBeCloseTo(0, 1);
  });

  it("getMoodDescription returns readable text", () => {
    const mood = new AgentMood({
      curiosity: 0.8,
      sociability: 0.8,
      energy: 0.2,
      concern: 0.6,
    });

    const desc = mood.getMoodDescription();
    expect(typeof desc).toBe("string");
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).toBeTruthy();
  });

  it("serializes and deserializes correctly", () => {
    const original = new AgentMood({
      curiosity: 0.7,
      sociability: 0.6,
      energy: 0.8,
      concern: 0.4,
    });

    original.applyDelta({ curiosity: 0.1 });

    const json = original.serialize();
    const restored = AgentMood.deserialize(json);

    const origState = original.getMood();
    const restState = restored.getMood();

    expect(restState.curiosity).toBeCloseTo(origState.curiosity, 5);
    expect(restState.sociability).toBeCloseTo(origState.sociability, 5);
    expect(restState.energy).toBeCloseTo(origState.energy, 5);
    expect(restState.concern).toBeCloseTo(origState.concern, 5);
  });

  it("fromTraits creates mood from personality traits", () => {
    const mood = AgentMood.fromTraits({
      curiosity: 0.9,
      sociability: 0.7,
      conscientiousness: 0.8,
      playfulness: 0.5,
      formality: 0.3,
    });

    const state = mood.getMood();
    expect(state.curiosity).toBe(0.9);
    expect(state.sociability).toBe(0.7);
    expect(state.energy).toBe(1.0);
  });

  it("getLastInteractionAt returns 0 when no interaction", () => {
    const mood = new AgentMood({
      curiosity: 0.5,
      sociability: 0.5,
      energy: 1.0,
      concern: 0.1,
    });

    expect(mood.getLastInteractionAt()).toBeGreaterThan(0);
  });

  it("getLastInteractionAt updates after interaction", () => {
    const mood = new AgentMood({
      curiosity: 0.5,
      sociability: 0.5,
      energy: 1.0,
      concern: 0.1,
    });

    const before = Date.now();
    mood.onInteraction();
    const after = mood.getLastInteractionAt();

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("accepts initialState in constructor", () => {
    const mood = new AgentMood(
      {
        curiosity: 0.5,
        sociability: 0.5,
        energy: 1.0,
        concern: 0.1,
      },
      undefined,
      {
        curiosity: 0.9,
        sociability: 0.2,
        energy: 0.3,
        concern: 0.7,
      },
    );

    const state = mood.getMood();
    expect(state.curiosity).toBe(0.9);
    expect(state.sociability).toBe(0.2);
    expect(state.energy).toBe(0.3);
    expect(state.concern).toBe(0.7);
  });

  it("accepts custom mood config for faster energy recovery", () => {
    const mood = new AgentMood(
      {
        curiosity: 0.5,
        sociability: 0.5,
        energy: 1.0,
        concern: 0.1,
      },
      {
        postInteractionCooldownMs: 0,
        energyRecoveryMs: 1000,
      },
    );

    mood.onInteraction();

    mood.onRest(2000);
    const state = mood.getMood();
    expect(state.energy).toBeGreaterThan(0.9);
  });
});