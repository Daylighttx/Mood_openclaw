import type { PersonalityTraits } from "./personality.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface MoodState {
  curiosity: number;
  sociability: number;
  energy: number;
  concern: number;
}

export interface MoodBaselines {
  curiosity: number;
  sociability: number;
  energy: number;
  concern: number;
}

export interface MoodDeltas {
  curiosity?: number;
  sociability?: number;
  energy?: number;
  concern?: number;
}

export interface MoodConfig {
  decayRate: number;
  idleCuriosityRise: number;
  idleSociabilityRiseMs: number;
  idleConcernRiseMs: number;
  energyDecayMs: number;
  energyRecoveryMs: number;
  postInteractionCooldownMs: number;
  sCurveMultiplier?: number;
  sCurvePeakMinutes?: number;
  neglectCuriosityPenalty?: number;
  nightSocCap?: number;
  curiosityIdleDecayStartMin?: number;
  curiosityIdleDecayDurationMin?: number;
  curiosityIdleDecayMaxDrop?: number;
  curiosityIdleDecayFloor?: number;
  concernRiseStartMin?: number;
  concernRiseDurationMin?: number;
  concernMax?: number;
  concernBaseline?: number;
  nightStartHour?: number;
  nightEndHour?: number;
  twilightMorningEnd?: number;
  twilightEveningStart?: number;
  nightDecayMultiplier?: number;
  nightRecoveryMultiplier?: number;
  twilightDecayMultiplier?: number;
  twilightRecoveryMultiplier?: number;
  energyRecoveryCoeff?: number;
  onInteractionSocMult?: number;
  onInteractionCurMult?: number;
  onInteractionConMult?: number;
  onInteractionEngCost?: number;
  couplingHighConcernThreshold?: number;
  couplingHighConcernSocTarget?: number;
  couplingExcitedEngThreshold?: number;
  couplingExcitedSocThreshold?: number;
  couplingAnxiousEngThreshold?: number;
  couplingAnxiousConThreshold?: number;
}

export const DEFAULT_MOOD_CONFIG: MoodConfig = {
  decayRate: 0.003,
  idleCuriosityRise: 0.15,
  idleSociabilityRiseMs: 30 * 60 * 1000,
  idleConcernRiseMs: 2 * 60 * 60 * 1000,
  energyDecayMs: 4 * 60 * 60 * 1000,
  energyRecoveryMs: 1 * 60 * 60 * 1000,
  postInteractionCooldownMs: 15 * 60 * 1000,
  sCurveMultiplier: 0.08,
  sCurvePeakMinutes: 30,
  neglectCuriosityPenalty: 0.3,
  nightSocCap: 0.5,
  curiosityIdleDecayStartMin: 30,
  curiosityIdleDecayDurationMin: 120,
  curiosityIdleDecayMaxDrop: 0.5,
  curiosityIdleDecayFloor: 0.2,
  concernRiseStartMin: 120,
  concernRiseDurationMin: 480,
  concernMax: 0.9,
  concernBaseline: 0.1,
  nightStartHour: 0,
  nightEndHour: 6,
  twilightMorningEnd: 10,
  twilightEveningStart: 22,
  nightDecayMultiplier: 0.2,
  nightRecoveryMultiplier: 2.0,
  twilightDecayMultiplier: 0.6,
  twilightRecoveryMultiplier: 1.2,
  energyRecoveryCoeff: 0.25,
  onInteractionSocMult: 0.85,
  onInteractionCurMult: 0.95,
  onInteractionConMult: 0.95,
  onInteractionEngCost: 0.05,
  couplingHighConcernThreshold: 0.8,
  couplingHighConcernSocTarget: 0.3,
  couplingExcitedEngThreshold: 0.7,
  couplingExcitedSocThreshold: 0.7,
  couplingAnxiousEngThreshold: 0.25,
  couplingAnxiousConThreshold: 0.6,
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(from: number, to: number, t: number): number {
  return clamp(from + (to - from) * t);
}

export class AgentMood {
  private state: MoodState;
  private baselines: MoodBaselines;
  private config: MoodConfig;
  private lastUpdatedAt: number;
  private lastInteractionAt: number;
  _pendingMessagesSinceLastReply: number = 0;

  constructor(
    baselines: MoodBaselines,
    config?: Partial<MoodConfig>,
    initialState?: Partial<MoodState>,
  ) {
    this.baselines = {
      curiosity: baselines.curiosity,
      sociability: baselines.sociability,
      energy: baselines.energy ?? 1.0,
      concern: baselines.concern ?? 0.1,
    };

    this.config = { ...DEFAULT_MOOD_CONFIG, ...config };

    const now = Date.now();
    this.lastUpdatedAt = now;
    this.lastInteractionAt = now;

    this.state = {
      curiosity: initialState?.curiosity ?? baselines.curiosity,
      sociability: initialState?.sociability ?? baselines.sociability,
      energy: initialState?.energy ?? baselines.energy ?? 1.0,
      concern: initialState?.concern ?? baselines.concern ?? 0.1,
    };
  }

  private advanceTime(now: number): void {
    const elapsed = now - this.lastUpdatedAt;
    if (elapsed <= 0) return;

    const t = Math.min(this.config.decayRate * (elapsed / 1000), 1);
    const idleSinceInteraction = now - this.lastInteractionAt;
    const idleMinutes = idleSinceInteraction / 60_000;

    let curiosityTarget = this.baselines.curiosity;
    let sociabilityBonus = 0;

    if (idleSinceInteraction > 0 && this.lastInteractionAt > 0) {
      const raw = idleMinutes / (this.config.sCurvePeakMinutes ?? 30);
      const curve = raw * Math.exp(1 - raw);
      sociabilityBonus = Math.max(0, curve * this.baselines.sociability * (this.config.sCurveMultiplier ?? 0.08));

      const concernMinutes = idleMinutes;
      if (concernMinutes > (this.config.curiosityIdleDecayStartMin ?? 30)) {
        curiosityTarget =
          (this.baselines.curiosity) -
          Math.min(
            (concernMinutes - (this.config.curiosityIdleDecayStartMin ?? 30)) /
              (this.config.curiosityIdleDecayDurationMin ?? 120),
            1,
          ) *
            (this.config.curiosityIdleDecayMaxDrop ?? 0.5);
        if (curiosityTarget < (this.config.curiosityIdleDecayFloor ?? 0.2))
          curiosityTarget = (this.config.curiosityIdleDecayFloor ?? 0.2);
      }

      if (concernMinutes > (this.config.concernRiseStartMin ?? 120)) {
        const targetConcern =
          (this.config.concernBaseline ?? 0.1) +
          Math.min(
            (concernMinutes - (this.config.concernRiseStartMin ?? 120)) /
              (this.config.concernRiseDurationMin ?? 480),
            1,
          ) *
            (this.config.concernMax ?? 0.9);
        this.state.concern = lerp(this.state.concern, targetConcern, t);
      } else {
        this.state.concern = lerp(this.state.concern, (this.config.concernBaseline ?? 0.1), t);
      }
    } else {
      this.state.concern = lerp(this.state.concern, (this.config.concernBaseline ?? 0.1), t);
    }

    this.state.curiosity = lerp(this.state.curiosity, curiosityTarget, t);
    if (idleSinceInteraction > 0 && this._pendingMessagesSinceLastReply > 0) {
      const idleSec = idleSinceInteraction / 1000;
      if (idleSec > 3600) {
        const neglectFactor = Math.min((idleSec - 3600) / 7200, 1);
        this.state.curiosity = clamp(this.state.curiosity - neglectFactor * (this.config.neglectCuriosityPenalty ?? 0.3) * t);
      }
    }
    if (this.state.curiosity < 0.1) this.state.curiosity = 0.1;
    this.state.sociability = lerp(this.state.sociability, this.baselines.sociability, t);
    if (sociabilityBonus > 0) {
      this.state.sociability = clamp(this.state.sociability + sociabilityBonus);
    }
    if (this.state.sociability < 0.1) this.state.sociability = 0.1;

    const hour = new Date(now).getHours();
    const isDeepNight =
      hour >= (this.config.nightStartHour ?? 0) && hour < (this.config.nightEndHour ?? 6);
    const isTwilight =
      (hour >= (this.config.nightEndHour ?? 6) && hour < (this.config.twilightMorningEnd ?? 10)) ||
      (hour >= (this.config.twilightEveningStart ?? 22));
    let decayMultiplier = 1.0;
    let recoveryMultiplier = 1.0;
    if (isDeepNight) {
      decayMultiplier = (this.config.nightDecayMultiplier ?? 0.2);
      recoveryMultiplier = (this.config.nightRecoveryMultiplier ?? 2.0);
    } else if (isTwilight) {
      decayMultiplier = (this.config.twilightDecayMultiplier ?? 0.6);
      recoveryMultiplier = (this.config.twilightRecoveryMultiplier ?? 1.2);
    }

    if (isDeepNight && this.state.sociability > (this.config.nightSocCap ?? 0.5)) {
      this.state.sociability = lerp(this.state.sociability, (this.config.nightSocCap ?? 0.5), t);
    }

    const energyDecay = elapsed / this.config.energyDecayMs * decayMultiplier;
    this.state.energy = clamp(this.state.energy - energyDecay);

    const energyRecoveryFromRest =
      elapsed / this.config.energyRecoveryMs * (this.config.energyRecoveryCoeff ?? 0.25) * recoveryMultiplier;
    this.state.energy = clamp(this.state.energy + energyRecoveryFromRest);

    if (this.state.concern > (this.config.couplingHighConcernThreshold ?? 0.8)) {
      this.state.sociability = lerp(this.state.sociability, (this.config.couplingHighConcernSocTarget ?? 0.3), t * 0.5);
    }
    if (
      this.state.energy > (this.config.couplingExcitedEngThreshold ?? 0.7) &&
      this.state.sociability > (this.config.couplingExcitedSocThreshold ?? 0.7)
    ) {
      this.state.curiosity = lerp(this.state.curiosity, Math.max(this.state.curiosity, 0.5), t * 0.3);
    }
    if (
      this.state.energy < (this.config.couplingAnxiousEngThreshold ?? 0.25) &&
      this.state.concern > (this.config.couplingAnxiousConThreshold ?? 0.6)
    ) {
      this.state.sociability = lerp(this.state.sociability, 0.2, t * 0.5);
      this.state.curiosity = lerp(this.state.curiosity, Math.max(this.state.curiosity, 0.6), t * 0.2);
    }

    this.lastUpdatedAt = now;
  }

  getMood(): MoodState {
    this.advanceTime(Date.now());
    return { ...this.state };
  }

  applyDelta(delta: MoodDeltas): void {
    this.advanceTime(Date.now());

    if (delta.curiosity !== undefined) {
      this.state.curiosity = clamp(this.state.curiosity + delta.curiosity);
    }
    if (delta.sociability !== undefined) {
      this.state.sociability = clamp(this.state.sociability + delta.sociability);
    }
    if (delta.energy !== undefined) {
      this.state.energy = clamp(this.state.energy + delta.energy);
    }
    if (delta.concern !== undefined) {
      this.state.concern = clamp(this.state.concern + delta.concern);
    }

    this.lastUpdatedAt = Date.now();
  }

  onInteraction(): void {
    const now = Date.now();
    this.advanceTime(now);
    this.lastInteractionAt = now;

    // Reduce social drive during conversation, but never below floor
    this.state.sociability = clamp(this.state.sociability * (this.config.onInteractionSocMult ?? 0.85));
    if (this.state.sociability < 0.15) this.state.sociability = 0.15;
    // Curiosity gets a small dip, but not asymptotically to 0
    this.state.curiosity = clamp(this.state.curiosity * (this.config.onInteractionCurMult ?? 0.95));
    if (this.state.curiosity < 0.2) this.state.curiosity = 0.2;
    this.state.concern = clamp(this.state.concern * (this.config.onInteractionConMult ?? 0.95));
    if (this.state.concern < 0.05) this.state.concern = 0.05;
    this.state.energy = clamp(this.state.energy - (this.config.onInteractionEngCost ?? 0.05));

    this.lastUpdatedAt = now;
  }

  onRest(durationMs: number): void {
    const recovery = durationMs / this.config.energyRecoveryMs;
    this.state.energy = clamp(this.state.energy + recovery);
    this.lastUpdatedAt = Date.now();
  }

  onImportantEvent(importance: number): void {
    const impact = importance / 9;
    this.state.curiosity = clamp(this.state.curiosity + impact * 0.2);
    this.state.concern = clamp(this.state.concern + impact * 0.15);
    this.state.energy = clamp(this.state.energy + impact * 0.1);
    this.lastUpdatedAt = Date.now();
  }

  onReflection(): void {
    this.state.curiosity = clamp(this.state.curiosity + 0.1);
    this.state.energy = clamp(this.state.energy + 0.05);
    this.lastUpdatedAt = Date.now();
  }

  onSuppressed(count: number): void {
    const dampening = Math.min(count * 0.01, 0.3);
    this.state.sociability = clamp(this.state.sociability - dampening);
    this.state.curiosity = clamp(this.state.curiosity - dampening * 0.5);
    this.lastUpdatedAt = Date.now();
  }

  markProactiveSent(): void {
    this._pendingMessagesSinceLastReply++;
  }

  markUserReplied(): void {
    this._pendingMessagesSinceLastReply = 0;
  }

  getConfig(): Partial<MoodConfig> {
    return { ...this.config };
  }

  applyConfigDelta(delta: Partial<MoodConfig>): void {
    for (const [key, val] of Object.entries(delta)) {
      if (val !== undefined) {
        (this.config as unknown as Record<string, unknown>)[key] = val;
      }
    }
  }

  shouldProactivelyMessage(): boolean {
    const mood = this.getMood();
    const now = Date.now();

    if (this.lastInteractionAt > 0) {
      const timeSinceInteraction = now - this.lastInteractionAt;
      if (timeSinceInteraction < this.config.postInteractionCooldownMs) {
        return false;
      }
    }

    const desireToMessage = mood.sociability * 0.5 + mood.curiosity * 0.25 + mood.concern * 0.25;

    return desireToMessage > 0.55 && mood.energy > 0.2;
  }

  getProactiveUrgency(): number {
    const mood = this.getMood();
    const desire = mood.sociability * 0.5 + mood.curiosity * 0.25 + mood.concern * 0.25;
    return Math.max(0, Math.min(1, (desire - 0.5) * 2));
  }

  getLastInteractionAt(): number {
    return this.lastInteractionAt;
  }

  getMoodDescription(): string {
    const mood = this.getMood();
    const { curiosity, sociability, energy, concern } = mood;

    if (sociability > 0.85 && energy < 0.25) return "restless — wants to connect but exhausted";
    if (sociability > 0.85 && energy > 0.7) return "eager to chat, full of energy";
    if (concern > 0.7 && energy < 0.3) return "anxious and drained";
    if (concern > 0.5 && sociability < 0.3) return "worried, preferring solitude";
    if (curiosity < 0.3 && sociability > 0.7) return "chatty but not intellectually engaged";
    if (curiosity > 0.7 && sociability < 0.3) return "deep in thought, doesn't want to talk";
    if (energy < 0.2) return "exhausted, needs rest";
    if (energy > 0.9 && curiosity > 0.7) return "bright and inquisitive";

    const parts: string[] = [];
    if (sociability > 0.7) parts.push("sociable");
    else if (sociability < 0.3) parts.push("withdrawn");
    if (curiosity > 0.7) parts.push("curious");
    else if (curiosity < 0.3) parts.push("indifferent");
    if (energy < 0.3) parts.push("tired");
    else if (energy > 0.8) parts.push("energetic");
    if (concern > 0.5) parts.push("uneasy");
    if (parts.length === 0) parts.push("balanced");
    return parts.join(", ");
  }

  serialize(): string {
    return JSON.stringify({
      state: this.state,
      baselines: this.baselines,
      config: this.config,
      lastUpdatedAt: this.lastUpdatedAt,
      lastInteractionAt: this.lastInteractionAt,
    });
  }

  static deserialize(json: string): AgentMood {
    const data = JSON.parse(json);
    const mood = new AgentMood(data.baselines, data.config, data.state);
    mood.lastUpdatedAt = data.lastUpdatedAt;
    mood.lastInteractionAt = data.lastInteractionAt;
    return mood;
  }

  static fromTraits(traits: PersonalityTraits, config?: Partial<MoodConfig>): AgentMood {
    return new AgentMood(
      {
        curiosity: traits.curiosity,
        sociability: traits.sociability,
        energy: 1.0,
        concern: 0.1,
      },
      config,
    );
  }
}