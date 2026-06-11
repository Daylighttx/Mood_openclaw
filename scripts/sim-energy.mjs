import { AgentMood } from "../src/agents/mood.js";

const OrigNow = Date.now;
function fakeTime(minutes) {
  Date.now = () => OrigNow() + minutes * 60_000;
}

function realTime() {
  Date.now = OrigNow;
}

// Scenario A: idle 4 hours, no interaction
console.log("=== Energy: Idle 4h (no interaction) ===");
console.log("hour  energy  activate?  proactive?");
const moodA = new AgentMood({ curiosity: 0.8, sociability: 0.7, energy: 1.0, concern: 0.1 });
for (let h = 0; h <= 4; h++) {
  fakeTime(h * 60);
  const m = moodA.getMood();
  const drive = m.curiosity * 0.4 + m.sociability * 0.3 + m.energy * 0.3;
  const act = drive > 0.3 && m.energy > 0.15;
  const pro = (m.sociability * 0.5 + m.curiosity * 0.25 + m.concern * 0.25) > 0.55 && m.energy > 0.2;
  console.log("  " + String(h).padStart(2) + "h   " + m.energy.toFixed(3) + "    " + String(act).padEnd(5) + "    " + String(pro));
}
realTime();

// Scenario B: busy chat then idle
console.log("\n=== Energy: Chat(0,5,10,15min) then idle ===");
const moodB = new AgentMood({ curiosity: 0.8, sociability: 0.7, energy: 1.0, concern: 0.1 });
let base = 0;
for (const m of [0, 5, 10, 15]) {
  fakeTime(m);
  moodB.onInteraction();
}
base = 15;
for (let h = 0; h <= 4; h++) {
  fakeTime(base + h * 60);
  const s = moodB.getMood();
  console.log("  " + String(h).padStart(2) + "h   " + s.energy.toFixed(3) + "  (after 4 chats)");
}
realTime();

// Scenario C: decay vs recovery
const decayPerMin = 60_000 / (4 * 3600_000);
const recPerMin = 60_000 / (1 * 3600_000) * 0.25;
console.log("\n=== Energy: decay vs recovery balance ===");
console.log("  decay/min: " + decayPerMin.toFixed(5));
console.log("  recov/min: " + recPerMin.toFixed(5));
console.log("  net/idle:  " + (recPerMin - decayPerMin).toFixed(6) + "  (0 = stable)");
console.log("  onInteraction cost: -0.05 per chat");
console.log("  After 4 chats: eng = 1.0 - 0.20 = 0.80 → stays at 0.80 while idle");
console.log("  shouldActivate: energy>0.15 ✓ always (unless very chatty)");
console.log("  shouldProactivelyMessage: energy>0.2 ✓ always");
