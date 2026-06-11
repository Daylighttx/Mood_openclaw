import { AgentMood } from "../src/agents/mood.js";

const RealNow = Date.now;

function createAt(hour, min) {
  const d = new Date();
  d.setHours(hour, min, 0, 0);
  Date.now = () => d.getTime();
  const mood = new AgentMood({
    curiosity: 0.8, sociability: 0.7, energy: 0.8, concern: 0.1,
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

console.log("=== P2: Neglect penalty ===");

// Case A: sent 1 message, no reply for 3h → curiosity should drop
console.log("Case A: Active hours, sent message, no reply 3h");
const mA = createAt(12, 0);
mA.markProactiveSent();
const s0 = advanceTo(mA, 12, 0);
console.log(`  12:00 cur=${s0.curiosity.toFixed(3)}  (after sending)`);

for (let h = 13; h <= 15; h++) {
  const s = advanceTo(mA, h, 0);
  console.log(`  ${h}:00  cur=${s.curiosity.toFixed(3)}`);
}

// Case B: sent 0 messages, just idle → no penalty
console.log("\nCase B: Idle 3h, no messages sent");
const mB = createAt(12, 0);
for (let h = 13; h <= 15; h++) {
  const s = advanceTo(mB, h, 0);
  console.log(`  ${h}:00  cur=${s.curiosity.toFixed(3)}`);
}

// Case C: sent messages, then user replies → penalty clears
console.log("\nCase C: Sent, 2h neglect, then user replies");
const mC = createAt(12, 0);
mC.markProactiveSent();
advanceTo(mC, 14, 0); // 2h idle with pending
const beforeReply = advanceTo(mC, 14, 1).curiosity;
console.log(`  14:00 cur=${beforeReply.toFixed(3)} (neglected)`);
mC.markUserReplied();
mC.onInteraction();
const afterReply = advanceTo(mC, 14, 2).curiosity;
console.log(`  14:02 cur=${afterReply.toFixed(3)} (after reply)`);

Date.now = RealNow;
