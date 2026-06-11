import { AgentMood } from "../src/agents/mood.js";
import { ProactiveThinkingLoop, DEFAULT_THINKING_CONFIG } from "../src/memory/thinking-loop.js";

function withTime(startMin, fn) {
  const realNow = Date.now;
  let tick = 0;
  Date.now = () => realNow() + tick * 60_000 - startMin * 60_000;
  try {
    return fn((idx) => { tick = idx; Date.now = () => realNow() + tick * 60_000 - startMin * 60_000; });
  } finally {
    Date.now = realNow;
  }
}

function simulate(minutes, events) {
  const baseline = {
    curiosity: 0.8,
    sociability: 0.7,
    energy: 1.0,
    concern: 0.1,
  };

  return withTime(0, (setTick) => {
    const mood = new AgentMood(baseline, {
      decayRate: 0.003,
      idleSociabilityRiseMs: 120_000,
      postInteractionCooldownMs: 60_000,
      energyDecayMs: 10 * 60 * 60 * 1000,
      energyRecoveryMs: 3 * 60 * 60 * 1000,
    });

    const loop = new ProactiveThinkingLoop({
      ...DEFAULT_THINKING_CONFIG,
      minIntervalMs: 60_000,
      maxProactivePerDay: 48,
      userBusyCooldownMs: 5 * 60_000,
      proactiveUrgencyThreshold: 0.35,
      llmActivationThreshold: 0.3,
    });

    const logs = [];
    let evIdx = 0;

    for (let m = 0; m < minutes; m++) {
      setTick(m);

      while (evIdx < events.length && events[evIdx].at === m) {
        const ev = events[evIdx++];
        if (ev.type === "interaction") {
          mood.onInteraction();
          loop.unansweredProactiveCount = 0;
          loop.userLastMessageAt = Date.now();
          loop.suppressedCount = 0;
        } else if (ev.type === "reflect") {
          mood.onReflection();
        }
      }

      const ms = mood.getMood();
      const lastInt = mood.getLastInteractionAt();
      const idleMin = lastInt > 0 ? Math.round((Date.now() - lastInt) / 60_000) : 0;

      logs.push({
        minute: m,
        idleMin: idleMin ? `${idleMin}m` : "-",
        curiosity: +ms.curiosity.toFixed(2),
        sociability: +ms.sociability.toFixed(3),
        energy: +ms.energy.toFixed(2),
        concern: +ms.concern.toFixed(2),
        activate: loop.shouldActivate(mood),
        proactive: mood.shouldProactivelyMessage(),
        urgency: +mood.getProactiveUrgency().toFixed(3),
      });
    }

    return logs;
  });
}

function report(name, logs) {
  console.log(`\n=== ${name} ===`);
  console.log("min  idle  cur   soc     ener  conc  act  pro  urg    note");
  console.log("-".repeat(72));

  let prevSoc = logs[0]?.sociability ?? 0;
  let peakSoc = prevSoc;
  let peakMin = 0;
  let passing = true;

  for (const l of logs) {
    const trend = l.sociability > prevSoc + 0.0005 ? "↑"
      : l.sociability < prevSoc - 0.0005 ? "↓" : " ";

    if (l.sociability > peakSoc) { peakSoc = l.sociability; peakMin = l.minute; }

    const note = [];
    if (l.minute === peakMin && peakSoc > 0.6 && l.minute > 0) note.push("PEAK");

    if (l.minute % 5 === 0 || note.length > 0) {
      console.log(
        `${String(l.minute).padStart(3)} ` +
        `${l.idleMin.padEnd(5)} ` +
        `${l.curiosity.toFixed(2)} ` +
        `${l.sociability.toFixed(3)}${trend} ` +
        `${l.energy.toFixed(2)}  ` +
        `${l.concern.toFixed(2)}  ` +
        `${String(l.activate)}`.padEnd(4) +
        `${l.proactive ? "1" : "0"}`.padEnd(4) +
        `${l.urgency.toFixed(3)} ` +
        `${note.join(" ") || trend}`
      );
    }
    prevSoc = l.sociability;
  }

  const final = logs[logs.length - 1];
  const afterPeak = logs.slice(peakMin);
  const declined = afterPeak.length > 5 && afterPeak[afterPeak.length - 1].sociability < peakSoc - 0.02;

  console.log(`\n→ Peak soc=${peakSoc.toFixed(3)} at min ${peakMin}, final soc=${final.sociability.toFixed(3)} |`);
  if (declined) console.log("  ✓ Decline works");
  else if (peakMin > 0 && logs.length - peakMin > 30) {
    console.log("  ✗ Still at peak after 30+ min — NEEDS FIX");
    passing = false;
  } else {
    console.log("  (ok — too short or no peak)");
  }
  return passing;
}

// S1: idle 2h
report("Idle 120min (no interaction)", simulate(120, []));

// S2: chat at 0, then idle
report("Chat then idle 120min", simulate(120, [{ at: 0, type: "interaction" }]));

// S3: busy chat then long idle
report("Busy chat then long idle", simulate(180, [
  { at: 1, type: "interaction" }, { at: 5, type: "interaction" },
  { at: 10, type: "interaction" }, { at: 15, type: "interaction" },
]));

// S4: suppressed
(function () {
  const results = [];
  const mood = new AgentMood({ curiosity: 0.8, sociability: 0.7, energy: 1.0, concern: 0.1 });
  console.log("\n=== onSuppressed (once per tick, consecutive) ===");
  for (let n = 1; n <= 30; n++) {
    mood.onSuppressed(1);
    results.push({ n, damp: +(n * 0.01).toFixed(3), soc: +mood.getMood().sociability.toFixed(3) });
  }
  for (const r of results.filter(r => r.n % 5 === 0 || r.n <= 3)) {
    console.log(`  n=${String(r.n).padStart(2)} damp=${r.damp} soc=${r.soc.toFixed(3)}`);
  }
  const last = results[results.length - 1];
  const ok = last.soc <= 0.5;
  console.log(`\n→ After 30: soc=${last.soc.toFixed(3)} (from 0.700) ${ok ? "✓" : "✗"}`);
})();

// S5: energy
(function () {
  console.log("\n=== Energy over time (no interaction) ===");
  withTime(0, (setTick) => {
    const mood = new AgentMood({ curiosity: 0.8, sociability: 0.7, energy: 0.7, concern: 0.1 });
    for (let h = 0; h <= 24; h++) {
      setTick(h * 60);
      const e = mood.getMood().energy;
      console.log(`  ${String(h).padStart(2)}h  energy=${e.toFixed(3)}`);
    }
    const final = mood.getMood().energy;
    console.log(`→ After 24h idle: energy=${final.toFixed(3)}`);
    console.log(final > 0.2 ? "  ✓ stays above 0.2" : "  ✗ too low");
  });
})();

// S6: concern rise
(function () {
  console.log("\n=== Concern over long idle ===");
  withTime(0, (setTick) => {
    const mood = new AgentMood({ curiosity: 0.8, sociability: 0.7, energy: 1.0, concern: 0.1 });
    mood.onInteraction();
    for (let h = 0; h <= 48; h += 2) {
      setTick(h * 60);
      const c = mood.getMood().concern;
      console.log(`  ${String(h).padStart(2)}h  concern=${c.toFixed(3)}`);
    }
    console.log("→ Concern should rise after 2h idle");
  });
})();
