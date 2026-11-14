import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMonth } from "../docs/history.js";

const row = (person, systolic, diastolic) => ({ trend: { person, systolic, diastolic } });

test("monthly summary uses each measurement for the selected person", () => {
  const result = summarizeMonth([
    row("father", 140, 90),
    row("father", 130, 80),
    row("father", 120, 70),
    row("mother", 180, 100),
    { trend: null },
    { trend: { systolic: 200, diastolic: 100 } },
  ], "father");
  assert.deepEqual(result, { kind: "normal", label: "正常", count: 3, systolic: 130, diastolic: 80 });
  assert.equal(summarizeMonth([row("father", 120, 75)], "mother"), null);
});

test("monthly thresholds use unrounded means and handle opposite directions", () => {
  const kind = (readings) => summarizeMonth(readings.map(([high, low]) => row("father", high, low)), "father").kind;
  assert.equal(kind([[135, 80]]), "high");
  assert.equal(kind([[120, 85]]), "high");
  assert.equal(kind([[89, 75]]), "low");
  assert.equal(kind([[120, 59]]), "low");
  assert.equal(kind([[90, 60]]), "normal");
  assert.equal(kind([[135, 59]]), "mixed");
  assert.equal(kind([[89, 85]]), "mixed");
  assert.equal(kind([[134, 84], [135, 84]]), "normal");
  assert.equal(kind([[134, 84], [136, 84]]), "high");
});
