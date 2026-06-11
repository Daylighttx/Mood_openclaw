import { AgentMood } from "../src/agents/mood.js";

const RealNow = Date.now.bind(Date);
let tick = 0;
Date.now = () => RealNow() + tick * 60_000;

function step(n) { tick += n; }
function check(mood, label) {
  const s = mood.getMood();
  console.log(`  ${label}: soc=${s.sociability.toFixed(3)} cur=${s.curiosity.toFixed(3)} con=${s.concern.toFixed(3)} eng=${s.energy.toFixed(3)}`);
}

// Pre-condition: idle for many hours so concern is high
console.log("=== P3: Pre-idle 10h → high concern → then check coupling ===");
const m1 = new AgentMood({ curiosity:0.8, sociability:0.9, energy:0.8, concern:0.1 });
m1.onInteraction();
step(10 * 60); // 10 hours idle → concern should be near 1.0
const s = m1.getMood();
console.log(`  after 10h idle: soc=${s.sociability.toFixed(3)} con=${s.concern.toFixed(3)}`);
console.log("  → coupling should be active: soc being pulled toward 0.3");
step(30); // 30 more minutes
check(m1, "+30min");

// Excited state: need concern low, energy+soc high
console.log("\n=== P3: Excited (long idle → soc=1.0, eng still high) ===");
tick = 0;
const m2 = new AgentMood({ curiosity:0.3, sociability:0.7, energy:0.9, concern:0.1 });
m2.onInteraction();
step(45); // 45 min idle → soc should be close to 1.0 from S-curve
check(m2, "45min idle");
step(15);
check(m2, "+15min (cur boosted?)");

// Anxiety: pre-idle long enough for concern to rise, but energy stays low
console.log("\n=== P3: Anxiety (idle 6h, eng starting low) ===");
tick = 0;
const m3 = new AgentMood({ curiosity:0.4, sociability:0.7, energy:0.3, concern:0.1 });
m3.onInteraction();
step(6 * 60); // 6h → concern should be ~0.55
const s36 = m3.getMood();
console.log(`  after 6h: soc=${s36.sociability.toFixed(3)} con=${s36.concern.toFixed(3)} eng=${s36.energy.toFixed(3)}`);
// concern > 0.6, eng < 0.25 → anxiety coupling
if (s36.concern > 0.6 && s36.energy < 0.25) {
  console.log("  → anxiety coupling active: soc↓ toward 0.2, cur↑ toward 0.6");
} else {
  console.log("  → anxiety coupling NOT active (con=" + s36.concern.toFixed(3) + " eng=" + s36.energy.toFixed(3) + ")");
}
step(30);
check(m3, "+30min");

Date.now = RealNow;
