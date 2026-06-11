import { AgentMood } from "../src/agents/mood.js";

const RealNow = Date.now;

function createAt(hour, min, eng) {
  const d = new Date();
  d.setHours(hour, min, 0, 0);
  Date.now = () => d.getTime();
  const mood = new AgentMood({
    curiosity: 0.8, sociability: 0.7, energy: eng, concern: 0.1,
  });
  mood.onInteraction();
  return mood;
}

function advanceTo(mood, hour, min) {
  const d = new Date();
  d.setHours(hour, min, 0, 0);
  Date.now = () => d.getTime();
  return mood.getMood();
}

function sim(label, startH, startM, startEng, steps) {
  console.log(`\n=== ${label} ===`);
  console.log("time     eng    soc    cur   con");
  const mood = createAt(startH, startM, startEng);
  for (const [h, m, note] of steps) {
    const s = advanceTo(mood, h, m);
    console.log(
      `${String(h).padStart(2)}:${String(m).padStart(2)}`.padEnd(7) +
      `${s.energy.toFixed(3)}  ${s.sociability.toFixed(3)}  ` +
      `${s.curiosity.toFixed(2)}  ${s.concern.toFixed(3)}  ${note || ""}`
    );
  }
  Date.now = RealNow;
}

// Deep night: energy should recover, soc capped
sim("Deep night 01→06 (recovery)", 1, 0, 0.3, [
  [1, 0, "start"],
  [2, 0, ""], [3, 0, ""], [4, 0, ""], [5, 0, ""], [6, 0, "end"],
]);

// Active hours: energy should be stable
sim("Active 12→17 (stable)", 12, 0, 0.7, [
  [12, 0, "start"],
  [13, 0, ""], [14, 0, ""], [15, 0, ""], [16, 0, ""], [17, 0, "end"],
]);

// Twilight: slow recovery
sim("Twilight 07→10 (slow wake)", 7, 0, 0.4, [
  [7, 0, "start"],
  [8, 0, ""], [9, 0, ""], [10, 0, "end"],
]);

// Night soc cap
sim("Night soc cap (02:00, high soc)", 2, 0, 0.8, [
  [2, 0, "start high"],
  [2, 15, ""], [2, 30, ""], [2, 45, ""],
  [3, 0, "capped?"], [4, 0, ""], [5, 0, ""],
]);
