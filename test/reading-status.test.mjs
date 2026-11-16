import assert from "node:assert/strict";
import test from "node:test";
import { classifyReading } from "../docs/history.js";

test("single reading labels show the component and direction at each threshold", () => {
  const labels = (systolic, diastolic) => classifyReading({ systolic, diastolic });
  assert.deepEqual(labels(121, 78), [{ kind: "normal", label: "正常" }]);
  assert.deepEqual(labels(135, 84), [{ kind: "high", label: "高压偏高" }]);
  assert.deepEqual(labels(134, 85), [{ kind: "high", label: "低压偏高" }]);
  assert.deepEqual(labels(137, 91), [{ kind: "high", label: "高低压偏高" }]);
  assert.deepEqual(labels(89, 70), [{ kind: "low", label: "高压偏低" }]);
  assert.deepEqual(labels(120, 59), [{ kind: "low", label: "低压偏低" }]);
  assert.deepEqual(labels(89, 59), [{ kind: "low", label: "高低压偏低" }]);
  assert.deepEqual(labels(135, 59), [{ kind: "high", label: "高压偏高" }, { kind: "low", label: "低压偏低" }]);
  assert.deepEqual(labels(90, 60), [{ kind: "normal", label: "正常" }]);
  assert.deepEqual(labels(undefined, 60), [{ kind: "unknown", label: "无法判断" }]);
});
