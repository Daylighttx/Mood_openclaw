import { AgentMood } from "../src/agents/mood.js";

const OrigNow = Date.now;
function fakeTime(minutes) {
  Date.now = () => OrigNow() + minutes * 60_000;
}

const mood = new AgentMood({ curiosity: 0.8, sociability: 0.7, energy: 1.0, concern: 0.1 });
fakeTime(0);
mood.onInteraction();

console.log("=== Concern over long idle (lerp) ===");
console.log("hour  concern  target");
for (let h = 0; h <= 24; h += 1) {
  fakeTime(h * 60);
  const m = mood.getMood();
  const idleM = (h * 60);
  const target = idleM > 120
    ? 0.1 + Math.min((idleM - 120) / 480, 1) * 0.9
    : 0.1;
  console.log("  " + String(h).padStart(2) + "h   " + m.concern.toFixed(3) + "     " + target.toFixed(3));
}
Date.now = OrigNow;

console.log("\n=== Concern reset on interaction ===");
const mood2 = new AgentMood({ curiosity: 0.8, sociability: 0.7, energy: 1.0, concern: 0.1 });
fakeTime(0);
mood2.onInteraction();
fakeTime(10 * 60); // 10h idle
const before = mood2.getMood().concern;
console.log("  after 10h idle: " + before.toFixed(3));
fakeTime(10 * 60 + 1);
mood2.onInteraction();
const after = mood2.getMood().concern;
console.log("  after interaction: " + after.toFixed(3) + " (was " + before.toFixed(3) + ", ×0.95)");
Date.now = OrigNow;
