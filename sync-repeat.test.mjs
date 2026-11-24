import test from "node:test";
import assert from "node:assert/strict";
import { merge, spawnMissed, nextDate } from "./logic.js";

// A daily "take the bin out", synced on a phone and a laptop.
const base = () => ({ id: "bin", text: "Take the bin out", done: false, u: 1000, date: "2026-11-20", rep: { n: 1, unit: "day", mode: "schedule" } });
const side = (tasks, tomb = {}) => ({ tasks, tomb, ou: 0, lists: [] });

test("a stale device does not bring back occurrences another device already completed", () => {
  // Phone: ticked it off on the 20th, 21st, 22nd and 23rd. Each tick moves the date on.
  const phone = base();
  for (const [d, at] of [["2026-11-20", 2000], ["2026-11-21", 3000], ["2026-11-22", 4000], ["2026-11-23", 5000]]) { phone.date = nextDate(d, phone.rep, d); phone.u = at; }
  assert.equal(phone.date, "2026-11-24");
  // Laptop: last opened on the 19th, opened again on the 24th. It draws before it syncs, and spawns the "missed" days.
  const laptop = [base()];
  spawnMissed(laptop, {}, "2026-11-24");
  const merged = merge(side(laptop), side([phone]));
  assert.deepEqual(merged.tasks.map((t) => t.id), ["bin"], "no copies for days the phone completed");
  assert.equal(merged.tasks[0].date, "2026-11-24");
});

test("occurrences really missed still show up as their own tasks", () => {
  // Phone ticked it off on the 20th only, then nobody opened the app until the laptop on the 24th.
  const phone = { ...base(), date: "2026-11-21", u: 2000 };
  const laptop = [base()];
  spawnMissed(laptop, {}, "2026-11-24");
  const merged = merge(side(laptop), side([phone]));
  spawnMissed(merged.tasks, merged.tomb, "2026-11-24"); // the next draw, on the merged data
  assert.deepEqual(merged.tasks.map((t) => t.id).sort(), ["bin", "bin@2026-11-21", "bin@2026-11-22", "bin@2026-11-23"]);
});

test("a missed copy someone ticked off or edited survives the merge", () => {
  const phone = { ...base(), date: "2026-11-24", u: 5000 };
  const laptop = [base()];
  spawnMissed(laptop, {}, "2026-11-24");
  laptop.find((t) => t.id === "bin@2026-11-22").done = true; laptop.find((t) => t.id === "bin@2026-11-22").u = 6000;
  const merged = merge(side(laptop), side([phone]));
  assert.ok(merged.tasks.some((t) => t.id === "bin@2026-11-22" && t.done));
});

test("a repeating task deleted elsewhere does not come back as missed copies", () => {
  const laptop = [base()];
  spawnMissed(laptop, {}, "2026-11-24");
  const merged = merge(side(laptop), side([], { bin: 7000 }));
  assert.deepEqual(merged.tasks.map((t) => t.id), []);
});
